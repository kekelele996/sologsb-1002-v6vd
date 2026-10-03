import { create } from 'zustand'
import { seedComments, seedParagraphs, seedVersions } from '../data/seed'
import { mergeRemoteOps } from '../services/merge'
import { commitLocalOps, fetchRemoteChanges, resetServer, simulateRemoteWork, SyncError } from '../services/mockApi'
import type { Comment, HistorySnapshot, Paragraph, PendingMerge, Reply, Role, SyncLogEntry, SyncOp, Version } from '../types'

const DRAFT_KEY = 'sologsb-1002-draft-v1'
const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const roleAuthor = (role: Role) => role === 'author' ? '作者' : role === 'reviewer' ? '审稿人 A' : '编辑'

interface PersistedDraft {
  paragraphs: Paragraph[]
  comments: Comment[]
  versions: Version[]
  outbox: SyncOp[]
  pendingMerges: PendingMerge[]
  resolutions: Record<string, string>
  lastSeenRevision: number
  lastSyncAt: number | null
  syncLog: SyncLogEntry[]
}

const loadDraft = (): Partial<PersistedDraft> => {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(DRAFT_KEY) : null
    return raw ? JSON.parse(raw) as Partial<PersistedDraft> : {}
  } catch {
    return {}
  }
}

const persisted = loadDraft()
const initialParagraphs = persisted.paragraphs?.length ? persisted.paragraphs : seedParagraphs()
const initialComments = persisted.comments ?? seedComments()
const initialVersions = persisted.versions ?? seedVersions()

const persistDraft = (state: Pick<ReviewState, 'paragraphs' | 'comments' | 'versions' | 'outbox' | 'pendingMerges' | 'resolutions' | 'lastSeenRevision' | 'lastSyncAt' | 'syncLog'>) => {
  const draft: PersistedDraft = {
    paragraphs: state.paragraphs,
    comments: state.comments,
    versions: state.versions,
    outbox: state.outbox,
    pendingMerges: state.pendingMerges,
    resolutions: state.resolutions,
    lastSeenRevision: state.lastSeenRevision,
    lastSyncAt: state.lastSyncAt,
    syncLog: state.syncLog,
  }
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
}

interface ReviewState {
  role: Role
  paragraphs: Paragraph[]
  comments: Comment[]
  versions: Version[]
  selectedParagraphId: string
  commentFilter: 'all' | 'open' | 'suggestion' | 'duplicate'
  revisionMode: boolean
  dirty: boolean
  /** 本地未同步的改动（操作日志），opId 稳定，重试不重复入库 */
  outbox: SyncOp[]
  /** 两侧都改过且分不清先后的挂起段落，处理完才允许保存 */
  pendingMerges: PendingMerge[]
  /** 挂起处理结果：paragraphId -> 选定的正文 */
  resolutions: Record<string, string>
  lastSeenRevision: number
  serverRevision: number
  lastSyncAt: number | null
  syncing: boolean
  failArmed: boolean
  syncLog: SyncLogEntry[]
  past: HistorySnapshot[]
  future: HistorySnapshot[]
  setRole: (role: Role) => void
  selectParagraph: (id: string) => void
  setCommentFilter: (filter: ReviewState['commentFilter']) => void
  setRevisionMode: (value: boolean) => void
  updateParagraph: (id: string, text: string) => void
  addComment: (input: Pick<Comment, 'paragraphId' | 'type' | 'quote' | 'body' | 'suggestion'>) => void
  replyComment: (commentId: string, body: string) => void
  resolveSuggestion: (commentId: string, accepted: boolean) => void
  mergeComment: (commentId: string, targetId: string) => void
  toggleLock: (paragraphId: string) => void
  createVersion: (label: string) => void
  simulateRemote: () => Promise<void>
  reconcile: () => Promise<void>
  resolvePending: (pendingId: string, strategy: 'local' | 'remote') => void
  toggleFailArmed: () => void
  undo: () => void
  redo: () => void
  save: () => boolean
  resetDemo: () => void
}

export const useReviewStore = create<ReviewState>((set, get) => {
  const snapshotOf = (state: ReviewState): HistorySnapshot => ({
    paragraphs: clone(state.paragraphs),
    comments: clone(state.comments),
    versions: clone(state.versions),
    outbox: clone(state.outbox),
  })

  const appendLog = (entries: Pick<SyncLogEntry, 'tone' | 'text'>[]) => set((state) => ({
    syncLog: [
      ...entries.map((entry) => ({ ...entry, id: id('log'), ts: Date.now() })),
      ...state.syncLog,
    ].slice(0, 60),
  }))

  /** 所有本地编辑走这里：记录历史、把操作写入 outbox、持久化。对账进行中拒绝写入，避免合并结果覆盖并发编辑 */
  const record = (producer: (state: ReviewState) => Partial<ReviewState>, ops: SyncOp[] = []) => set((state) => {
    if (state.syncing) return state
    const history = snapshotOf(state)
    const next = producer(state)
    const merged = { ...state, ...next, outbox: [...state.outbox, ...ops] }
    persistDraft(merged)
    return { ...next, outbox: merged.outbox, past: [...state.past.slice(-49), history], future: [], dirty: true }
  })

  const makeOp = (state: ReviewState, op: Omit<SyncOp, 'id' | 'role' | 'authorName' | 'ts'>): SyncOp => ({
    ...op,
    id: id('op'),
    role: state.role,
    authorName: roleAuthor(state.role),
    ts: Date.now(),
  })

  return {
    role: 'reviewer',
    paragraphs: initialParagraphs,
    comments: initialComments,
    versions: initialVersions,
    selectedParagraphId: 'p-02',
    commentFilter: 'all',
    revisionMode: false,
    dirty: false,
    outbox: persisted.outbox ?? [],
    pendingMerges: persisted.pendingMerges ?? [],
    resolutions: persisted.resolutions ?? {},
    lastSeenRevision: persisted.lastSeenRevision ?? 0,
    serverRevision: persisted.lastSeenRevision ?? 0,
    lastSyncAt: persisted.lastSyncAt ?? null,
    syncing: false,
    failArmed: false,
    syncLog: persisted.syncLog ?? [],
    past: [],
    future: [],

    setRole: (role) => set({ role, selectedParagraphId: get().paragraphs[0]?.id ?? '' }),
    selectParagraph: (selectedParagraphId) => set({ selectedParagraphId }),
    setCommentFilter: (commentFilter) => set({ commentFilter }),
    setRevisionMode: (revisionMode) => set({ revisionMode }),

    updateParagraph: (paragraphId, text) => {
      const paragraph = get().paragraphs.find((item) => item.id === paragraphId)
      if (!paragraph || paragraph.status === 'locked' || paragraph.text === text) return
      record((state) => ({
        paragraphs: state.paragraphs.map((item) => item.id === paragraphId
          ? { ...item, text, status: 'open' as const, highlighted: true }
          : item),
      }), [makeOp(get(), { kind: 'setParagraphText', paragraphId, text })])
    },

    addComment: (input) => {
      const comment: Comment = {
        ...input,
        id: id('comment'),
        author: roleAuthor(get().role),
        role: get().role,
        status: 'open',
        replies: [],
        createdAt: Date.now(),
      }
      record((state) => ({ comments: [comment, ...state.comments] }), [makeOp(get(), { kind: 'addComment', paragraphId: comment.paragraphId, comment })])
    },

    replyComment: (commentId, body) => {
      const reply: Reply = { id: id('reply'), author: roleAuthor(get().role), role: get().role, body, createdAt: Date.now() }
      record((state) => ({
        comments: state.comments.map((comment) => comment.id === commentId
          ? { ...comment, replies: [...comment.replies, reply] }
          : comment),
      }), [makeOp(get(), { kind: 'replyComment', commentId, reply })])
    },

    resolveSuggestion: (commentId, accepted) => {
      const state = get()
      const comment = state.comments.find((item) => item.id === commentId)
      if (!comment) return
      const target = state.paragraphs.find((item) => item.id === comment.paragraphId)
      const applyText = Boolean(accepted && comment.suggestion && target && target.status !== 'locked')
      const ops: SyncOp[] = [makeOp(state, { kind: 'setCommentStatus', commentId, commentStatus: accepted ? 'accepted' : 'rejected' })]
      if (applyText && comment.suggestion) ops.push(makeOp(state, { kind: 'setParagraphText', paragraphId: comment.paragraphId, text: comment.suggestion }))
      record((current) => ({
        comments: current.comments.map((item) => item.id === commentId ? { ...item, status: accepted ? 'accepted' : 'rejected' } : item),
        paragraphs: applyText && comment.suggestion
          ? current.paragraphs.map((item) => item.id === comment.paragraphId ? { ...item, text: comment.suggestion as string, status: 'accepted' } : item)
          : current.paragraphs,
      }), ops)
    },

    mergeComment: (commentId, targetId) => record((state) => ({
      comments: state.comments.map((comment) => comment.id === commentId ? { ...comment, status: 'merged', mergedInto: targetId } : comment),
    }), [makeOp(get(), { kind: 'setCommentStatus', commentId, commentStatus: 'merged', mergedInto: targetId })]),

    toggleLock: (paragraphId) => {
      const paragraph = get().paragraphs.find((item) => item.id === paragraphId)
      if (!paragraph) return
      const nextStatus = paragraph.status === 'locked' ? 'accepted' : 'locked'
      record((state) => ({
        paragraphs: state.paragraphs.map((item) => item.id === paragraphId ? { ...item, status: nextStatus } : item),
      }), [makeOp(get(), { kind: 'setParagraphStatus', paragraphId, paragraphStatus: nextStatus, text: paragraph.text })])
    },

    createVersion: (label) => {
      const version: Version = {
        id: id('version'),
        label: label.trim() || `版本 ${get().versions.length + 1}`,
        createdAt: Date.now(),
        paragraphs: clone(get().paragraphs),
      }
      record((state) => ({ versions: [version, ...state.versions] }), [makeOp(get(), { kind: 'addVersion', version })])
    },

    simulateRemote: async () => {
      try {
        const { summary, revision } = await simulateRemoteWork()
        set({ serverRevision: revision })
        appendLog(summary.length
          ? summary.map((text) => ({ tone: 'info' as const, text: `远端改动：${text}` }))
          : [{ tone: 'info', text: '远端协作者这次没有产生新改动' }])
      } catch {
        appendLog([{ tone: 'error', text: '模拟远端改动失败，请重试' }])
      }
    },

    reconcile: async () => {
      const state = get()
      if (state.syncing) return
      // 回滚快照：接口失败时只回滚发起对账的这一侧（本地），远端已入库的保持不动
      const rollback = {
        paragraphs: clone(state.paragraphs),
        comments: clone(state.comments),
        versions: clone(state.versions),
        outbox: clone(state.outbox),
        pendingMerges: clone(state.pendingMerges),
        resolutions: clone(state.resolutions),
        lastSeenRevision: state.lastSeenRevision,
      }
      set({ syncing: true })
      try {
        const { ops: remoteOps, revision } = await fetchRemoteChanges(state.lastSeenRevision)
        const merged = mergeRemoteOps(
          { paragraphs: state.paragraphs, comments: state.comments, versions: state.versions },
          state.outbox,
          remoteOps,
          state.resolutions,
        )
        const pending = [
          ...merged.pending,
          ...state.pendingMerges.filter((item) => !merged.pending.some((next) => next.paragraphId === item.paragraphId)),
        ]
        if (merged.logs.length) appendLog(merged.logs.map((text) => ({ tone: 'info' as const, text })))

        if (pending.length > 0) {
          // 有挂起：先不推送，本地保留合并结果，处理完挂起才允许继续
          set((current) => {
            const next = {
              ...current,
              paragraphs: merged.paragraphs,
              comments: merged.comments,
              versions: merged.versions,
              pendingMerges: pending,
              lastSeenRevision: revision,
              serverRevision: revision,
              dirty: true,
            }
            persistDraft(next)
            return next
          })
          appendLog([{ tone: 'warning', text: `对账发现 ${pending.length} 处挂起冲突，处理完才允许保存和提交` }])
          return
        }

        const result = await commitLocalOps(state.outbox, { failOnce: state.failArmed })
        set((current) => {
          const next = {
            ...current,
            paragraphs: merged.paragraphs,
            comments: merged.comments,
            versions: merged.versions,
            outbox: [],
            pendingMerges: [],
            resolutions: {},
            lastSeenRevision: result.revision,
            serverRevision: result.revision,
            lastSyncAt: Date.now(),
            failArmed: false,
            dirty: true,
          }
          persistDraft(next)
          return next
        })
        appendLog([
          { tone: 'success', text: `对账完成：入库 ${result.applied} 条本地改动${result.skipped.length ? `，跳过 ${result.skipped.length} 条已入库操作（重试去重）` : ''}，远端修订 r${result.revision}` },
        ])
      } catch (error) {
        // 只回滚发起的一侧：本地恢复到对账前；模拟服务端已应用的部分照旧留着
        set((current) => {
          const next = { ...current, ...rollback, failArmed: false, dirty: true }
          persistDraft(next)
          return next
        })
        if (error instanceof SyncError) {
          appendLog([{ tone: 'error', text: `模拟接口失败：本地已回滚到对账前；远端已入库的 ${error.applied} 条操作照旧保留，重试会自动跳过、不重复入库` }])
        } else {
          appendLog([{ tone: 'error', text: '对账失败：本地已回滚到对账前状态，远端数据未受影响' }])
        }
      } finally {
        set({ syncing: false })
      }
    },

    resolvePending: (pendingId, strategy) => {
      const state = get()
      if (state.syncing) return
      const pending = state.pendingMerges.find((item) => item.id === pendingId)
      if (!pending) return
      const chosenText = strategy === 'local' ? pending.localText : pending.remoteText
      const correctiveOps: SyncOp[] = strategy === 'remote'
        ? [makeOp(state, { kind: 'setParagraphText', paragraphId: pending.paragraphId, text: pending.remoteText })]
        : []
      set((current) => {
        const next = {
          ...current,
          paragraphs: current.paragraphs.map((item) => item.id === pending.paragraphId ? { ...item, text: chosenText, highlighted: true } : item),
          pendingMerges: current.pendingMerges.filter((item) => item.id !== pendingId),
          resolutions: { ...current.resolutions, [pending.paragraphId]: chosenText },
          outbox: [...current.outbox, ...correctiveOps],
          dirty: true,
        }
        persistDraft(next)
        return next
      })
      appendLog([{ tone: 'info', text: `挂起已处理：段落 ${get().paragraphs.find((item) => item.id === pending.paragraphId)?.number ?? ''} ${strategy === 'local' ? '保留本地' : '采用远端'}` }])
      if (get().pendingMerges.length === 0) {
        appendLog([{ tone: 'info', text: '全部挂起已处理，自动重新对账提交合并结果' }])
        void get().reconcile()
      }
    },

    toggleFailArmed: () => {
      const next = !get().failArmed
      set({ failArmed: next })
      appendLog([{ tone: next ? 'warning' : 'info', text: next ? '已注入接口故障：下次提交将在中途失败' : '已解除接口故障注入' }])
    },

    undo: () => set((state) => {
      const previous = state.past.at(-1)
      if (!previous) return state
      const current = snapshotOf(state)
      const next = { ...state, ...clone(previous), past: state.past.slice(0, -1), future: [current, ...state.future], dirty: true }
      persistDraft(next)
      return next
    }),

    redo: () => set((state) => {
      const nextSnapshot = state.future[0]
      if (!nextSnapshot) return state
      const current = snapshotOf(state)
      const next = { ...state, ...clone(nextSnapshot), past: [...state.past, current], future: state.future.slice(1), dirty: true }
      persistDraft(next)
      return next
    }),

    save: () => {
      const state = get()
      if (state.pendingMerges.length > 0) {
        appendLog([{ tone: 'warning', text: `还有 ${state.pendingMerges.length} 处挂起冲突未处理，已阻止保存` }])
        return false
      }
      persistDraft(state)
      set({ dirty: false })
      return true
    },

    resetDemo: () => {
      localStorage.removeItem(DRAFT_KEY)
      resetServer()
      const next = {
        ...get(),
        paragraphs: seedParagraphs(),
        comments: seedComments(),
        versions: seedVersions(),
        outbox: [],
        pendingMerges: [],
        resolutions: {},
        lastSeenRevision: 0,
        serverRevision: 0,
        lastSyncAt: null,
        syncing: false,
        failArmed: false,
        syncLog: [],
        past: [],
        future: [],
        dirty: false,
      }
      persistDraft(next)
      set(next)
    },
  }
})
