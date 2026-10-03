import type { Comment, Paragraph } from '../types'
import type { DocSnapshot, SyncOp } from './sync'

const SERVER_KEY = 'sologsb-1002-server-v1'
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export interface ServerDoc extends DocSnapshot {
  revision: number
  /** 已入库的操作 id（幂等日志）：重试时跳过，保证不重复入库 */
  appliedOps: string[]
}

export class MockApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MockApiError'
  }
}

const persistServer = (doc: ServerDoc) => {
  localStorage.setItem(SERVER_KEY, JSON.stringify(doc))
}

export const loadServerDoc = (): ServerDoc => {
  const raw = localStorage.getItem(SERVER_KEY)
  if (!raw) throw new MockApiError('模拟服务端尚未初始化')
  return JSON.parse(raw) as ServerDoc
}

export const initServerDoc = (paragraphs: Paragraph[], comments: Comment[]) => {
  if (localStorage.getItem(SERVER_KEY)) return
  persistServer({ revision: 1, paragraphs: clone(paragraphs), comments: clone(comments), appliedOps: [] })
}

export const resetServerDoc = (paragraphs: Paragraph[], comments: Comment[]) => {
  persistServer({ revision: 1, paragraphs: clone(paragraphs), comments: clone(comments), appliedOps: [] })
}

let pushFailureArmed = false
/** 注入一次性故障：下一次推送会在应用了部分操作后中途断开 */
export const armNextPushFailure = () => {
  pushFailureArmed = true
}

export const fetchServerDoc = async (): Promise<ServerDoc> => {
  await wait(420)
  return clone(loadServerDoc())
}

export interface PushResult {
  revision: number
  applied: number
  skipped: number
}

/**
 * 推送本地操作到模拟服务端。
 * - 每个操作带幂等 id，已入库的跳过（重试不重复入库）；
 * - 注入故障时先应用前一半操作再抛错：服务端保留已应用部分，由发起方自行回滚。
 */
export const applyOps = async (ops: SyncOp[]): Promise<PushResult> => {
  await wait(560)
  const doc = loadServerDoc()
  if (ops.length === 0) return { revision: doc.revision, applied: 0, skipped: 0 }

  const failAfter = pushFailureArmed ? Math.floor(ops.length / 2) : Number.POSITIVE_INFINITY
  pushFailureArmed = false
  let applied = 0
  let skipped = 0

  for (const [index, op] of ops.entries()) {
    if (index >= failAfter) {
      persistServer(doc)
      throw new MockApiError(`模拟接口故障：推送在 ${applied} 条操作后中断，服务端已保留这部分改动`)
    }
    if (doc.appliedOps.includes(op.id)) {
      skipped += 1
      continue
    }
    if (op.kind === 'upsert-paragraph') {
      const existing = doc.paragraphs.find((item) => item.id === op.paragraph.id)
      if (existing?.status === 'locked' && op.paragraph.status !== 'locked' && existing.text !== op.paragraph.text) {
        // 服务端兜底：编辑锁定的段落拒绝正文改动
        doc.appliedOps.push(op.id)
        skipped += 1
        continue
      }
      doc.paragraphs = existing
        ? doc.paragraphs.map((item) => (item.id === op.paragraph.id ? clone(op.paragraph) : item))
        : [...doc.paragraphs, clone(op.paragraph)]
    } else if (op.kind === 'upsert-comment') {
      const existing = doc.comments.find((item) => item.id === op.comment.id)
      doc.comments = existing
        ? doc.comments.map((item) => (item.id === op.comment.id ? clone(op.comment) : item))
        : [...doc.comments, clone(op.comment)]
    } else {
      doc.comments = doc.comments.filter((item) => item.id !== op.commentId)
    }
    doc.appliedOps.push(op.id)
    applied += 1
  }

  doc.revision += 1
  doc.appliedOps = doc.appliedOps.slice(-500)
  persistServer(doc)
  return { revision: doc.revision, applied, skipped }
}

/**
 * 模拟其他协作者的离线改动在网络恢复后先入服务端（幂等：重复点击不会重复入库）。
 * 覆盖三类角色：作者改正文、审稿人加/改批注、编辑锁定段落。
 */
export const simulateRemoteEdits = async (): Promise<string[]> => {
  await wait(480)
  const doc = loadServerDoc()
  const now = Date.now()
  const lines: string[] = []
  const paragraph = (id: string) => doc.paragraphs.find((item) => item.id === id)

  const p02 = paragraph('p-02')
  if (p02 && !p02.text.includes('王教授补充')) {
    p02.text = `${p02.text.replace(/。$/, '')}，王教授补充：已在鲁棒性一节回应该质疑。`
    p02.updatedAt = now
    p02.updatedBy = 'author'
    lines.push('作者 · 王教授：修改了段落 2 的正文')
  }
  const p07 = paragraph('p-07')
  if (p07 && !p07.text.includes('可验证性')) {
    p07.text = `${p07.text.replace(/。$/, '')}，并强调建议的可验证性应优先于生成速度。`
    p07.updatedAt = now
    p07.updatedBy = 'author'
    lines.push('作者 · 王教授：修改了段落 7 的正文')
  }
  const p03 = paragraph('p-03')
  if (p03 && !p03.text.includes('编辑校订')) {
    p03.text = `${p03.text}（编辑校订：统一量词用法）`
    p03.updatedAt = now
    p03.updatedBy = 'editor'
    lines.push('编辑：校订了段落 3 的正文')
  }
  if (!doc.comments.some((item) => item.id === 'remote-c-01')) {
    doc.comments.push({
      id: 'remote-c-01',
      paragraphId: 'p-04',
      author: '审稿人 B',
      role: 'reviewer',
      type: 'comment',
      quote: '响应、评审与合并三个阶段',
      body: '离线批注：建议补充各阶段的平均耗时基线，便于复现。',
      status: 'open',
      replies: [],
      createdAt: now,
      updatedAt: now,
      updatedBy: 'reviewer',
    })
    lines.push('审稿人 B：在段落 4 新增了离线批注')
  }
  const c02 = doc.comments.find((item) => item.id === 'c-02')
  if (c02 && !c02.body.includes('2024 年后')) {
    c02.body = `${c02.body}（补充：范围限定为 2024 年后的议题。）`
    c02.updatedAt = now
    c02.updatedBy = 'reviewer'
    lines.push('审稿人 B：改写了段落 2 既有批注的表述')
  }
  const p05 = paragraph('p-05')
  if (p05 && p05.status !== 'locked') {
    p05.status = 'locked'
    p05.statusUpdatedAt = now
    lines.push('编辑：锁定了段落 5（两侧均不可再改）')
  }
  if (!doc.comments.some((item) => item.id === 'remote-c-02')) {
    doc.comments.push({
      id: 'remote-c-02',
      paragraphId: 'p-05',
      author: '审稿人 D',
      role: 'reviewer',
      type: 'comment',
      quote: '邀请第三位研究者裁决',
      body: '离线批注：锁定前未看到编辑确认，补充一句说明。',
      status: 'open',
      replies: [],
      createdAt: now,
      updatedAt: now,
      updatedBy: 'reviewer',
    })
    lines.push('审稿人 D：试图在已锁定的段落 5 上添加批注（对账时将被拦截）')
  }

  if (lines.length > 0) {
    doc.revision += 1
    persistServer(doc)
  }
  return lines
}
