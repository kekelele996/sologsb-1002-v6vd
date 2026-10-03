import type { DocumentSnapshot, PendingMerge, Role, SyncOp } from '../types'

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const roleLabel = (role: Role) => role === 'author' ? '作者' : role === 'reviewer' ? '审稿人' : '编辑'

export interface MergeResult extends DocumentSnapshot {
  pending: PendingMerge[]
  logs: string[]
}

/**
 * 对账合并：把远端操作逐条并入本地快照。
 * - 正文认作者：同一段落两侧都改正文时，作者角色的改动优先；
 * - 批注认审稿人：批注按 id 并集合并，状态分歧时审稿人一侧优先；
 * - 编辑锁定的段落两边都不能动：远端正文改动直接丢弃，本地未同步的正文改动回退到锁定文本；
 * - 同一段落两边都改过又分不清先后的，挂起为 PendingMerge，由人处理。
 */
export const mergeRemoteOps = (
  local: DocumentSnapshot,
  localOps: SyncOp[],
  remoteOps: SyncOp[],
  resolutions: Record<string, string>,
): MergeResult => {
  const paragraphs = clone(local.paragraphs)
  const comments = clone(local.comments)
  const versions = clone(local.versions)
  const pending: PendingMerge[] = []
  const logs: string[] = []

  const latestLocalOp = (kind: SyncOp['kind'], match: (op: SyncOp) => boolean) =>
    [...localOps].reverse().find((op) => op.kind === kind && match(op))
  const isLocked = (paragraphId: string) => paragraphs.find((item) => item.id === paragraphId)?.status === 'locked'

  for (const op of [...remoteOps].sort((a, b) => a.ts - b.ts)) {
    switch (op.kind) {
      case 'setParagraphText': {
        const paragraphId = op.paragraphId
        if (!paragraphId || op.text === undefined) break
        const paragraph = paragraphs.find((item) => item.id === paragraphId)
        if (!paragraph) break
        if (isLocked(paragraphId)) {
          logs.push(`段落 ${paragraph.number} 已被编辑锁定，远端（${op.authorName}）的正文改动未并入`)
          break
        }
        const resolved = resolutions[paragraphId]
        if (resolved !== undefined) {
          paragraph.text = resolved
          paragraph.highlighted = true
          break
        }
        const localOp = latestLocalOp('setParagraphText', (item) => item.paragraphId === paragraphId)
        if (!localOp) {
          if (paragraph.text !== op.text) {
            paragraph.text = op.text
            paragraph.highlighted = true
            logs.push(`并入远端正文改动：段落 ${paragraph.number}（${op.authorName}）`)
          }
          break
        }
        if (paragraph.text === op.text) break
        if (localOp.role === 'author' && op.role !== 'author') {
          logs.push(`段落 ${paragraph.number} 两侧都改过：正文认作者，保留本地（${localOp.authorName}）`)
          break
        }
        if (op.role === 'author' && localOp.role !== 'author') {
          paragraph.text = op.text
          paragraph.highlighted = true
          logs.push(`段落 ${paragraph.number} 两侧都改过：正文认作者，采用远端（${op.authorName}）`)
          break
        }
        pending.push({
          id: `pending-${paragraphId}`,
          paragraphId,
          localText: paragraph.text,
          remoteText: op.text,
          localRole: localOp.role,
          remoteRole: op.role,
          localAuthor: localOp.authorName,
          remoteAuthor: op.authorName,
          detectedAt: Date.now(),
        })
        logs.push(`段落 ${paragraph.number} 两侧都改过且分不清先后，已挂起待处理`)
        break
      }
      case 'addComment': {
        if (op.comment && !comments.some((item) => item.id === op.comment?.id)) {
          comments.unshift(clone(op.comment))
          logs.push(`并入远端批注：${op.comment.author} 在段落 ${paragraphs.find((item) => item.id === op.comment?.paragraphId)?.number ?? '?'} 的意见`)
        }
        break
      }
      case 'replyComment': {
        const target = comments.find((item) => item.id === op.commentId)
        if (target && op.reply && !target.replies.some((item) => item.id === op.reply?.id)) {
          target.replies.push(clone(op.reply))
          logs.push(`并入远端讨论回复（${op.reply.author}）`)
        }
        break
      }
      case 'setCommentStatus': {
        const target = comments.find((item) => item.id === op.commentId)
        if (!target || !op.commentStatus) break
        const localStatusOp = latestLocalOp('setCommentStatus', (item) => item.commentId === op.commentId)
        if (localStatusOp && (localStatusOp.commentStatus !== op.commentStatus || localStatusOp.mergedInto !== op.mergedInto)) {
          // 批注认审稿人：两侧都处理过同一条批注时，审稿人一侧优先；都不是审稿人则以远端为准
          if (localStatusOp.role === 'reviewer' && op.role !== 'reviewer') {
            logs.push(`批注「${target.quote.slice(0, 12)}…」状态以本地审稿人处理为准`)
            break
          }
          logs.push(`批注「${target.quote.slice(0, 12)}…」状态以${op.role === 'reviewer' ? '远端审稿人' : '远端'}处理为准`)
        }
        target.status = op.commentStatus
        if (op.mergedInto) target.mergedInto = op.mergedInto
        break
      }
      case 'setParagraphStatus': {
        const paragraph = paragraphs.find((item) => item.id === op.paragraphId)
        if (!paragraph || !op.paragraphStatus) break
        const localLockOp = latestLocalOp('setParagraphStatus', (item) => item.paragraphId === op.paragraphId)
        if (localLockOp && localLockOp.paragraphStatus !== op.paragraphStatus) {
          // 两侧对锁定状态意见不一致时保守处理：维持锁定
          paragraph.status = 'locked'
          logs.push(`段落 ${paragraph.number} 锁定状态两侧不一致，按锁定处理`)
        } else {
          paragraph.status = op.paragraphStatus
        }
        if (op.paragraphStatus === 'locked') {
          const localTextOp = latestLocalOp('setParagraphText', (item) => item.paragraphId === op.paragraphId)
          if (localTextOp && op.text !== undefined && paragraph.text !== op.text) {
            paragraph.text = op.text
            logs.push(`段落 ${paragraph.number} 被编辑锁定，本地未同步的正文改动已回退（锁定段落两边都不能动）`)
          } else {
            logs.push(`段落 ${paragraph.number} 已被编辑锁定，两侧都不可再改正文`)
          }
        }
        break
      }
      case 'addVersion': {
        if (op.version && !versions.some((item) => item.id === op.version?.id)) {
          versions.unshift(clone(op.version))
          logs.push(`并入远端保存的版本「${op.version.label}」`)
        }
        break
      }
    }
  }

  return { paragraphs, comments, versions, pending, logs }
}

export const describeRole = roleLabel
