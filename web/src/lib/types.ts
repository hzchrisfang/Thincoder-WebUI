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
  /** 多模型会诊裁定（内核注入 history 的裁定提醒）——摘要可折叠，展开为逐模型小节原文（不截断）。
   *  ref = `consult#<id>`；status 由内核给的计数派生（无失败 / 部分失败 / 全失败）；
   *  sections 为 null = 正文里没有可辨认的逐模型小节（如裁定被 offload 成预览）⇒ 整段展示。 */
  | {
      kind: "consult"
      id: string
      ref: string
      status: "done" | "partial" | "error"
      counts: string
      replied: number | null
      total: number | null
      failed: number | null
      text: string
      sections: { model: string; failed: boolean; text: string }[] | null
    }
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
  /** 该项目当时是否处于极速模式（与 mode 同口径：快照播种的条目带上；事件建的条目不携该值） */
  fast?: boolean
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
  /** 极速模式（单轮）：武装中或本轮正在跑（服务端 snapshot().fast 同口径，恒存在） */
  fast: boolean
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

/** 多模型会诊裁定 → 时间线的实时投递（字段与 buildHistory 的 consult 条目**同源**：服务端
 *  subagents.consultPayload 一处拼出，两条路径共用一份渲染）。正文整段不截断。 */
export interface ConsultReportEvent extends ServerEvent {
  type: "consult_report"
  ref?: string
  status?: "done" | "partial" | "error"
  counts?: string
  replied?: number | null
  total?: number | null
  failed?: number | null
  text?: string
  sections?: { model: string; failed: boolean; text: string }[] | null
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

/** 极速模式（单轮）武装态事件（`/fast` 切换、轮末解除各下发一次）：
 *  armed=true 已武装（下一条消息以极速轮跑）/ false 已解除；前端只认它，不做任何猜测性复位。 */
export interface FastEvent extends ServerEvent {
  type: "fast"
  project: string
  armed: boolean
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

export interface UsageByProject extends UsageAggRow {
  /** 项目目录绝对路径（落库原值）——界面显示末段短名，全路径由悬停提示给出 */
  project: string
}

export interface UsageByModel extends UsageAggRow {
  provider: string
  model: string
}

export interface UsageStats {
  days: number
  totals: UsageAggRow
  byDay: UsageByDay[]
  byProject: UsageByProject[]
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

/** 一条会诊模型（内核 `agent.consultModels` 的条目）。`efforts` = 该模型 spec 声明的思考档位
 *  枚举（经服务端 specForModel 派生）——空数组 = 该模型不接受 effort，前端不渲染档位下拉。 */
export interface ConsultModelEntry {
  provider: string
  model: string
  effort: string | null
  efforts: string[]
}

/** 多模型会诊模型清单（内核 `agent.consultModels`）：1-5 条（内核只拒**空池**与 **>5**——1 条也能起单顾问会诊），空 = 未配置（会诊不可用）。
 *  `max` = 条数上限（服务端与内核同值，前端据此禁增）。 */
export interface ConsultModelsConfig {
  models: ConsultModelEntry[]
  max: number
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

// ---- 技能（内核 skill 系统） ----
// 形状与 server/bridge/skills.mjs 的返回值逐字对齐：description/effective 全部来自内核 loadSkills
// （与注入 system prompt 的那份同源），前端不再自算任何一条。

/** 技能层级：项目层 <project>/.thincoder/skills/ · 用户层 ~/.thincoder/skills/ */
export type SkillLayer = "project" | "user"

/** 技能的两种物理落点：flat = <name>.md · dir = <name>/SKILL.md（内核同源） */
export type SkillFormat = "flat" | "dir"

/** 遮蔽者 = 内核合并结果里的同名赢家（未生效的行由此知道「谁遮了我」）
 *  文案判据由这份数据决定，不由本行层级猜——否则会说「子目录行被同名子目录技能遮蔽」这类自指错话 */
export interface SkillShadowedBy {
  layer: SkillLayer
  path: string
  format: SkillFormat
}

export interface SkillEntry {
  name: string
  description: string
  /** 作者自述（frontmatter `description:`）；没写 = null。**列表显示以它优先**（用户裁定 2026-09-27） */
  declaredDescription: string | null
  path: string
  format: SkillFormat // flat = name.md；dir = name/SKILL.md
  size: number
  mtime: number
  /** 内核合并结果里是否采用了这一条（未被采用 ⇒ 内核看不见它，agent 也拿不到） */
  effective: boolean
  /** 未被采用且别处已有同名条目（用户层被项目层遮蔽 / 同层扁平被同名子目录短路）；= shadowedBy !== null */
  shadowed: boolean
  /** 遮住这一条的同名赢家；未被遮蔽 = null */
  shadowedBy: SkillShadowedBy | null
}

/** 内核不认的条目（名字不过白名单 / 子目录缺 SKILL.md / 非 .md）——内核静默忽略，这里如实报出来 */
export interface SkillIgnored {
  entry: string
  kind: "dir" | "file"
  reason: string
}

export interface SkillLayerState {
  layer: SkillLayer
  /** 层目录绝对路径；未打开项目时项目层为 null */
  dir: string | null
  exists: boolean
  skills: SkillEntry[]
  ignored: SkillIgnored[]
}

export interface SkillsResponse {
  /** 固定顺序：project → user */
  layers: SkillLayerState[]
  /** 内核 loadSkills 的合并结果（= agent 实际能看到的清单） */
  effective: SkillEntry[]
  /** 例如未打开项目时「仅显示用户级技能」 */
  note: string | null
}

/** 写操作响应 = 最新全景 + 本次操作的回执字段 */
export interface SkillOpResponse extends SkillsResponse {
  ok: true
  path?: string
  format?: SkillFormat
  warnings?: string[]
  /** 删除时目录被保留（还有资源文件）的说明 */
  removed?: string
}

// ---- 技能导入（两段式：plan 只读、apply 才写；形状与 server/bridge/skills-import.mjs 逐字对齐） ----

/** 导入源类型：本地目录 / Git 仓库 */
export type SkillImportKind = "dir" | "git"

/** 一个候选技能：描述/格式全部来自内核 loadSkills（前端不再自算），files/size 来自实际复制量算 */
export interface SkillImportCandidate {
  name: string
  format: SkillFormat
  description: string
  /** 作者自述（`SKILL.md` 的 frontmatter `description:`）；没写 = null。**面板显示以它优先**（用户裁定 2026-09-27） */
  declaredDescription: string | null
  /** 将写入的总字节数（flat = 正文长度；dir 含资源文件） */
  size: number
  /** 将写入的文件数（flat 恒 1；dir 含资源文件） */
  files: number
  /** 正文前 20 行且截 2048 个 UTF-16 码元（纯 ASCII 约为 2KB；中文一字一码元，字节能多好几倍） */
  preview: string
  /** 目标层里的占用情况；无冲突 = null。kind: file = <name>.md 被占；name = <name>/SKILL.md 被占；dir = 裸目录被占 */
  conflict: { kind: "name" | "file" | "dir"; path: string } | null
}

export interface SkillImportPlan {
  id: string
  source: { kind: SkillImportKind; label: string; ref?: string; commit?: string }
  candidates: SkillImportCandidate[]
  /** 源里内核不认、已忽略的条目（如实上报，绝不静默丢） */
  note?: string | null
}

/** 单条导入结果：action = 本次对该项采用的**冲突处置**（无冲突时也是 skip）；status 才是真实结果 */
export interface SkillImportItemResult {
  name: string | null
  action: "skip" | "overwrite"
  status: "written" | "skipped" | "failed"
  error?: string
  /** 写成功但有话要说（如：跨格式覆盖时新写入的那条会被同名子目录遮蔽、不会生效） */
  note?: string
}

/** apply 响应 = 逐项结果 + 最新全景（页面显示 = 服务端 = 内核所见） */
export interface SkillImportResult extends SkillsResponse {
  ok: true
  results: SkillImportItemResult[]
}

