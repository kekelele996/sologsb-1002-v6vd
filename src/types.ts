export type Role = 'author' | 'reviewer' | 'editor'
export type ParagraphStatus = 'open' | 'accepted' | 'locked'
export type CommentStatus = 'open' | 'accepted' | 'rejected' | 'merged'
export type CommentType = 'comment' | 'suggestion'

export interface Reply {
  id: string
  author: string
  role: Role
  body: string
  createdAt: number
}

export interface Comment {
  id: string
  paragraphId: string
  author: string
  role: Role
  type: CommentType
  quote: string
  body: string
  suggestion?: string
  status: CommentStatus
  replies: Reply[]
  createdAt: number
  mergedInto?: string
}

export interface Paragraph {
  id: string
  section: string
  number: string
  text: string
  original: string
  status: ParagraphStatus
  highlighted: boolean
}

export interface Version {
  id: string
  label: string
  createdAt: number
  paragraphs: Paragraph[]
}

/** 同一段落两侧都改过且分不清先后时挂起的冲突，处理完才允许保存 */
export interface PendingMerge {
  id: string
  paragraphId: string
  localText: string
  remoteText: string
  localRole: Role
  remoteRole: Role
  localAuthor: string
  remoteAuthor: string
  detectedAt: number
}

export type SyncOpKind =
  | 'setParagraphText'
  | 'addComment'
  | 'replyComment'
  | 'setCommentStatus'
  | 'setParagraphStatus'
  | 'addVersion'

/** 一次带角色归属的改动。opId 在重试间保持稳定，模拟接口按它去重，保证重试不重复入库 */
export interface SyncOp {
  id: string
  role: Role
  authorName: string
  kind: SyncOpKind
  paragraphId?: string
  commentId?: string
  text?: string
  commentStatus?: CommentStatus
  mergedInto?: string
  paragraphStatus?: ParagraphStatus
  comment?: Comment
  reply?: Reply
  version?: Version
  ts: number
}

export interface SyncLogEntry {
  id: string
  ts: number
  tone: 'info' | 'success' | 'warning' | 'error'
  text: string
}

export interface DocumentSnapshot {
  paragraphs: Paragraph[]
  comments: Comment[]
  versions: Version[]
}

export interface HistorySnapshot extends DocumentSnapshot {
  outbox: SyncOp[]
}
