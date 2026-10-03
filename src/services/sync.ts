import type { Comment, EditConflict, Paragraph, Reply, Role } from '../types'

export interface DocSnapshot {
  paragraphs: Paragraph[]
  comments: Comment[]
}

export interface ReconcileInput {
  base: DocSnapshot
  local: DocSnapshot
  remote: DocSnapshot
}

export interface ReconcileResult {
  paragraphs: Paragraph[]
  comments: Comment[]
  conflicts: EditConflict[]
  /** 合并后的新对账基线：挂起冲突的段落保留旧基线，待裁决后再推进 */
  nextBase: DocSnapshot
  /** 需要从服务端清除的、命中锁定段落的远端新批注 id */
  remoteCommentsToPurge: string[]
  report: string[]
}

export type SyncOp =
  | { id: string; kind: 'upsert-paragraph'; paragraph: Paragraph }
  | { id: string; kind: 'upsert-comment'; comment: Comment }
  | { id: string; kind: 'remove-comment'; commentId: string }

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

/** 内容指纹：同一改动重试时生成相同操作 id，服务端据此跳过重复入库 */
export const digest = (value: unknown): string => {
  const text = JSON.stringify(value)
  let hash = 0
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(36)
}

const paragraphFingerprint = (paragraph: Paragraph) => digest({
  id: paragraph.id,
  text: paragraph.text,
  status: paragraph.status,
  updatedAt: paragraph.updatedAt,
  updatedBy: paragraph.updatedBy,
  statusUpdatedAt: paragraph.statusUpdatedAt,
})

const commentFingerprint = (comment: Comment) => digest({
  id: comment.id,
  quote: comment.quote,
  body: comment.body,
  suggestion: comment.suggestion,
  status: comment.status,
  mergedInto: comment.mergedInto,
  replies: comment.replies,
  updatedAt: comment.updatedAt,
  updatedBy: comment.updatedBy,
})

export const paragraphOpId = (paragraph: Paragraph) => `para:${paragraph.id}:${paragraphFingerprint(paragraph)}`
export const commentOpId = (comment: Comment) => `comment:${comment.id}:${commentFingerprint(comment)}`

const roleLabel = (role: Role) => (role === 'author' ? '作者' : role === 'reviewer' ? '审稿人' : '编辑')
const paragraphNo = (paragraph?: Paragraph) => paragraph?.number.replace('.', '') ?? '?'

const unionReplies = (a: Reply[], b: Reply[]): Reply[] => {
  const seen = new Map<string, Reply>()
  for (const reply of [...a, ...b]) {
    if (!seen.has(reply.id)) seen.set(reply.id, reply)
  }
  return Array.from(seen.values()).sort((x, y) => x.createdAt - y.createdAt)
}

/**
 * 三路对账：
 * - 正文认作者：同段两侧都改过正文时，作者一侧胜出；两侧都是作者（或都不是）则无法确定先后，挂起。
 * - 批注认审稿人：同一条批注两侧都改过内容时，审稿人一侧胜出；回复按 id 求并集，谁都不丢。
 * - 编辑锁定的段落两边都不能动：正文冻结为锁定侧版本，锁定后新增批注一律拦截。
 */
export const reconcile = ({ base, local, remote }: ReconcileInput): ReconcileResult => {
  const report: string[] = []
  const conflicts: EditConflict[] = []
  const remoteCommentsToPurge: string[] = []
  const mergedParagraphs: Paragraph[] = []
  const nextBaseParagraphs: Paragraph[] = []

  const baseParagraphs = new Map(base.paragraphs.map((item) => [item.id, item]))
  const localParagraphs = new Map(local.paragraphs.map((item) => [item.id, item]))
  const remoteParagraphs = new Map(remote.paragraphs.map((item) => [item.id, item]))
  const paragraphIds = new Set([...baseParagraphs.keys(), ...localParagraphs.keys(), ...remoteParagraphs.keys()])

  let pushedTextCount = 0
  let pulledTextCount = 0
  let lockedCount = 0
  let discardedLockedEdits = 0

  for (const paragraphId of paragraphIds) {
    const b = baseParagraphs.get(paragraphId)
    const l = localParagraphs.get(paragraphId)
    const r = remoteParagraphs.get(paragraphId)
    const origin = b ?? l ?? r
    if (!origin) continue
    const baseParagraph = b ?? origin
    const localParagraph = l ?? clone(baseParagraph)
    const remoteParagraph = r ?? clone(baseParagraph)

    // 锁定状态认编辑：任一侧的锁定/解锁动作生效；两侧不一致时锁定优先（保护性）
    const localStatusChanged = localParagraph.status !== baseParagraph.status
    const remoteStatusChanged = remoteParagraph.status !== baseParagraph.status
    let status = baseParagraph.status
    let statusUpdatedAt = baseParagraph.statusUpdatedAt
    if (localStatusChanged && remoteStatusChanged && localParagraph.status !== remoteParagraph.status) {
      status = localParagraph.status === 'locked' || remoteParagraph.status === 'locked' ? 'locked' : localParagraph.status
      statusUpdatedAt = Math.max(localParagraph.statusUpdatedAt, remoteParagraph.statusUpdatedAt)
      report.push(`段落 ${paragraphNo(origin)} 两侧锁定动作不一致，按保护性原则取「锁定」`)
    } else if (remoteStatusChanged) {
      status = remoteParagraph.status
      statusUpdatedAt = remoteParagraph.statusUpdatedAt
    } else if (localStatusChanged) {
      status = localParagraph.status
      statusUpdatedAt = localParagraph.statusUpdatedAt
    }

    const localTextChanged = localParagraph.text !== baseParagraph.text
    const remoteTextChanged = remoteParagraph.text !== baseParagraph.text
    let text = baseParagraph.text
    let updatedAt = baseParagraph.updatedAt
    let updatedBy = baseParagraph.updatedBy
    let suspended = false

    if (status === 'locked') {
      // 锁定段落两边都不能动：正文冻结为锁定引入侧的版本，另一侧的改动丢弃
      const lockingSide = remoteStatusChanged && remoteParagraph.status === 'locked'
        ? remoteParagraph
        : localStatusChanged && localParagraph.status === 'locked'
          ? localParagraph
          : baseParagraph
      text = lockingSide.text
      updatedAt = lockingSide.updatedAt
      updatedBy = lockingSide.updatedBy
      lockedCount += 1
      if ((localTextChanged && localParagraph.text !== text) || (remoteTextChanged && remoteParagraph.text !== text)) {
        discardedLockedEdits += 1
        report.push(`段落 ${paragraphNo(origin)} 已被编辑锁定，两侧正文冻结，锁定期间的改动被丢弃`)
      }
    } else if (localTextChanged && remoteTextChanged && localParagraph.text !== remoteParagraph.text) {
      const localIsAuthor = localParagraph.updatedBy === 'author'
      const remoteIsAuthor = remoteParagraph.updatedBy === 'author'
      if (localIsAuthor !== remoteIsAuthor) {
        // 正文认作者
        const winner = localIsAuthor ? localParagraph : remoteParagraph
        text = winner.text
        updatedAt = winner.updatedAt
        updatedBy = winner.updatedBy
        report.push(`正文认作者：段落 ${paragraphNo(origin)} 采用${localIsAuthor ? '本地' : '远端'}作者版本，覆盖${localIsAuthor ? '远端' : '本地'}${roleLabel(localIsAuthor ? remoteParagraph.updatedBy : localParagraph.updatedBy)}的改动`)
        if (localIsAuthor) pushedTextCount += 1
        else pulledTextCount += 1
      } else {
        // 双方都改过且分不清先后：挂起，处理完才允许保存
        suspended = true
        text = localParagraph.text
        updatedAt = localParagraph.updatedAt
        updatedBy = localParagraph.updatedBy
        conflicts.push({
          id: `conflict-${paragraphId}-${digest([localParagraph.text, remoteParagraph.text])}`,
          paragraphId,
          localText: localParagraph.text,
          remoteText: remoteParagraph.text,
          localAuthor: `本地 · ${roleLabel(localParagraph.updatedBy)}`,
          remoteAuthor: `远端 · ${roleLabel(remoteParagraph.updatedBy)}`,
          reason: '两侧都修改了正文，且无法确定先后顺序',
          detectedAt: Date.now(),
        })
      }
    } else if (remoteTextChanged) {
      text = remoteParagraph.text
      updatedAt = remoteParagraph.updatedAt
      updatedBy = remoteParagraph.updatedBy
      pulledTextCount += 1
      report.push(`采用远端正文：段落 ${paragraphNo(origin)}（${roleLabel(remoteParagraph.updatedBy)}）`)
    } else if (localTextChanged) {
      text = localParagraph.text
      updatedAt = localParagraph.updatedAt
      updatedBy = localParagraph.updatedBy
      pushedTextCount += 1
    }

    mergedParagraphs.push({
      ...localParagraph,
      text,
      status,
      updatedAt,
      updatedBy,
      statusUpdatedAt,
      highlighted: localParagraph.highlighted || text !== baseParagraph.text,
    })
    // 挂起的段落不推进基线，裁决前服务端保持远端版本
    nextBaseParagraphs.push(suspended ? clone(baseParagraph) : clone({ ...localParagraph, text, status, updatedAt, updatedBy, statusUpdatedAt }))
  }

  // 批注合并：认审稿人，回复求并集
  const lockedParagraphIds = new Set(mergedParagraphs.filter((item) => item.status === 'locked').map((item) => item.id))
  const baseComments = new Map(base.comments.map((item) => [item.id, item]))
  const localComments = new Map(local.comments.map((item) => [item.id, item]))
  const remoteComments = new Map(remote.comments.map((item) => [item.id, item]))
  const commentIds = new Set([...baseComments.keys(), ...localComments.keys(), ...remoteComments.keys()])
  const mergedComments: Comment[] = []
  let pulledCommentCount = 0
  let pushedCommentCount = 0
  let blockedCommentCount = 0

  for (const commentId of commentIds) {
    const b = baseComments.get(commentId)
    const l = localComments.get(commentId)
    const r = remoteComments.get(commentId)
    const source = b ?? l ?? r
    if (!source) continue

    if (!b) {
      // 新增批注：并集合入；但锁定段落两边都不能动，新批注一律拦截
      const incoming = (l ? [l] : []).concat(r ? [r] : [])
      for (const comment of incoming) {
        if (lockedParagraphIds.has(comment.paragraphId)) {
          blockedCommentCount += 1
          if (r && r.id === comment.id) remoteCommentsToPurge.push(comment.id)
          report.push(`拦截批注：段落 ${paragraphNo(mergedParagraphs.find((item) => item.id === comment.paragraphId))} 已被编辑锁定，${comment.author} 的新批注不予入库`)
          continue
        }
        mergedComments.push(clone(comment))
        if (l && comment.id === l.id) pushedCommentCount += 1
        else pulledCommentCount += 1
      }
      continue
    }

    const localComment = l ?? clone(b)
    const remoteComment = r ?? clone(b)
    const localChanged = commentFingerprint(localComment) !== commentFingerprint(b)
    const remoteChanged = commentFingerprint(remoteComment) !== commentFingerprint(b)

    if (!localChanged && !remoteChanged) {
      mergedComments.push(clone(b))
      continue
    }
    if (localChanged && !remoteChanged) {
      mergedComments.push(clone(localComment))
      pushedCommentCount += 1
      continue
    }
    if (remoteChanged && !localChanged) {
      mergedComments.push(clone(remoteComment))
      pulledCommentCount += 1
      continue
    }

    // 两侧都改过：回复求并集，正文内容认审稿人
    const replies = unionReplies(localComment.replies, remoteComment.replies)
    const localIsReviewer = localComment.updatedBy === 'reviewer'
    const remoteIsReviewer = remoteComment.updatedBy === 'reviewer'
    let winner = remoteComment
    if (localIsReviewer !== remoteIsReviewer) {
      winner = localIsReviewer ? localComment : remoteComment
      report.push(`批注认审稿人：「${source.body.slice(0, 18)}…」采用${localIsReviewer ? '本地' : '远端'}审稿人版本`)
    } else if (localComment.updatedAt !== remoteComment.updatedAt) {
      winner = localComment.updatedAt > remoteComment.updatedAt ? localComment : remoteComment
    }
    mergedComments.push({ ...clone(winner), replies })
    if (winner === localComment) pushedCommentCount += 1
    else pulledCommentCount += 1
  }

  mergedComments.sort((x, y) => x.createdAt - y.createdAt)
  if (pushedTextCount > 0) report.unshift(`本地正文改动已推送 ${pushedTextCount} 段`)
  if (pulledTextCount > 0) report.unshift(`远端正文改动已合入 ${pulledTextCount} 段`)
  if (pushedCommentCount > 0) report.push(`本地批注已推送 ${pushedCommentCount} 条`)
  if (pulledCommentCount > 0) report.push(`远端批注已合入 ${pulledCommentCount} 条（批注认审稿人，双方意见均保留）`)
  if (lockedCount > 0) report.push(`编辑锁定生效 ${lockedCount} 段，两侧均不可修改`)
  if (discardedLockedEdits > 0) report.push(`丢弃锁定期间的正文改动 ${discardedLockedEdits} 处`)
  if (blockedCommentCount > 0) report.push(`拦截锁定段落的新批注 ${blockedCommentCount} 条`)
  if (conflicts.length > 0) report.push(`挂起冲突 ${conflicts.length} 个：同一段落两侧都改过且分不清先后，处理完才允许保存`)
  if (report.length === 0) report.push('两侧没有新的改动，无需合并')

  return {
    paragraphs: mergedParagraphs,
    comments: mergedComments,
    conflicts,
    nextBase: { paragraphs: nextBaseParagraphs, comments: clone(mergedComments) },
    remoteCommentsToPurge,
    report,
  }
}

/** 由「服务端现状 → 本地合并结果」的差集生成幂等操作；挂起冲突的段落不推送 */
export const buildOps = (remote: DocSnapshot, merged: DocSnapshot, suspendedParagraphIds: Set<string>, purgeCommentIds: string[]): SyncOp[] => {
  const ops: SyncOp[] = []
  const remoteParagraphs = new Map(remote.paragraphs.map((item) => [item.id, item]))
  const remoteComments = new Map(remote.comments.map((item) => [item.id, item]))

  for (const paragraph of merged.paragraphs) {
    if (suspendedParagraphIds.has(paragraph.id)) continue
    const remoteParagraph = remoteParagraphs.get(paragraph.id)
    if (!remoteParagraph || paragraphFingerprint(remoteParagraph) !== paragraphFingerprint(paragraph)) {
      ops.push({ id: paragraphOpId(paragraph), kind: 'upsert-paragraph', paragraph: clone(paragraph) })
    }
  }
  for (const comment of merged.comments) {
    const remoteComment = remoteComments.get(comment.id)
    if (!remoteComment || commentFingerprint(remoteComment) !== commentFingerprint(comment)) {
      ops.push({ id: commentOpId(comment), kind: 'upsert-comment', comment: clone(comment) })
    }
  }
  for (const commentId of purgeCommentIds) {
    ops.push({ id: `remove-comment:${commentId}`, kind: 'remove-comment', commentId })
  }
  return ops
}
