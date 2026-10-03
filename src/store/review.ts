import { create } from 'zustand'
import type { Comment, EditConflict, Paragraph, Reply, Role, Version } from '../types'
import { applyOps, fetchServerDoc, initServerDoc, resetServerDoc } from '../services/mockApi'
import { buildOps, paragraphOpId, reconcile, type DocSnapshot } from '../services/sync'

const DRAFT_KEY = 'sologsb-1002-draft-v2'
const SYNC_BASE_KEY = 'sologsb-1002-syncbase-v1'
const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
const now = Date.now()

const baseParagraphs: Paragraph[] = [
  { id: 'p-01', section: '摘要', number: '1.', text: '开源软件供应链的稳定性不仅取决于代码质量，也取决于维护者能否持续识别并回应社区需求。', original: '开源软件供应链的稳定性不仅取决于代码质量，也取决于维护者能否持续识别并回应社区需求。', status: 'accepted', highlighted: false, updatedAt: now - 604800000, updatedBy: 'author', statusUpdatedAt: now - 604800000 },
  { id: 'p-02', section: '1 引言', number: '2.', text: '近年来，大型语言模型被广泛用于代码生成与缺陷定位，但其在真实维护工作流中的影响仍缺少系统证据。', original: '近年来，大型语言模型被广泛用于代码生成与缺陷定位，但其在真实维护工作流中的影响仍缺少系统证据。', status: 'open', highlighted: true, updatedAt: now - 604800000, updatedBy: 'author', statusUpdatedAt: now - 604800000 },
  { id: 'p-03', section: '1 引言', number: '3.', text: '本文收集 12 个活跃开源项目连续 18 个月的议题记录，并访谈 26 位核心维护者。', original: '本文收集 12 个活跃开源项目连续 18 个月的议题记录，并访谈 26 位核心维护者。', status: 'open', highlighted: true, updatedAt: now - 604800000, updatedBy: 'author', statusUpdatedAt: now - 604800000 },
  { id: 'p-04', section: '2 方法', number: '4.', text: '我们采用混合研究方法，将议题生命周期划分为响应、评审与合并三个阶段。编码过程由两名研究者独立完成。', original: '我们采用混合研究方法，将议题生命周期划分为响应、评审与合并三个阶段。编码过程由两名研究者独立完成。', status: 'open', highlighted: false, updatedAt: now - 604800000, updatedBy: 'author', statusUpdatedAt: now - 604800000 },
  { id: 'p-05', section: '2 方法', number: '5.', text: '当编码结果不一致时，研究者通过讨论达成一致；若仍有分歧，则邀请第三位研究者裁决。', original: '当编码结果不一致时，研究者通过讨论达成一致；若仍有分歧，则邀请第三位研究者裁决。', status: 'accepted', highlighted: true, updatedAt: now - 604800000, updatedBy: 'author', statusUpdatedAt: now - 604800000 },
  { id: 'p-06', section: '3 结果', number: '6.', text: '初步结果显示，辅助工具缩短了首次响应时间，但没有显著降低维护者处理复杂议题的认知负担。', original: '初步结果显示，辅助工具缩短了首次响应时间，但没有显著降低维护者处理复杂议题的认知负担。', status: 'open', highlighted: true, updatedAt: now - 604800000, updatedBy: 'author', statusUpdatedAt: now - 604800000 },
  { id: 'p-07', section: '3 结果', number: '7.', text: '在高活跃度项目中，维护者更关注建议是否可验证，而非建议生成速度。', original: '在高活跃度项目中，维护者更关注建议是否可验证，而非建议生成速度。', status: 'open', highlighted: false, updatedAt: now - 604800000, updatedBy: 'author', statusUpdatedAt: now - 604800000 },
]
const baseComments: Comment[] = [
  { id: 'c-01', paragraphId: 'p-02', author: '审稿人 A', role: 'reviewer', type: 'suggestion', quote: '其真实维护工作流中的影响', body: '建议把“影响”具体化为可观察指标。', suggestion: '近年来，大型语言模型被广泛用于代码生成与缺陷定位，但在真实维护工作流中究竟改变了哪些协作行为，仍缺少系统证据。', status: 'open', replies: [{ id: 'r-01', author: '作者', role: 'author', body: '可以，修改后会补充指标定义。', createdAt: now - 7200000 }], createdAt: now - 86400000, updatedAt: now - 7200000, updatedBy: 'reviewer' },
  { id: 'c-02', paragraphId: 'p-02', author: '审稿人 B', role: 'reviewer', type: 'comment', quote: '缺少系统证据', body: '这里的“系统证据”范围过大，建议限定为本研究覆盖的议题语料。', status: 'open', replies: [], createdAt: now - 64000000, updatedAt: now - 64000000, updatedBy: 'reviewer' },
  { id: 'c-03', paragraphId: 'p-03', author: '审稿人 A', role: 'reviewer', type: 'comment', quote: '26 位核心维护者', body: '请说明抽样方式和地域分布，避免样本选择偏差。', status: 'open', replies: [], createdAt: now - 54000000, updatedAt: now - 54000000, updatedBy: 'reviewer' },
  { id: 'c-04', paragraphId: 'p-04', author: '审稿人 C', role: 'reviewer', type: 'comment', quote: '两名研究者独立完成', body: '建议报告编码者间一致性系数，并明确不一致处理规则。', status: 'open', replies: [], createdAt: now - 48000000, updatedAt: now - 48000000, updatedBy: 'reviewer' },
  { id: 'c-05', paragraphId: 'p-05', author: '审稿人 D', role: 'reviewer', type: 'comment', quote: '邀请第三位研究者裁决', body: '与上一段重复：都在说明编码分歧如何解决，建议合并意见。', status: 'open', replies: [], createdAt: now - 43000000, updatedAt: now - 43000000, updatedBy: 'reviewer' },
  { id: 'c-06', paragraphId: 'p-06', author: '审稿人 B', role: 'reviewer', type: 'suggestion', quote: '但没有显著降低维护者处理复杂议题的认知负担', body: '“显著”需要给出统计检验与效应量。', suggestion: '初步结果显示，辅助工具缩短了首次响应时间，但对复杂议题处理时长与自我报告认知负担均未产生统计显著影响。', status: 'open', replies: [], createdAt: now - 36000000, updatedAt: now - 36000000, updatedBy: 'reviewer' },
]

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const seed = typeof localStorage !== 'undefined' ? localStorage.getItem(DRAFT_KEY) : null
const parsed = seed ? JSON.parse(seed) as Partial<{ paragraphs: Paragraph[]; comments: Comment[]; versions: Version[] }> : null
const initialParagraphs = parsed?.paragraphs?.length ? parsed.paragraphs : baseParagraphs
const initialComments = parsed?.comments ?? baseComments
const initialVersions: Version[] = parsed?.versions ?? [
  { id: 'v-01', label: '投稿初稿 v1', createdAt: now - 1209600000, paragraphs: clone(baseParagraphs) },
  { id: 'v-02', label: '审阅基线 v2', createdAt: now - 172800000, paragraphs: clone(baseParagraphs.map((p) => p.id === 'p-04' ? { ...p, text: `${p.text} 编码规则在预注册方案中说明。` } : p)) },
]

// 模拟服务端与本地草稿各自持有一份改动；首次运行时以同一份基线初始化
initServerDoc(baseParagraphs, baseComments)

const persistDraft = (paragraphs: Paragraph[], comments: Comment[], versions: Version[]) => {
  localStorage.setItem(DRAFT_KEY, JSON.stringify({ paragraphs, comments, versions }))
}
const persistSyncBase = (snapshot: DocSnapshot) => {
  localStorage.setItem(SYNC_BASE_KEY, JSON.stringify(snapshot))
}
// 对账基线（共同祖先）必须在任何远端改动入库前固定，否则首拉会把远端改动误判成基线
if (!localStorage.getItem(SYNC_BASE_KEY)) {
  persistSyncBase({ paragraphs: clone(baseParagraphs), comments: clone(baseComments) })
}
const loadSyncBase = (): DocSnapshot => {
  const raw = localStorage.getItem(SYNC_BASE_KEY)
  if (raw) return JSON.parse(raw) as DocSnapshot
  return { paragraphs: clone(baseParagraphs), comments: clone(baseComments) }
}

export interface SyncReport {
  ok: boolean
  at: number
  lines: string[]
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
  conflicts: EditConflict[]
  syncing: boolean
  syncReport: SyncReport | null
  lastSyncedAt: number | null
  past: { paragraphs: Paragraph[]; comments: Comment[]; versions: Version[] }[]
  future: { paragraphs: Paragraph[]; comments: Comment[]; versions: Version[] }[]
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
  syncNow: () => Promise<void>
  dismissSyncReport: () => void
  resolveConflict: (conflictId: string, strategy: 'local' | 'remote') => Promise<boolean>
  undo: () => void
  redo: () => void
  save: () => boolean
  resetDemo: () => void
}

export const useReviewStore = create<ReviewState>((set, get) => {
  const record = (producer: (state: ReviewState) => Partial<ReviewState>) => set((state) => {
    if (state.syncing) return state
    const history = { paragraphs: clone(state.paragraphs), comments: clone(state.comments), versions: clone(state.versions) }
    const next = producer(state)
    const paragraphs = next.paragraphs ?? state.paragraphs
    const comments = next.comments ?? state.comments
    const versions = next.versions ?? state.versions
    persistDraft(paragraphs, comments, versions)
    return { ...next, past: [...state.past.slice(-49), history], future: [], dirty: true }
  })
  const actorName = (role: Role) => (role === 'reviewer' ? '审稿人 A' : role === 'author' ? '作者' : '编辑')

  return {
    role: 'reviewer',
    paragraphs: initialParagraphs,
    comments: initialComments,
    versions: initialVersions,
    selectedParagraphId: 'p-02',
    commentFilter: 'all',
    revisionMode: false,
    dirty: false,
    conflicts: [],
    syncing: false,
    syncReport: null,
    lastSyncedAt: null,
    past: [],
    future: [],
    setRole: (role) => set({ role, selectedParagraphId: get().paragraphs[0]?.id ?? '' }),
    selectParagraph: (selectedParagraphId) => set({ selectedParagraphId }),
    setCommentFilter: (commentFilter) => set({ commentFilter }),
    setRevisionMode: (revisionMode) => set({ revisionMode }),
    updateParagraph: (paragraphId, text) => {
      const target = get().paragraphs.find((item) => item.id === paragraphId)
      if (!target || target.status === 'locked') return
      record((state) => ({
        paragraphs: state.paragraphs.map((paragraph) => paragraph.id === paragraphId
          ? { ...paragraph, text, status: 'open' as const, highlighted: true, updatedAt: Date.now(), updatedBy: state.role }
          : paragraph),
      }))
    },
    addComment: (input) => {
      const target = get().paragraphs.find((item) => item.id === input.paragraphId)
      if (!target || target.status === 'locked') return
      record((state) => ({
        comments: [{
          ...input,
          id: id('comment'),
          author: actorName(state.role),
          role: state.role,
          status: 'open',
          replies: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          updatedBy: state.role,
        }, ...state.comments],
      }))
    },
    replyComment: (commentId, body) => {
      const comment = get().comments.find((item) => item.id === commentId)
      const target = comment && get().paragraphs.find((item) => item.id === comment.paragraphId)
      if (!target || target.status === 'locked') return
      record((state) => ({
        comments: state.comments.map((item) => item.id === commentId ? {
          ...item,
          replies: [...item.replies, { id: id('reply'), author: actorName(state.role), role: state.role, body, createdAt: Date.now() } as Reply],
          updatedAt: Date.now(),
          updatedBy: state.role,
        } : item),
      }))
    },
    resolveSuggestion: (commentId, accepted) => {
      const comment = get().comments.find((item) => item.id === commentId)
      const target = comment && get().paragraphs.find((item) => item.id === comment.paragraphId)
      if (!target || target.status === 'locked') return
      record((state) => ({
        comments: state.comments.map((item) => item.id === commentId
          ? { ...item, status: accepted ? 'accepted' : 'rejected', updatedAt: Date.now(), updatedBy: state.role }
          : item),
        paragraphs: comment?.suggestion && accepted
          ? state.paragraphs.map((paragraph) => paragraph.id === comment.paragraphId
            ? { ...paragraph, text: comment.suggestion as string, status: 'accepted', updatedAt: Date.now(), updatedBy: state.role, statusUpdatedAt: Date.now() }
            : paragraph)
          : state.paragraphs,
      }))
    },
    mergeComment: (commentId, targetId) => record((state) => ({
      comments: state.comments.map((comment) => comment.id === commentId
        ? { ...comment, status: 'merged', mergedInto: targetId, updatedAt: Date.now(), updatedBy: state.role }
        : comment),
    })),
    toggleLock: (paragraphId) => {
      if (get().role !== 'editor') return
      record((state) => ({
        paragraphs: state.paragraphs.map((paragraph) => paragraph.id === paragraphId ? {
          ...paragraph,
          status: paragraph.status === 'locked' ? 'accepted' : 'locked',
          statusUpdatedAt: Date.now(),
        } : paragraph),
      }))
    },
    createVersion: (label) => record((state) => ({
      versions: [{ id: id('version'), label: label.trim() || `版本 ${state.versions.length + 1}`, createdAt: Date.now(), paragraphs: clone(state.paragraphs) }, ...state.versions],
    })),
    syncNow: async () => {
      if (get().syncing) return
      set({ syncing: true })
      // 发起方（本地）快照：失败时只回滚这一侧
      const snapshot = {
        paragraphs: clone(get().paragraphs),
        comments: clone(get().comments),
        conflicts: clone(get().conflicts),
      }
      try {
        const remote = await fetchServerDoc()
        const result = reconcile({ base: loadSyncBase(), local: snapshot, remote })
        const suspendedIds = new Set(result.conflicts.map((item) => item.paragraphId))
        const ops = buildOps(remote, { paragraphs: result.paragraphs, comments: result.comments }, suspendedIds, result.remoteCommentsToPurge)
        const push = await applyOps(ops)
        persistSyncBase(result.nextBase)
        persistDraft(result.paragraphs, result.comments, get().versions)
        set({
          paragraphs: result.paragraphs,
          comments: result.comments,
          conflicts: result.conflicts,
          dirty: result.conflicts.length > 0,
          lastSyncedAt: Date.now(),
          syncReport: {
            ok: true,
            at: Date.now(),
            lines: [...result.report, `服务端应用 ${push.applied} 条操作，跳过重复 ${push.skipped} 条（重试不重复入库）`],
          },
        })
      } catch (error) {
        // 只回滚发起的一侧；服务端已入库的部分保留，重试凭幂等 id 跳过
        persistDraft(snapshot.paragraphs, snapshot.comments, get().versions)
        set({
          paragraphs: snapshot.paragraphs,
          comments: snapshot.comments,
          conflicts: snapshot.conflicts,
          dirty: true,
          syncReport: {
            ok: false,
            at: Date.now(),
            lines: [
              `同步失败：${error instanceof Error ? error.message : '未知错误'}`,
              '已回滚本地（发起方）到对账前状态，本地离线改动未丢失',
              '远端已入库的部分保留；重试时相同操作会被跳过，不会重复入库',
            ],
          },
        })
      } finally {
        set({ syncing: false })
      }
    },
    dismissSyncReport: () => set({ syncReport: null }),
    resolveConflict: async (conflictId, strategy) => {
      const state = get()
      const conflict = state.conflicts.find((item) => item.id === conflictId)
      const paragraph = state.paragraphs.find((item) => item.id === conflict?.paragraphId)
      if (!conflict || !paragraph) return false
      const resolved: Paragraph = {
        ...paragraph,
        text: strategy === 'remote' ? conflict.remoteText : conflict.localText,
        updatedAt: Date.now(),
        updatedBy: 'author',
        highlighted: true,
      }
      const previous = { paragraphs: clone(state.paragraphs), conflicts: clone(state.conflicts) }
      const nextParagraphs = state.paragraphs.map((item) => (item.id === resolved.id ? resolved : item))
      const nextConflicts = state.conflicts.filter((item) => item.id !== conflictId)
      set({ paragraphs: nextParagraphs, conflicts: nextConflicts, dirty: true })
      try {
        // 裁决结果立即单条入库（幂等 id：重试不重复），并推进该段落的对账基线
        await applyOps([{ id: paragraphOpId(resolved), kind: 'upsert-paragraph', paragraph: resolved }])
        const base = loadSyncBase()
        persistSyncBase({
          paragraphs: base.paragraphs.map((item) => (item.id === resolved.id ? clone(resolved) : item)),
          comments: base.comments,
        })
        persistDraft(nextParagraphs, get().comments, get().versions)
        return true
      } catch {
        // 只回滚本地裁决，冲突保持挂起；远端状态不变
        set({ paragraphs: previous.paragraphs, conflicts: previous.conflicts, dirty: true })
        persistDraft(previous.paragraphs, get().comments, get().versions)
        return false
      }
    },
    undo: () => set((state) => {
      const previous = state.past.at(-1)
      if (!previous) return state
      const current = { paragraphs: clone(state.paragraphs), comments: clone(state.comments), versions: clone(state.versions) }
      persistDraft(previous.paragraphs, previous.comments, previous.versions)
      return { ...previous, past: state.past.slice(0, -1), future: [current, ...state.future], dirty: true }
    }),
    redo: () => set((state) => {
      const next = state.future[0]
      if (!next) return state
      const current = { paragraphs: clone(state.paragraphs), comments: clone(state.comments), versions: clone(state.versions) }
      persistDraft(next.paragraphs, next.comments, next.versions)
      return { ...next, past: [...state.past, current], future: state.future.slice(1), dirty: true }
    }),
    save: () => {
      if (get().conflicts.length > 0) return false
      persistDraft(get().paragraphs, get().comments, get().versions)
      set({ dirty: false })
      return true
    },
    resetDemo: () => {
      localStorage.removeItem(DRAFT_KEY)
      localStorage.removeItem(SYNC_BASE_KEY)
      resetServerDoc(baseParagraphs, baseComments)
      persistSyncBase({ paragraphs: clone(baseParagraphs), comments: clone(baseComments) })
      set({
        paragraphs: clone(baseParagraphs),
        comments: clone(baseComments),
        versions: clone(initialVersions),
        conflicts: [],
        syncing: false,
        syncReport: null,
        lastSyncedAt: null,
        past: [],
        future: [],
        dirty: false,
      })
      persistDraft(baseParagraphs, baseComments, initialVersions)
    },
  }
})
