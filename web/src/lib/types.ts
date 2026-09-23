export type ApprovalMode = "suggest" | "auto-edit" | "full-auto"

export interface ToolCardData {
  callId: string
  name: string
  args: Record<string, unknown>
  state: "running" | "ok" | "error"
  preview?: string
  truncated?: boolean
  fullLength?: number
  output?: string
}

export type TimelineItem =
  | { kind: "user"; id: string; text: string; rewindId?: string; ts?: number }
  | { kind: "assistant"; id: string; text: string; reasoning: string; done: boolean }
  | { kind: "tool"; id: string; tool: ToolCardData }
  | { kind: "plan"; id: string; plan: string }
  /** 一轮运行收尾：完成时间 + 该轮 token 消耗（实时流由 run_end 产出；历史重建从用量库按时间窗聚合） */
  | { kind: "runEnd"; id: string; ts: number; prompt: number; completion: number }
  | {
      kind: "notice"
      id: string
      level: "info" | "error" | "warn"
      text: string
      action?: { label: string; kind: "undo-rewind" }
    }

export interface DiffInfo {
  format: "unified"
  label: string
  text: string
  added: number
  removed: number
  tooLarge: boolean
  note?: string
  engine?: "git" | "fallback" | "none"
}

export interface PendingApproval {
  reqId: string
  project: string
  name: string
  args: Record<string, unknown>
  mode: ApprovalMode
  diff?: DiffInfo | null
}

export interface PendingQuestion {
  reqId: string
  project: string
  question: string
  options: string[]
}

export type PendingRequest =
  | ({ reqType: "approval" } & PendingApproval)
  | ({ reqType: "question" } & PendingQuestion)

export interface ProviderStatus {
  configured: boolean
  provider: string | null
  model: string | null
  baseURL: string | null
  providers: { name: string; model: string }[]
  activeProvider: string | null
}

/** 子代理进度条目（右侧「子代理」面板；服务端 subagents_update 广播 / snapshot.subagents 播种） */
export interface SubagentItem {
  key: string
  role: string
  id: number | string
  model: string | null
  status: "queued" | "running" | "done" | "stopped" | "error" | "ended"
  queueKind?: string | null
  position?: number | null
  startedAt: number | null
  turn: number
  maxTurns: number
  currentTool: string | null
  lastText: string
  files: string[]
  waitingApproval: boolean
  report?: string | null
  reportTruncated?: boolean
  /** 最后一次变更时刻（终态行的 elapsed 冻结用） */
  updatedAt?: number
}

export interface ProjectState {
  busy: boolean
  queued: number
  mode: ApprovalMode
  planMode?: boolean
  provider: ProviderStatus | null
}

export interface SessionSlotInfo {
  slot: number
  timestamp: number
  date: string
  msgs: number
  preview: string
}

export interface SessionListInfo {
  current: { updatedAt: number | null; msgs: number; preview: string }
  slots: SessionSlotInfo[]
}

export interface Snapshot {
  projects: string[]
  active: Record<string, ProjectState>
  /** 各项目子代理登记表（项目目录 → 条目列表） */
  subagents?: Record<string, SubagentItem[]>
  pendingApprovals: { reqId: string; project: string; name: string; args: Record<string, unknown>; diff?: DiffInfo | null }[]
  pendingQuestions: { reqId: string; project: string; question: string; options: string[] }[]
}

export interface ServerEvent {
  type: string
  project?: string
  ts: number
  [key: string]: unknown
}

export interface Preset {
  name: string
  desc: string
  baseURL: string
  model: string
}

// ---------- M3：用量 ----------

export interface UsageAggRow {
  calls: number
  prompt: number
  completion: number
  hit: number
  miss: number
}

export interface UsageByDay extends UsageAggRow {
  day: string
}

export interface UsageByModel extends UsageAggRow {
  provider: string
  model: string
}

export interface UsageStats {
  days: number
  totals: UsageAggRow
  byDay: UsageByDay[]
  byModel: UsageByModel[]
}

// ---------- M3：Git ----------

export interface GitFileEntry {
  path: string
  code?: string
}

export interface GitStatus {
  repo: boolean
  branch?: string
  ahead?: number
  behind?: number
  staged?: GitFileEntry[]
  unstaged?: GitFileEntry[]
  untracked?: string[]
}

export interface CommitInfo {
  hash: string
  short: string
  author: string
  date: string
  subject: string
}

export interface CheckpointInfo {
  id: string
  time: number
  untracked: number
}

// ---------- 会话回退（复制 / 回退） ----------

export interface RewindPoint {
  id: string
  msgId: string | null
  ts: number
  preview: string
  files: number
}

export interface RewindPoints {
  supported: boolean
  managed: boolean
  degraded: string | null
  points: RewindPoint[]
  canUndo: boolean
}

export interface RewindFile {
  path: string
  /** M=内容会被还原｜D=会被恢复｜A=会被删除 */
  status: "M" | "D" | "A"
}

export interface RewindPreview {
  files: RewindFile[]
  truncated: boolean
  degraded: string | null
}

export interface RewindSummary {
  /** 被移除的会话消息数（含本条） */
  messages: number
  /** 被还原 / 恢复的文件数 */
  files: number
  /** 被删除的新建文件数 */
  removed: number
  /** 因回退被打掉的待发队列条数 */
  cleared?: number
  sessionRestored?: boolean
  restoredRecords?: number
  /** 回退后从会话里恢复出来的任务列表与 Plan 状态 */
  tasks?: { title: string; status: string }[]
  planMode?: boolean
  degraded: string | null
}

// ---------- M3：供应商配置 ----------

export interface ProviderInfo {
  name: string
  baseURL: string
  model: string
  hasKey: boolean
  keyTail: string
}

export interface ProvidersConfig {
  providers: ProviderInfo[]
  activeProvider: string | null
  embedding: { configured: boolean; baseURL: string | null; model: string | null }
}

// ---------- M4：定时任务 ----------

export interface JobSchedule {
  kind: "every" | "daily" | "weekly"
  everyMs?: number
  time?: string
  weekday?: number
}

export interface JobInfo {
  id: string
  name: string
  project: string
  prompt: string
  schedule: JobSchedule
  scheduleText?: string
  maxTurns: number
  enabled: boolean
  createdAt: number
  lastRunAt: number | null
  lastStatus: string | null
  nextRunAt: number | null
}

export interface JobRun {
  id: number
  ts: number
  status: string
  durationMs: number
  error: string | null
  promptTokens: number
  completionTokens: number
  resultPreview: string
}

// ---------- MCP 服务器（安装 / 维护） ----------

/** GET 响应里请求头只给名称与尾 4 位（编辑留空 = 保留原值） */
export interface McpHeaderInfo {
  key: string
  tail: string
}

export interface McpServerInfo {
  name: string
  transport: "stdio" | "http"
  command: string
  args: string[]
  url: string
  headers: McpHeaderInfo[]
}

export interface McpPreset {
  id: string
  desc: string
  transport: "stdio" | "http"
  command?: string
  args?: string[]
  url?: string
  hint?: string
}

export interface McpTestResult {
  ok: boolean
  tools?: string[]
  error?: string
  elapsedMs: number
  commandFound: boolean
}

export interface McpServerStatus {
  connected: boolean
  tools: string[]
}

export interface McpStatus {
  materialized: boolean
  servers: Record<string, McpServerStatus>
  warnings: string[]
  dirty: boolean
}

/** GET /api/mcp 顶层附带：当前项目显式启用的 server 名单（前端勾选框用；空数组 = 全不启用） */
export interface McpConfigResponse {
  servers: McpServerInfo[]
  presets: McpPreset[]
  status: McpStatus
  enabled: string[]
}

export interface McpOpResult {
  project: string
  ok?: boolean
  deferred?: boolean
  tools?: string[]
  error?: string
}

export interface McpServerPayload {
  name: string
  transport: "stdio" | "http"
  command?: string
  args?: string[]
  url?: string
  headers?: { key: string; value: string }[]
}

export interface McpImportGroup {
  name: string
  /** env 已自动包装为 sh -c */
  wrapped?: boolean
  results: McpOpResult[]
}

export interface McpImportResult {
  ok: boolean
  installed: McpImportGroup[]
  skipped: { name: string; reason: string }[]
  failed: { name: string; error: string }[]
}

