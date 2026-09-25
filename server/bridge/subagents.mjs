/**
 * bridge/subagents.mjs — 子代理进度登记表（右侧「子代理」面板的数据源）
 *
 * 背景：内核把子代理的全部回调输出带 relay 前缀（`role#id/`）中继给父回调
 * （core/agent/spawn-child.mjs 的 wrapChildCallbacks）。CLI TUI（src/tui/subagent-blocks.mjs）
 * 与 ACP 端都做了前缀路由，WebUI 此前没有 → 前缀文本混进助手气泡、出现名为
 * `explore#1/read` 的工具卡。本模块是 WebUI 侧的消费端：解析前缀 → 把子代理事件流
 * 从会话流里分流出来，只留标量进登记表（面板读它）。
 *
 * 语义口径对齐 CLI（routeSubToken / applySubEvent 的事件分支）：
 *   queued → 排队中（kind/position）；async → 实际启动（清排队标记、elapsed 重计）；
 *   turn/approval → 轮次与等待审批；done/settled → 完成；stopped → 已中止；
 *   cancelled → 移除条目（从未启动的出队）；[model] → 模型；正文 chunk → lastText 尾窗。
 *  另有一条上游通道 routeSyncComplete：depth-0 的**同步**子代理内核不发 ⟦ev⟧done
 *  （只有嵌套 depth≥1 才经 emitNestedChildEvent 补发射），完成信号走 dispatch 的
 *  onToolResult **第 4 参**（ctx._subagentKey = `role#N`）——没有它同步子代理行会永远 running。
 *
 * 安全红线：只读标量与短数组——**绝不把池条目对象 / childAgent / report 引用存进表**
 * （内核 releaseSettledEntry 的 OOM 教训：条目在消化窗口结束后会置空引用）；
 * 池读取整段 try/catch 静默降级（读不到就当不在池，绝不影响运行）。
 *
 * 报告的归属（面板 vs 时间线）：报告有两个消费面——⓵ 面板行的「完成报告」区（只挂**已存在**的行，
 * 绝不建行：面板是「活的视图」，不为历史重建兜底）；⓶ **会话时间线**（buildHistory 的 report 条目 +
 * syncReports 的 `subagent_report` 实时投递）——时间线才是报告的持久载体。投递面按 project 记
 * 「报告指纹」（`role#id` + 正文）防重（delivered），水合时以同一集合预置。
 */

import * as bus from "../lib/bus.mjs"

// ================= 常量（对齐 CLI TUI 的消费口径） =================

/** 事件哨兵（形同内核 agent/spawn-child.mjs 的 EVENT_SENTINEL）；字段分隔 = \x1e。 */
const SENTINEL = "⟦ev⟧"
const RS = "\x1e"
/** 良构事件 `⟦ev⟧<name>\x1e<n>\x1e<max>\x1e<phase>\x1e<detail>`（CLI SUB_EVENT_RE 同形）。 */
const EVENT_RE = new RegExp(`^${SENTINEL}(turn|approval|done|settled|stopped|queued)${RS}([^${RS}]*)${RS}([^${RS}]*)${RS}([^${RS}]*)${RS}?([\\s\\S]*)$`)
/** 零字段事件（CLI routeSubToken 单独解析，不入 EVENT_RE）：async = 异步子代理实际启动。 */
const ASYNC_RE = new RegExp(`^${SENTINEL}async(${RS}|$)`)
/** 零字段事件：cancelled = 出队/取消 → 移除等待条目（不冻结——从未启动，无活动可冻结）。 */
const CANCELLED_RE = new RegExp(`^${SENTINEL}cancelled(${RS}|$)`)
/** 同步完成信号里的「用户中止」标记（内核 agent/child-marks.mjs 的 STOPPED_MARK 字面量）——
 *  结果文本携带它表示本轮是 Ctrl+C/Ctrl+I 中止收尾（CLI 同分支落 lastError 注记）。 */
const STOPPED_MARK = "stopped by user"

/** 上次活动文本尾窗（面板副标题用） */
const LAST_TEXT_LIMIT = 200
/** 改动文件收集上限 */
const FILES_LIMIT = 20
/** 面板行报告副本的正文上限（面板详情区是固定高度可滚动的活视图；**时间线副本不截断**，整段投递） */
const REPORT_LIMIT = 8000
/** syncReports 最多回扫的 history 条数（从尾部往前） */
const HISTORY_SCAN_LIMIT = 400
/** 变更广播节流（尾部合并保证最后一次必发）；跃迁走 flush 立即发 */
const UPDATE_THROTTLE_MS = 250
/** 终态行保留上限：面板行跨轮累积（= 本会话子代理活动记录），只裁最旧的终态行，
 *  运行中/排队行永不裁（内核 task 清单同款上限 20 的量级）。 */
const TERMINAL_LIMIT = 20
/** 终态集合（finish / routeSyncComplete / attachReport / reconcilePool 的落点） */
const TERMINAL = new Set(["done", "stopped", "error", "ended"])

// ── 会话级进度统计（0.9.0）：分母必须是**单调计数**——终态行按 TERMINAL_LIMIT 自裁，行数会封顶失真，
//    拿行数当分母会把「已派发」永远卡在 20。`finished` 与面板 TERMINAL 集合同口径（done/stopped/
//    error/ended = 该行不再活跃），故由「已派发 − 仍活跃行 − 被移除的占位行」派生：与面板所见
//    一致，且不怕裁剪。会话边界（clear）随登记表一起归零。
const stats = new Map() // project -> { dispatched, removed, failed }
function statsFor(project, create = false) {
  let s = stats.get(project)
  if (!s && create) { s = { dispatched: 0, removed: 0, failed: 0 }; stats.set(project, s) }
  return s
}
/** 建行单点（唯一调用方 `ensure`——「派发」= 首次出现一个新子代理）。
 *  报告落位**不再**经这里：行不存在就不建（否则 syncReports 的历史重建会虚增「已派发」，且服务重启后
 *  内核 id 从 1 重计、新实例的同名 `role#id` 会覆盖历史重建的旧行）。 */
function createRow(project, key) {
  const e = newEntry(key)
  tableFor(project, true).set(key, e)
  statsFor(project, true).dispatched++
  return e
}
/** 进度统计（广播 / 快照用）：{ dispatched, finished, failed }。
 *  dispatched / finished 是**单调计数**（分母不得因终态行 20 条自裁而封顶）。
 *  **failed 由表派生**（数 status === "error" 的行），不用累加器：行状态会被更正（同一行先后扫到旧/新报告），
 *  累加器无法自愈——用户实测「5/5 失败 1」而并无失败行，正是累加器与显示面脱钩（见坑 86）。 */
export function statsOf(project) {
  const s = statsFor(project) ?? { dispatched: 0, removed: 0 }
  const rows = [...(tables.get(project)?.values() ?? [])]
  const active = rows.filter((e) => !TERMINAL.has(e.status)).length
  return {
    dispatched: s.dispatched,
    finished: Math.max(0, s.dispatched - active - s.removed),
    failed: rows.filter((e) => e.status === "error").length,
  }
}

/** 文件变更类工具（基名）——args.path 收进 files（对齐 runner.mjs 的 AUTO_EDIT_AUTO 家族） */
const FILE_TOOLS = new Set(["write", "edit", "delete", "hashline_edit", "multi_edit", "apply_patch"])

/** 异步子代理最终报告（内核 agent-tools/subagent-async.mjs injectAsyncResult 的三种形态）。
 *  逐行对齐内核字面量（escalate 完成态的中文破折号用 \u2014 显式写出，免字面量漂移）。 */
const REPORT_RES = [
  { re: /^\[System reminder: async subagent #(\d+) \(([^)]+)\) finished\]\n?([\s\S]*)$/, role: (m) => m[2], status: "done" },
  { re: /^\[System reminder: async escalate #(\d+) finished \u2014 post-op report \(mutations merged\)\]\n?([\s\S]*)$/, role: () => "escalate", status: "done" },
  { re: /^\[System reminder: async escalate #(\d+) ended with an error\]\n?([\s\S]*)$/, role: () => "escalate", status: "error" },
  { re: /^\[System reminder: async advisor review #(\d+) finished\]\n?([\s\S]*)$/, role: () => "advisor", status: "done" },
]
const REPORT_PREFIX = "[System reminder: async "

/** 内核 provider 层抛错的**开头形态封闭集**（LLM API 调用失败：4xx/5xx/网络等）。
 *  内核对「异步普通子代理失败」不发独立标记——回执仍用 finished 措辞、错误文本作为报告正文
 *  （P10 实测：错误态唯一独立通道是 escalate 飞刀），面板因此假绿（✓ 已完成但任务实际失败，
 *  用户配额耗尽实验 2026-09-25 实证）。此处窄化补丁：报告正文以此集合中任一形态**开头** → 终态 error。
 *
 *  形态来源（单一权威，两条都出自内核 provider 层——内核换措辞就必须回这两处对账）：
 *   ① `LLM API error {status}: …` —— 单次失败/不可重试状态
 *      （`core/provider/core.mjs:445`、`core/provider/retry.mjs:44`）
 *   ② `{verb} after {N} attempts…` —— 重试耗尽（`core/provider/core.mjs:490`、`core/provider/retry.mjs:87`），
 *      verb 恰四种：429→`Rate limit not resolved` / 5xx→`Server error persisted` / 其他状态→`Request failed` /
 *      无状态（fetch/DNS/TLS/代理）→`Network error`
 *  用户实测的「重试后失败」形态（`Rate limit not resolved after 4 attempts (429): LLM API error 429: …`）
 *  即 ②：**首部不是 `LLM API error`**，只判后者会漏判 —— 这是集合化而非单前缀的直接原因。
 *
 *  **必须用 startsWith 首部匹配（不是子串包含）**：正常报告完全可能**讨论**这些错误串（如专门排查
 *  错误处理的探索子代理），子串匹配会把它们误判为失败。
 *  误判面：正常报告不会以这五种形态开头（均为 provider 层异常固定格式，非模型可自由产出的话术）；
 *  escalate 的 error 通道不走此判据（其回执形态本就独立）。*/
const LLM_ERROR_LEADS = [
  "LLM API error ",                    // ① 单次失败（status 后跟冒号）
  "Rate limit not resolved after ",    // ② 429 重试耗尽
  "Server error persisted after ",     // ② 5xx 重试耗尽
  "Request failed after ",             // ② 其他状态码重试耗尽
  "Network error after ",              // ② 网络/代理/DNS/TLS 重试耗尽
]

/** 报告终态判定（单一权威：面板挂行与时间线投递共用）：内核 finished 回执 + 正文以 provider 层错误
 *  **开头形态**开头 → error（假绿改判，见上）；status 已是 error 的（飞刀独立通道）不受影响。 */
export function reportStatus(status, text) {
  if (status !== "done") return status
  const s = String(text)
  return LLM_ERROR_LEADS.some((lead) => s.startsWith(lead)) ? "error" : status
}

// ================= 状态 =================

/** relay 文法单一权威（内核 agent/relay-prefix.mjs）——由 runner 每轮 pump 起始注入
 *  （同步路径无法 await 动态 import；未注入时 route* 一律返 false = 主线照旧，
 *  宁可在极端情况下漏分流，也绝不误吞主线事件）。 */
let relay = null
/** project -> Map(key, entry)；entry 只含标量与短数组 */
const tables = new Map()
/** project -> Set(fingerprint)：本会话**已投递**过的报告（防重复投递——syncReports 每轮回扫历史）。
 *  指纹 = `ref` + 正文指纹（**按内容判重，不按名字判重**）：同一份报告不重投，而服务重启 / agent 重建后
 *  内核 id 从 1 重算撞上同名 ref 时，**新正文仍能投出去**（否则那条报告就永远到不了时间线）。
 *  水合（buildHistory）时预置同一集合：水合已把这些报告交给客户端，实时投递面据此跳过。
 *  会话边界（clear）整体作废；**回合起点的安全清空（clearIfIdle）不动它**——否则下一轮回扫会把
 *  同一份报告再投一遍（客户端已有一条，会出重复块）。 */
const delivered = new Map()

/** 正文指纹（FNV-1a 32 位；只做去重指纹，不涉密码学用途——几百条量级下碰撞可忽略）。 */
function bodyFingerprint(text) {
  const s = String(text)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}
/** project -> Set(key)：本窗口内已终的 key——迟到 token 不得复活条目（CLI _frozenSubKeys 同款） */
const tombstones = new Map()
/** project -> Timeout：合并中的广播 */
const timers = new Map()

/** 注入 relay 解析器（内核模块集）——幂等，重复注入覆盖。 */
export function useRelay(mod) {
  if (typeof mod?.parseRelayPath === "function") relay = mod
}

function parse(text) {
  if (!relay) return null
  try { return relay.parseRelayPath(text) } catch { return null }
}

// ================= 条目 =================

function splitKey(key) {
  const at = key.lastIndexOf("#")
  if (at <= 0) return { role: key, id: key }
  return { role: key.slice(0, at), id: key.slice(at + 1) }
}

/** 新条目（值全为标量/短数组；_started 仅供本地守卫，不出现在 list() 输出里） */
function newEntry(key, status = "running") {
  const { role, id } = splitKey(key)
  const now = Date.now()
  return {
    key, role, id,
    model: null,
    status, // queued | running | done | stopped | error | ended
    queueKind: null,
    position: null,
    startedAt: status === "queued" ? null : now,
    turn: 0,
    maxTurns: 0,
    currentTool: null,
    lastText: "",
    files: [],
    waitingApproval: false,
    report: null,
    reportTruncated: false,
    // 待消化（挂起会话期）：已 settle 但报告尚未进会话（= 条目驻 pending 容器）——挂起驱动的
    // reconcilePool 按此标记，前端显「待消化」；报告挂行 / 消化完成即清掉
    pending: false,
    updatedAt: now,
    _started: false, // ⟦ev⟧async 置位：排队块与已启动块的判别（cancelled 守卫用）
  }
}

function tableFor(project, create = false) {
  let t = tables.get(project)
  if (!t && create) {
    t = new Map()
    tables.set(project, t)
  }
  return t
}

function tombstone(project, key) {
  let s = tombstones.get(project)
  if (!s) {
    s = new Set()
    tombstones.set(project, s)
  }
  s.add(key)
}

/** 取（或建）条目；已终 key 的迟到 token → null（调用方丢弃，已消费不进会话） */
function ensure(project, head) {
  if (tombstones.get(project)?.has(head)) return null
  const t = tableFor(project, true)
  let e = t.get(head)
  if (!e) {
    e = createRow(project, head)
    flush(project) // 新建 = 跃迁：立即广播
    return e
  }
  // reconcile 判过 ended 后仍有活动 ⇒ 子代理其实还活着（异步子代理活过父回合的正常路径）——自愈回 running
  if (e.status === "ended") {
    e.status = "running"
    if (e.startedAt == null) e.startedAt = Date.now()
    e.updatedAt = Date.now()
  }
  return e
}

// ================= 广播 =================

function toItem(e) {
  return {
    key: e.key,
    role: e.role,
    id: e.id,
    model: e.model,
    status: e.status,
    queueKind: e.queueKind,
    position: e.position,
    startedAt: e.startedAt,
    turn: e.turn,
    maxTurns: e.maxTurns,
    currentTool: e.currentTool,
    lastText: e.lastText,
    files: e.files.slice(), // 短数组拷贝：表内数组绝不外泄
    waitingApproval: e.waitingApproval,
    report: e.report,
    reportTruncated: e.reportTruncated,
    pending: e.pending === true,
    updatedAt: e.updatedAt,
  }
}

/** 节流广播（合并窗口内的多次变更，尾部必发一次） */
function scheduleUpdate(project) {
  if (timers.has(project)) return
  const timer = setTimeout(() => {
    timers.delete(project)
    emitNow(project)
  }, UPDATE_THROTTLE_MS)
  timer.unref?.()
  timers.set(project, timer)
}

/** 跃迁广播（新建/完成/中止/取消/排队/报告/池校正）：取消合并中的定时器，立即发最新全量 */
function flush(project) {
  const timer = timers.get(project)
  if (timer) {
    clearTimeout(timer)
    timers.delete(project)
  }
  emitNow(project)
}

function emitNow(project) {
  try {
    bus.emit({ type: "subagents_update", project, items: list(project), stats: statsOf(project) })
  } catch { /* 广播失败不阻塞运行 */ }
}

// ================= 对外查询 =================

/** 该项目登记表快照（活跃在前、组内按 id 升序）——只返回标量/短数组的浅拷贝 */
export function list(project) {
  const t = tables.get(project)
  if (!t?.size) return []
  const items = [...t.values()].map(toItem)
  const rank = (s) => (s === "running" ? 0 : s === "queued" ? 1 : 2)
  items.sort((a, b) => rank(a.status) - rank(b.status) || numId(a.id) - numId(b.id) || String(a.key).localeCompare(String(b.key)))
  return items
}

function numId(id) {
  const n = Number(id)
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER
}

/** 全项目快照（runner.snapshot() 播种用） */
export function snapshotAll() {
  const out = {}
  for (const project of tables.keys()) out[project] = list(project)
  return out
}

/** 全项目进度统计（runner.snapshot() 的 `subagentStats` 字段；形状与 emitNow 的 stats 同源） */
export function snapshotStatsAll() {
  const out = {}
  for (const project of tables.keys()) out[project] = statsOf(project)
  return out
}

/** 清表唯一执行体（登记表 + 墓碑 + 统计 + 待发广播，发一次空 items 的 update）：clear 与
 *  clearIfIdle 共用；**不含**已投递集（那一层的作废归会话边界管，见 clear）。 */
function clearTable(project) {
  const had = tables.delete(project)
  tombstones.delete(project)
  stats.delete(project) // 进度统计随登记表一起归零（「本会话已派发」）
  const timer = timers.get(project)
  if (timer) {
    clearTimeout(timer)
    timers.delete(project)
  }
  emitNow(project)
  return Boolean(had)
}

/** 清空某项目登记表 + 墓碑 + 待发广播（**会话边界**：新建 / 切换会话、回退、移除项目）。 */
export function clear(project) {
  const had = clearTable(project)
  // 已投递集随会话一起作废：换会话/槽位后历史换了，同 ref 的报告（服务重启后内核 id 从 1 重计）须能再投递
  delivered.delete(project)
  return had
}

/**
 * 安全清空（新一轮**用户**回合的起点；调用点 = runner.pump）：只在「表内无活跃行（running/queued）
 * ∧ 无待消化行（pending）∧ 内核三池内无未收尾条目」时才清表，返回「是否确有行被清」（与 clear 同口径）。
 *
 * 为何不直接调 clear：跨轮累积的行只有在「无活可丢」时才清得安全——有活跃/待消化行时清空会丢掉仍在
 * 跑的进度，也会让顶栏【子代理】按钮的转圈条件（running ∨ queued ∨ pending）失去依据；
 * 且 clear 会连带作废已投递集，让下一轮 syncReports 把同一份报告重投一遍（重复块）。
 * 池判据与 reconcilePool 同源（livePoolIndex）；池读不到（null）按「可能有活」处理——不清。
 */
export function clearIfIdle(project, agent = null) {
  const t = tables.get(project)
  for (const e of t?.values() ?? []) {
    if (!TERMINAL.has(e.status) || e.pending === true) return false
  }
  if (agent) {
    const live = livePoolIndex(agent)
    if (!live || live.size > 0) return false
  }
  return clearTable(project)
}

// ================= 前缀路由（callbacks 委派：true = 已消费，调用方不得再发主线事件） =================

/** onToken 分支：子文本 / [model] 元数据 / ⟦ev⟧ 事件（CLI routeSubToken 同构，登记表版） */
export function routeToken(project, text) {
  const path = parse(text)
  if (!path) return false
  const payload = path.rest
  const nested = path.inner.length > 0
  const entry = ensure(project, path.head)
  if (!entry) return true // 已终 key：迟到 token 丢弃（已消费，绝不进会话流）
  const now = Date.now()

  // 零字段 async 标记（CLI D-M7b①）：实际启动 → running、清排队标记、elapsed 从此刻重计
  if (!nested && ASYNC_RE.test(payload)) {
    entry.status = "running"
    entry._started = true
    entry.queueKind = null
    entry.position = null
    entry.startedAt = now
    entry.updatedAt = now
    flush(project)
    return true
  }
  // 零字段 cancelled（出队/取消）：移除等待条目——已启动的条目经 ⟦ev⟧stopped 表达取消（CLI 同守卫）
  if (!nested && CANCELLED_RE.test(payload)) {
    if (!entry._started) removeKey(project, path.head)
    return true
  }
  if (payload.startsWith(SENTINEL)) {
    // 内层事件（eng-coder#2/explore#1/...）不路由到外层行——防内层进度污染外层表头（CLI round1 #4 同口径）；
    // 无论良构与否都消费（协议控制字符绝不进会话）
    if (nested) return true
    const ev = payload.match(EVENT_RE)
    if (ev) applyEvent(project, entry, ev)
    return true
  }
  // `[model]<name>` 出生声明（恒为首 token）：内层不覆盖外层模型（CLI 同口径）
  if (!nested && payload.startsWith("[model]")) {
    if (entry.model == null) {
      entry.model = payload.slice(7) || null
      entry.updatedAt = now
      scheduleUpdate(project)
    }
    return true
  }
  // 子代理正文（内层内容并入外层行的尾窗——CLI SUBAGENT-TAIL 的显示口径）
  // 残片兜底：内核按单 chunk 剥哨兵（chunk 边界拆分时漏剥，见 core 的「单 chunk 匹配」已知限制），
  // 带字段分隔符 \x1e 的片段与残缺哨兵（⟦ / ⟦e / ⟦ev / v⟧ / ev⟧）一律不入正文——
  // 否则面板「最近活动」会显示协议噪声
  const fragment = payload.includes("\x1e") || /^(⟦|⟦e|⟦ev|v⟧|ev⟧)$/.test(payload)
  if (!fragment) {
    entry.lastText = tailText(entry.lastText + payload, LAST_TEXT_LIMIT)
    entry.updatedAt = now
    scheduleUpdate(project)
  }
  return true
}

/** 事件 token → 条目状态（CLI applySubEvent + routeSubToken 的事件分支合并版） */
function applyEvent(project, entry, ev) {
  const kind = ev[1]
  const now = Date.now()
  if (kind === "queued") {
    if (entry._started) return // 已启动的迟到 queued：陈旧，不复活排队标注
    entry.status = "queued"
    entry.queueKind = ev[2] === "wait" || ev[2] === "depc" ? ev[2] : "slot"
    const pos = Number(ev[3])
    entry.position = pos > 0 ? pos : null
    entry.startedAt = null // 排队等待不计 elapsed（与池 startedAt 语义一致）
    entry.waitingApproval = false
    entry.updatedAt = now
    flush(project)
    return
  }
  if (kind === "done" || kind === "settled") return finish(project, entry, "done")
  if (kind === "stopped") return finish(project, entry, "stopped")
  if (kind === "turn") {
    entry.turn = Number(ev[2]) || entry.turn
    entry.maxTurns = Number(ev[3]) || entry.maxTurns
    entry.waitingApproval = false
    entry.updatedAt = now
    scheduleUpdate(project)
    return
  }
  if (kind === "approval") {
    entry.turn = Number(ev[2]) || entry.turn
    entry.maxTurns = Number(ev[3]) || entry.maxTurns
    entry.waitingApproval = true
    entry.updatedAt = now
    scheduleUpdate(project)
  }
}

/** 终态跃迁（done/settled/stopped）：广播立即发 + 落墓碑（迟到 token 不复活） */
function finish(project, entry, status) {
  entry.status = status
  entry.currentTool = null
  entry.waitingApproval = false
  entry.queueKind = null
  entry.position = null
  entry.updatedAt = Date.now()
  tombstone(project, entry.key)
  prune(project)
  flush(project)
}

function removeKey(project, key) {
  const t = tables.get(project)
  const e = t?.get(key)
  if (!t?.delete(key)) return
  // 占位行被移除（从未启动的 queued 行）：它没到终局，不得被算进「已结束」——单独记账扣除
  if (e && !TERMINAL.has(e.status)) { const s = statsFor(project, true); if (s) s.removed++ }
  tombstone(project, key) // 移除与墓碑同一守卫（CLI c2：后续迟到 token 不重建幻影条目）
  flush(project)
}

/** 终态行裁剪：跨轮累积的登记表按上限只留最新 TERMINAL_LIMIT 条终态行
 *  （活跃行不计、永不裁——面板上「还在跑」的行不可能被挤掉）。 */
function prune(project) {
  const t = tables.get(project)
  if (!t || t.size <= TERMINAL_LIMIT) return
  const terminal = [...t.values()].filter((e) => TERMINAL.has(e.status))
  if (terminal.length <= TERMINAL_LIMIT) return
  terminal.sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0) || numId(a.id) - numId(b.id))
  for (const e of terminal.slice(0, terminal.length - TERMINAL_LIMIT)) {
    t.delete(e.key)
    tombstone(project, e.key) // 与被裁行同守卫：迟到 token 不复活已裁行
  }
}

/** 同步子代理完成信号（dispatch runOne 把 ctx._subagentKey 作 onToolResult **第 4 参**传来——
 *  内核 agent/dispatch.mjs 的 `callbacks.onToolResult?.(name, result, id, toolCtx._subagentKey)`；
 *  key = `role#N`，与登记表行 key 同形。CLI 消费点：tui/tool-events.mjs 的 onToolResult 第 4 参
 *  → finishSubTaskKey 按 key 精确冻）。
 *  ——为何需要它：depth-0 的 sync 子代理内核**不发** ⟦ev⟧done（只有嵌套（depth≥1）才经
 *  emitNestedChildEvent 补发射），没有本通道时同步子代理行会永远停在 running 直到整轮 run_end。
 *  只冻**已存在**的行（无 key / 无行 = 错误或中止路径：不建幻影）；
 *  **不消费**主线事件（调用方照旧发主线 tool_result——主线自己的 subagent 工具卡不动）。
 *  状态口径：CLI 同路径恒标 done + lastError 注记（本表无 lastError 字段）；用户中止一档
 *  取面板更贴近的 stopped，其余（含轮数上限）与 CLI 同标 done。
 *  另注：内核只在**成功/折叠出口**置 `_subagentKey`（core/agent-tools/subagent.mjs 同处注释），
 *  错误/中止路径根本不进本函数——那类同步子代理最终由 reconcilePool 落 `ended`（灰 ✓），
 *  面板的 `error` 状态目前只有异步报告通道可达。 */
export function routeSyncComplete(project, subKey, result) {
  if (typeof subKey !== "string" || !subKey) return false
  const entry = tables.get(project)?.get(subKey)
  if (!entry) return false
  if (entry.status === "done" || entry.status === "stopped" || entry.status === "error" || entry.status === "ended") return false
  const stopped = String(result ?? "").includes(STOPPED_MARK)
  entry.status = stopped ? "stopped" : "done"
  entry.currentTool = null
  entry.waitingApproval = false
  entry.queueKind = null
  entry.position = null
  entry.updatedAt = Date.now()
  if (entry._started !== true) entry._started = true
  tombstone(project, entry.key) // 已终：迟到 token 不复活（同 finish 口径）
  prune(project)
  flush(project)
  return true
}

/** onReasoning 分支：子代理思考流不进面板（面板只显示正文尾/工具），只记活动时间 */
export function routeReasoning(project, text) {
  const path = parse(text)
  if (!path) return false
  const entry = ensure(project, path.head)
  if (!entry) return true
  entry.updatedAt = Date.now()
  return true
}

/** onToolCall 分支：currentTool = 去前缀基名（内层链保完整路径，CLI 外层块同口径）+ 一行参数摘要 */
export function routeToolCall(project, name, args) {
  const path = parse(name)
  if (!path) return false
  const entry = ensure(project, path.head)
  if (!entry) return true
  const tool = path.rest || ""
  const label = path.inner.length > 0 ? `${path.label}/${tool}` : tool
  const desc = summarizeArgs(tool, args)
  entry.currentTool = desc ? `${label} ${desc}` : label
  entry.waitingApproval = false
  entry.updatedAt = Date.now()
  collectFiles(entry, tool, args)
  scheduleUpdate(project)
  return true
}

/** onToolResult 分支：子代理工具结果不进面板（面板显示最近活动/报告），只记活动时间。
 *  注：当前内核 wrapChildCallbacks 只给 onToken/onReasoning/onToolCall/onToolOutput 加前缀
 *  （不包装 onToolResult）——本函数是给未来内核留的对称面，现版恒返 false。 */
export function routeToolResult(project, name, result) {
  const path = parse(name)
  if (!path) return false
  const entry = ensure(project, path.head)
  if (!entry) return true
  entry.updatedAt = Date.now()
  return true
}

/** onToolOutput 分支：子代理 bash 实时输出不进面板（免噪声），只记活动时间 */
export function routeToolOutput(project, name, chunk) {
  const path = parse(name)
  if (!path) return false
  const entry = ensure(project, path.head)
  if (!entry) return true
  entry.updatedAt = Date.now()
  return true
}

// ================= 最终报告（异步子代理） =================

/**
 * 扫 agent.history 里的异步子代理报告提醒（内核把报告作为 user 消息注入父 history）：
 * ⓵ 把正文挂到**已存在**的面板行（行不存在则跳过——不建行、不计派发，见 attachReport）；
 * ⓶ 把**首次见到**的报告作 `subagent_report` 投递给会话时间线（报告的持久显示面）。
 * 幂等：同一份报告（ref + 正文）不重复投递、同一行同正文不重复写、不重复广播。整段失败静默。
 */
export function syncReports(project, agent) {
  try {
    const history = Array.isArray(agent?.history) ? agent.history : null
    if (!history?.length) return
    const from = Math.max(0, history.length - HISTORY_SCAN_LIMIT)
    let changed = false
    const fresh = [] // 首次见到的报告（待投递给时间线）
    const newest = new Map() // key -> hit：**同 key 只留最新的一份**（回扫序新→旧，首次命中即最新）
    for (let i = history.length - 1; i >= from; i--) {
      const m = history[i]
      if (m?.role !== "user" || typeof m.content !== "string") continue
      if (!m.content.startsWith(REPORT_PREFIX)) continue
      const hit = parseReportMessage(m.content)
      if (!hit) continue
      const key = `${hit.role}#${hit.id}`
      if (!newest.has(key)) newest.set(key, hit) // 新→旧回扫：首次命中 = 该 key 在历史里最新的报告
      if (markReportDelivered(project, key, hit.body)) fresh.push(hit)
    }
    // 面板挂行只取「每 key 最新那份」（见 attachReport 注：旧报告不得覆盖新报告）
    for (const hit of newest.values()) if (attachReport(project, hit)) changed = true
    // 上面的回扫是「新→旧」；倒回来按历史顺序投递——客户端据此顺序 append，时间线才不乱序
    for (const hit of fresh.reverse()) emitReport(project, hit)
    if (changed) flush(project)
  } catch { /* 报告同步失败无碍运行收尾 */ }
}

/** 记「该份报告已投递 / 已随水合交付」；返回 true = 本次是首次（调用方据此投递）。 */
export function markReportDelivered(project, ref, body) {
  let set = delivered.get(project)
  if (!set) {
    set = new Set()
    delivered.set(project, set)
  }
  const key = `${ref}\u0000${bodyFingerprint(body)}`
  if (set.has(key)) return false
  set.add(key)
  return true
}

/** 报告 → 时间线的实时投递（客户端 pushItem）。正文整段不截断（时间线是报告的持久载体）；
 *  广播失败静默——与其余事件同口径，投递不得影响运行收尾。 */
function emitReport(project, hit) {
  const text = unescapeXml(hit.body)
  try {
    bus.emit({ type: "subagent_report", project, ref: `${hit.role}#${hit.id}`, status: reportStatus(hit.status, text), text })
  } catch { /* 投递失败不阻塞收尾 */ }
}

/** 报告提醒解析（单一权威——buildHistory 与 syncReports 共用，绝不另写第二套正则）。
 *  返回 `{ id, role, status, body }`；body 仍是内核 escapeXml 后的原文，消费方各自 unescape。 */
export function parseReportMessage(content) {
  for (const p of REPORT_RES) {
    const m = content.match(p.re)
    if (!m) continue
    return { id: m[1], role: p.role(m), status: p.status, body: m[m.length - 1] ?? "" }
  }
  return null
}

/**
 * 把报告挂到**已存在**的面板行；行不存在 → 返回 false（**不建行、不计派发**）。
 * 为何不建行：报告已由会话时间线承载（buildHistory 的 report 条目 + subagent_report 实时投递），面板不再
 * 需要「历史重建」兜底；而建行会把历史报告算成一次真实派发（计数虚增），服务重启后内核 id 从 1 重计时
 * 新实例的 `role#id` 还会撞上历史重建的同名行（新记录覆盖旧记录）。其余路径的建行（relay token）不变。
 *
 * **旧不覆盖新**：内核 id 在服务重启后从 1 重算 ⇒ 历史里上一实例的同 key 报告会落到本轮新行上；若不加约束，
 * 回扫遇旧报告就会把行状态改回 error（用户实测「5/5 失败 1」而并无失败行，见坑 86）。约束放在**调用侧**——
 * `syncReports` 回扫时按 key 只保留**历史里最新**的一份（新→旧序首次命中），本函数只负责无差别地挂那一份；
 * 跨轮「新报告更正旧状态」因此自然成立（下一轮扫描里最新那份已是新报告）。
 */
function attachReport(project, { id, role, status, body }) {
  const key = `${role}#${id}`
  const text = unescapeXml(body)
  const truncated = text.length > REPORT_LIMIT
  const report = truncated ? text.slice(0, REPORT_LIMIT) : text
  const entry = tables.get(project)?.get(key)
  if (!entry) return false
  if (entry.report === report && entry.reportTruncated === truncated && entry.status === status) return false
  entry.report = report
  entry.reportTruncated = truncated
  // 假绿改判（单源 = reportStatus）：内核 finished 回执 + 报告正文以 provider 层错误前缀开头 → 终态 error。
  // status 已是 error 的（飞刀独立通道）不受影响；失败计数由 statsOf 从表派生（不在此处累加）。
  entry.status = reportStatus(status, report) // 报告是权威终态：finished→done / error→error（假绿改判后同）
  entry.pending = false // 报告已进会话（同步自 history）= 消化完成：待消化标记退场
  entry.currentTool = null
  entry.waitingApproval = false
  entry.queueKind = null
  entry.position = null
  entry.updatedAt = Date.now()
  tombstone(project, key)
  prune(project)
  return true
}

/** 反转义内核 escapeXml（helpers.mjs：& < > " '）——&amp; 最后处理，免二次反转义。
 *  导出供 buildHistory 复用（时间线报告条目与面板报告副本同一套反转义语义，绝不另写一份）。 */
export function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

// ================= 池校正（run_end 兜底） =================

/**
 * 内核三池的「未收尾条目」索引（key → 池条目）：`role#id`（表 key 同形）与池 key 双写兜底。
 * reconcilePool（状态校正）与 clearIfIdle（安全清空判据）共用这一份读法——判据单源。
 * 读失败返回 **null**（≠ 空表）：调用方各自决定降级（校正=保持原样、清空=不清）。
 */
function livePoolIndex(agent) {
  try {
    const live = new Map()
    for (const pool of [agent?._asyncSubagents, agent?._asyncAdvisors, agent?._consultSessions]) {
      if (!(pool instanceof Map)) continue
      for (const [k, v] of pool) {
        if (!v || typeof v !== "object") continue
        if (v.done === true || v.cancelled === true) continue // 已收尾（内核 livePoolHas 存活判据）
        const role = typeof v.role === "string" && v.role ? v.role : null
        const id = v.id != null ? String(v.id) : null
        if (role && id) live.set(`${role}#${id}`, v)
        live.set(String(k), v) // 表 key 与池 key 同形的兜底
      }
    }
    return live
  } catch {
    return null
  }
}

/**
 * run_end 时按内核池（只读标量）校正状态：在池且未收尾 → 保持/置对应状态；
 * 不在池且既无完成事件也无报告 → ended（本轮结束、未见完成事件）。
 * 全程 try/catch 静默降级；绝不存池条目/childAgent/report 引用。
 */
export function reconcilePool(project, agent) {
  try {
    const t = tables.get(project)
    if (!t?.size) return
    const live = livePoolIndex(agent)
    if (!live) return // 池读不到：表保持原样（降级 = 什么都不改）
    // 待消化条目（挂起会话）：已 settle 的条目在挂起期被移交 pending 单容器（内核 settle 分流
    // / 挂起 sweep），**已出池**——“不在池”对它们不是「本轮结束未见完成事件」，而是「报告在
    // 路上，消化轮随后注入」。键形与报告挂行同源（`${role}#${id}`——attachReport 同式）。
    const pendingKeys = new Set()
    for (const e of agent?._pendingAsyncResults ?? []) {
      if (!e || typeof e !== "object") continue
      const role = typeof e.role === "string" && e.role ? e.role : null
      const id = e.id != null ? String(e.id) : null
      if (role && id) pendingKeys.add(`${role}#${id}`)
    }
    let changed = false
    const now = Date.now()
    for (const entry of t.values()) {
      const hit = live.get(entry.key)
      // 「待消化」标记严格镜像 pending 容器（消化轮在 run 首行消费它——下一次 reconcile 即清掉）
      const pendingRow = pendingKeys.has(entry.key)
      if (entry.pending !== pendingRow) {
        entry.pending = pendingRow
        changed = true
      }
      if (hit) {
        const status = hit.status === "queued" ? "queued" : "running"
        if (entry.status !== status) {
          entry.status = status
          changed = true
        }
        const pos = Number(hit.position)
        if (status === "queued" && Number.isFinite(pos) && pos > 0 && entry.position !== pos) {
          entry.position = pos
          changed = true
        }
        const turn = Number(hit.turn)
        if (Number.isFinite(turn) && turn > entry.turn) {
          entry.turn = turn
          changed = true
        }
        const max = Number(hit.maxTurns)
        if (Number.isFinite(max) && max > entry.maxTurns) {
          entry.maxTurns = max
          changed = true
        }
        if (entry.model == null && typeof hit.model === "string" && hit.model) {
          entry.model = hit.model
          changed = true
        }
        if (entry.startedAt == null && Number.isFinite(Number(hit.startedAt)) && Number(hit.startedAt) > 0) {
          entry.startedAt = Number(hit.startedAt)
          changed = true
        }
        if (status === "running" && entry._started !== true) entry._started = true
        if (changed) entry.updatedAt = now
      } else if (pendingRow) {
        // 待消化：报告在路上（挂起驱动的消化轮随后注入）——**不得**降级 ended（旧行为把它当
        // 「本轮结束未见完成事件」，在挂起会话里会误报「已结束」并让面板行失去报告归属）
        entry.updatedAt = now
      } else if (entry.status === "running" || entry.status === "queued") {
        entry.status = "ended"
        entry.waitingApproval = false
        entry.queueKind = null
        entry.position = null
        entry.updatedAt = now
        changed = true
      }
    }
    if (changed) flush(project)
  } catch { /* 池读取失败静默降级（表保持原样） */ }
}

// ================= 小工具 =================

/** 尾窗（末尾 N 个 UTF-16 码元；首字符若是孤立低代理则多丢一位，免半个 emoji） */
function tailText(text, n) {
  if (text.length <= n) return text
  let s = text.slice(-n)
  const c = s.charCodeAt(0)
  if (c >= 0xdc00 && c <= 0xdfff) s = s.slice(1)
  return s
}

function baseName(name) {
  return name.includes("/") ? name.split("/").pop() : name
}

function collapse(v) {
  return String(v ?? "").replace(/\s+/g, " ").trim()
}

/** 一行参数摘要（≤80 字）：按工具挑关键字段，未知工具回退紧凑 JSON */
function summarizeArgs(name, args) {
  if (!args || typeof args !== "object") return ""
  const base = baseName(name)
  const a = args
  let s = ""
  switch (base) {
    case "bash": case "cmd-shell": s = collapse(a.command); break
    case "read": case "write": case "edit": case "delete": case "hashline_edit": case "multi_edit": s = collapse(a.path ?? a.file_path ?? a.filePath); break
    case "grep": case "glob": case "code_search": case "doc_search": case "search": s = collapse(a.pattern ?? a.query) + (a.path ? ` in ${collapse(a.path)}` : ""); break
    case "ls": s = collapse(a.path ?? "."); break
    case "websearch": s = collapse(a.query); break
    case "subagent": case "explore": case "plan": case "coder": case "eng-coder": case "eng-designer": s = collapse(a.task ?? a.action); break
    case "advisor": s = collapse(a.type ?? "review"); break
    case "question": s = collapse(a.question); break
    case "memory": s = collapse(a.action ?? a.query ?? a.title); break
    case "read_image": s = collapse(a.path); break
    default: s = ""
  }
  if (!s && Object.keys(a).length > 0) {
    // 未知工具回退：只取前 6 个键 + 短串值（嵌套值折叠占位）——避免对 apply_patch/MCP
    // 之类的大参数做无上限 JSON.stringify（结果只留 79 字符，序列化大字符串纯浪费）
    try {
      const small = {}
      for (const [k, v] of Object.entries(a).slice(0, 6)) {
        small[k] = typeof v === "string" ? (v.length > 120 ? v.slice(0, 120) + "…" : v) : v === null || typeof v !== "object" ? v : "…"
      }
      const j = JSON.stringify(small)
      s = typeof j === "string" ? j : ""
    } catch { s = "" }
  }
  s = collapse(s)
  return s.length > 80 ? s.slice(0, 79) + "…" : s
}

/** 文件变更类工具：args.path 收进 files（去重、上限 20） */
function collectFiles(entry, tool, args) {
  if (!FILE_TOOLS.has(baseName(tool))) return
  const p = args?.path ?? args?.file_path ?? args?.filePath
  if (typeof p !== "string") return
  const v = p.trim()
  if (!v || entry.files.includes(v) || entry.files.length >= FILES_LIMIT) return
  entry.files = [...entry.files, v]
}
