import { seedComments, seedParagraphs, seedVersions } from '../data/seed'
import type { Comment, DocumentSnapshot, Paragraph, Reply, Role, SyncOp, Version } from '../types'

const SERVER_KEY = 'sologsb-1002-server-v1'
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

interface JournalEntry extends SyncOp {
  rev: number
  origin: 'local' | 'remote'
}

/** 模拟服务端自己持有的一份数据：文稿快照 + 已入库操作流水 + 已应用的 opId（用于重试去重） */
interface ServerState extends DocumentSnapshot {
  journal: JournalEntry[]
  appliedOpIds: string[]
  revision: number
}

export class SyncError extends Error {
  applied: number
  skipped: string[]
  constructor(message: string, applied: number, skipped: string[]) {
    super(message)
    this.name = 'SyncError'
    this.applied = applied
    this.skipped = skipped
  }
}

const seedServer = (): ServerState => ({
  paragraphs: seedParagraphs(),
  comments: seedComments(),
  versions: seedVersions(),
  journal: [],
  appliedOpIds: [],
  revision: 0,
})

const loadServer = (): ServerState => {
  try {
    const raw = localStorage.getItem(SERVER_KEY)
    if (raw) return JSON.parse(raw) as ServerState
  } catch {
    // 损坏的服务端缓存按重新初始化处理
  }
  const fresh = seedServer()
  localStorage.setItem(SERVER_KEY, JSON.stringify(fresh))
  return fresh
}

const saveServer = (state: ServerState) => {
  localStorage.setItem(SERVER_KEY, JSON.stringify(state))
}

/** 服务端应用单条操作：锁定段落拒绝正文改动，批注/回复/版本按 id 去重 */
const applyOp = (server: ServerState, op: SyncOp) => {
  switch (op.kind) {
    case 'setParagraphText': {
      const paragraph = server.paragraphs.find((item) => item.id === op.paragraphId)
      if (paragraph && paragraph.status !== 'locked' && op.text !== undefined) paragraph.text = op.text
      break
    }
    case 'addComment': {
      if (op.comment && !server.comments.some((item) => item.id === op.comment?.id)) {
        server.comments.unshift(clone(op.comment))
      }
      break
    }
    case 'replyComment': {
      const target = server.comments.find((item) => item.id === op.commentId)
      if (target && op.reply && !target.replies.some((item) => item.id === op.reply?.id)) {
        target.replies.push(clone(op.reply))
      }
      break
    }
    case 'setCommentStatus': {
      const target = server.comments.find((item) => item.id === op.commentId)
      if (target && op.commentStatus) {
        target.status = op.commentStatus
        if (op.mergedInto) target.mergedInto = op.mergedInto
      }
      break
    }
    case 'setParagraphStatus': {
      const paragraph = server.paragraphs.find((item) => item.id === op.paragraphId)
      if (paragraph && op.paragraphStatus) {
        // 已被锁定的段落不接受另一侧随锁定操作携带的正文，保持锁定时的文本
        if (paragraph.status !== 'locked' && op.paragraphStatus === 'locked' && op.text !== undefined) {
          paragraph.text = op.text
        }
        paragraph.status = op.paragraphStatus
      }
      break
    }
    case 'addVersion': {
      if (op.version && !server.versions.some((item) => item.id === op.version?.id)) {
        server.versions.unshift(clone(op.version))
      }
      break
    }
  }
}

export interface RemoteChangeSet {
  ops: SyncOp[]
  revision: number
}

/** 拉取自 sinceRevision 之后远端协作者产生的改动 */
export const fetchRemoteChanges = async (sinceRevision: number): Promise<RemoteChangeSet> => {
  await wait(320)
  const server = loadServer()
  return {
    ops: clone(server.journal.filter((entry) => entry.rev > sinceRevision && entry.origin === 'remote')),
    revision: server.revision,
  }
}

export interface CommitResult {
  applied: number
  skipped: string[]
  revision: number
}

/**
 * 提交本地操作。已入库的 opId 直接跳过（重试不重复入库）；
 * failOnce 时模拟接口在随机位置中断——已应用的部分留在服务端，调用方只回滚自己那一侧。
 */
export const commitLocalOps = async (ops: SyncOp[], options: { failOnce?: boolean } = {}): Promise<CommitResult> => {
  await wait(480)
  const server = loadServer()
  const skipped: string[] = []
  let applied = 0
  const crashAfter = !options.failOnce || ops.length === 0
    ? Number.POSITIVE_INFINITY
    : ops.length === 1 ? 0 : 1 + Math.floor(Math.random() * (ops.length - 1))
  for (const [index, op] of ops.entries()) {
    if (index >= crashAfter) {
      saveServer(server)
      throw new SyncError(`模拟接口在写入第 ${index + 1} 条操作时中断`, applied, skipped)
    }
    if (server.appliedOpIds.includes(op.id)) {
      skipped.push(op.id)
      continue
    }
    applyOp(server, op)
    server.appliedOpIds.push(op.id)
    server.revision += 1
    server.journal.push({ ...clone(op), origin: 'local', rev: server.revision })
    applied += 1
  }
  saveServer(server)
  return { applied, skipped, revision: server.revision }
}

const remoteActors: Record<Role, string> = {
  author: '共同作者 · 王远',
  reviewer: '审稿人 B',
  editor: '编辑 · 周老师',
}

const remoteTextTweaks = [
  (text: string) => `${text.replace(/。$/, '')}，这一表述仍需数据支撑。`,
  (text: string) => text.includes('显著') ? text.replace('显著', '在统计意义上显著') : `${text.replace(/。$/, '')}（远端修订）。`,
  (text: string) => `${text.replace(/。$/, '')}。共同作者补充：需与第 4 节的口径保持一致。`,
]

/** 模拟远端协作者离线改稿：改动直接落在服务端那份数据上，并进入服务端流水 */
export const simulateRemoteWork = async (): Promise<{ ops: SyncOp[]; summary: string[]; revision: number }> => {
  await wait(360)
  const server = loadServer()
  const summary: string[] = []
  const ops: SyncOp[] = []
  const candidates = server.paragraphs.filter((paragraph) => paragraph.status !== 'locked')
  const pick = <T,>(list: T[]): T | undefined => list[Math.floor(Math.random() * list.length)]
  const pushOp = (op: SyncOp) => {
    applyOp(server, op)
    server.appliedOpIds.push(op.id)
    server.revision += 1
    server.journal.push({ ...clone(op), origin: 'remote', rev: server.revision })
    ops.push(clone(op))
  }

  const moves = 1 + Math.floor(Math.random() * 3)
  for (let i = 0; i < moves; i += 1) {
    const dice = Math.random()
    if (dice < 0.4 && candidates.length) {
      const paragraph = pick(candidates) as Paragraph
      const role: Role = Math.random() < 0.5 ? 'author' : 'reviewer'
      const text = pick(remoteTextTweaks)?.(paragraph.text) ?? paragraph.text
      pushOp({ id: id('op'), role, authorName: remoteActors[role], kind: 'setParagraphText', paragraphId: paragraph.id, text, ts: Date.now() })
      summary.push(`${remoteActors[role]} 修改了段落 ${paragraph.number} 的正文`)
    } else if (dice < 0.75 && candidates.length) {
      const paragraph = pick(candidates) as Paragraph
      const comment: Comment = {
        id: id('comment'),
        paragraphId: paragraph.id,
        author: remoteActors.reviewer,
        role: 'reviewer',
        type: 'comment',
        quote: paragraph.text.slice(0, 18),
        body: '远端审阅意见：这一段建议补充近两年的对照研究，并说明结论的外推边界。',
        status: 'open',
        replies: [],
        createdAt: Date.now(),
      }
      pushOp({ id: id('op'), role: 'reviewer', authorName: remoteActors.reviewer, kind: 'addComment', paragraphId: paragraph.id, comment, ts: Date.now() })
      summary.push(`${remoteActors.reviewer} 在段落 ${paragraph.number} 添加了批注`)
    } else {
      const lockable = server.paragraphs.filter((paragraph) => paragraph.status !== 'locked')
      const paragraph = pick(lockable.length && Math.random() < 0.7 ? lockable : server.paragraphs)
      if (!paragraph) continue
      const nextStatus = paragraph.status === 'locked' ? 'accepted' : 'locked'
      pushOp({
        id: id('op'), role: 'editor', authorName: remoteActors.editor, kind: 'setParagraphStatus',
        paragraphId: paragraph.id, paragraphStatus: nextStatus, text: paragraph.text, ts: Date.now(),
      })
      summary.push(nextStatus === 'locked' ? `${remoteActors.editor} 锁定了段落 ${paragraph.number}` : `${remoteActors.editor} 解锁了段落 ${paragraph.number}`)
    }
  }

  const openComment = server.comments.find((comment) => comment.status === 'open')
  if (openComment && Math.random() < 0.5) {
    const reply: Reply = { id: id('reply'), author: remoteActors.reviewer, role: 'reviewer', body: '远端回复：同意这条意见，请作者一并处理。', createdAt: Date.now() }
    pushOp({ id: id('op'), role: 'reviewer', authorName: remoteActors.reviewer, kind: 'replyComment', commentId: openComment.id, reply, ts: Date.now() })
    summary.push(`${remoteActors.reviewer} 回复了「${openComment.quote.slice(0, 12)}…」的讨论`)
  }

  saveServer(server)
  return { ops, summary, revision: server.revision }
}

export interface ServerOverview extends DocumentSnapshot {
  revision: number
  journalSize: number
  journal: JournalEntry[]
}

/** 同步读取服务端概览，用于状态面板展示 */
export const getServerOverview = (): ServerOverview => {
  const server = loadServer()
  return {
    paragraphs: clone(server.paragraphs),
    comments: clone(server.comments),
    versions: clone(server.versions),
    revision: server.revision,
    journalSize: server.journal.length,
    journal: clone(server.journal.slice(-30).reverse()),
  }
}

export const resetServer = () => {
  localStorage.removeItem(SERVER_KEY)
  loadServer()
}
