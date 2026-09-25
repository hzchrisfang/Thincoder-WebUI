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
  /** 子代理完成报告（内核注入 history 的报告提醒）——摘要可折叠，展开为正文原文（不截断）。
   *  ref = `role#id`；时间线是报告的持久载体（面板行的报告区只是活视图的一份副本）。 */
  | { kind: "report"; id: string; ref: string; status: "done" | "error"; text: string }
  /** 一轮运行收尾：完成时间 + 该轮 token 消耗（实时流由 run_end 产出；历史重建从用量库按时间窗聚合）；digest=true 是自动消化轮 */
  | { kind: "runEnd"; id: string; ts: number; prompt: number; completion: number; digest?: boolean }
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

/** 思考程度（/api/thinking）——档位枚举随模型走（服务端 specForModel 派生），前端不硬编码 */
export interface ThinkingInfo {
  supported: boolean
  autoThink: boolean
  provider: string | null
  model: string | null
  /** off=显式关 / on=开但未落档 / 具体档位名；supported=false 或未配置模型时为 null */
  state: string | null
  levels: string[]
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
  /** 报告已收尾、等内核消化轮读进会话（D4 的「待消化」标记；不被误降级成 ended） */
  pending?: boolean
  /** 最后一次变更时刻（终态行的 elapsed 冻结用） */
  updatedAt?: number
}

/** 子代理进度统计（会话口径）：服务端 subagents_update.stats 与 snapshot.subagentStats 同源 */
export interface SubagentStats {
  /** 本会话派发总数——**单调计数**，不随终态行自裁（登记表 TERMINAL_LIMIT=20）封顶 */
  dispatched: number
  /** 已结束行数（done/stopped/error/ended：该行不再活跃，与面板 TERMINAL 集合同口径） */
  finished: number
  /** 其中以 error 收尾的行数 */
  failed: number
}

export interface ProjectState {
  busy: boolean
  queued: number
  mode: ApprovalMode
  planMode?: boolean
  provider: ProviderStatus | null
  /** 挂起会话中（后台池仍 live：会话仍忙、不含用户回合）；挂起期 busy 必为 true */
  suspended?: boolean
  /** 后台池计数（服务端仍随挂起事件/快照下发）；服务端无计数时发 null */
  counts?: SuspensionCounts | null
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
  /** 各项目子代理进度统计（与 subagents 平级；会话边界随登记表一起归零） */
  subagentStats?: Record<string, SubagentStats>
  pendingApprovals: { reqId: string; project: string; name: string; args: Record<string, unknown>; diff?: DiffInfo | null }[]
  pendingQuestions: { reqId: string; project: string; question: string; options: string[] }[]
}

export interface ServerEvent {
  type: string
  project?: string
  ts: number
  [key: string]: unknown
}

/** 子代理进度广播：当前项目全量 items + 进度统计（缺 stats 时面板/按钮不显示数字） */
export interface SubagentsUpdateEvent extends ServerEvent {
  type: "subagents_update"
  items?: SubagentItem[]
  stats?: SubagentStats
}

/** 子代理报告 → 时间线的实时投递（字段与 buildHistory 的 report 条目同形；正文整段不截断） */
export interface SubagentReportEvent extends ServerEvent {
  type: "subagent_report"
  ref?: string
  status?: "done" | "error"
  text?: string
}

/** 后台池计数（挂起驱动的状态面）：运行中 / 排队 / 待消化 / 已完成 */
export interface SuspensionCounts {
  running: number
  queued: number
  pending: number
  done: number
}

/** 挂起会话状态事件：进入 / 计数变化 / 退出各下发一次 */
export interface SuspensionEvent extends ServerEvent {
  type: "suspension"
  active: boolean
  counts: SuspensionCounts | null
}

/** 回合起止事件；digest=true 标示自动消化轮（后台报告收尾后内核自开的一轮，非用户发起）；
 *  suspending=true 标示「本回合收尾后即将进入挂起会话」（前端据此跳过追问建议旁路） */
export interface RunEvent extends ServerEvent {
  type: "run_start" | "run_end"
  digest?: boolean
  suspending?: boolean
  queued?: number
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
  /** 当前主线模型名（defaultModel 复合值的模型段；无效/缺失 → null） */
  activeModel: string | null
  embedding: { configured: boolean; baseURL: string | null; model: string | null }
}

/** 子代理模型配置（三类各自独立；null = 跟随主线）。explore/coder 写内核
 *  agent.subagentModels，advisor 写 agent.advisor.provider/model。 */
export interface SubagentModelsConfig {
  explore: string | null
  coder: string | null
  advisor: string | null
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

/** GET /api/mcp 顶层附带：当前项目显式启用的 server 名单（前端勾选框用；空数组 = 全不启用；无记录项目 = 全不启用） */
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

