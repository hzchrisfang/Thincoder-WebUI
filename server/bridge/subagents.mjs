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
/** 报告正文上限 */
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
/** 建行单点：登记表写入 + 派发计数（ensure / ensureRow 共用——「派发」= 首次出现一个新子代理） */
function createRow(project, key) {
  const e = newEntry(key)
  tableFor(project, true).set(key, e)
  statsFor(project, true).dispatched++
  return e
}
/** 进度统计（广播 / 快照用）：{ dispatched, finished, failed } */
export function statsOf(project) {
  const s = statsFor(project) ?? { dispatched: 0, removed: 0, failed: 0 }
  const rows = [...(tables.get(project)?.values() ?? [])]
  const active = rows.filter((e) => !TERMINAL.has(e.status)).length
  return {
    dispatched: s.dispatched,
    finished: Math.max(0, s.dispatched - active - s.removed),
    failed: s.failed,
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

// ================= 状态 =================

/** relay 文法单一权威（内核 agent/relay-prefix.mjs）——由 runner 每轮 pump 起始注入
 *  （同步路径无法 await 动态 import；未注入时 route* 一律返 false = 主线照旧，
 *  宁可在极端情况下漏分流，也绝不误吞主线事件）。 */
let relay = null
/** project -> Map(key, entry)；entry 只含标量与短数组 */
const tables = new Map()
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

/** 直接建行（报告落位用——不过墓碑闸：报告是权威终态，即使 token 路径已墓碑也要挂上） */
function ensureRow(project, key) {
  const t = tableFor(project, true)
  let e = t.get(key)
  if (!e) e = createRow(project, key)
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

/** 清空某项目登记表 + 墓碑 + 待发广播，并发一次空 items 的 update */
export function clear(project) {
  const had = tables.delete(project)
  tombstones.delete(project)
  stats.delete(project) // 会话边界：进度统计随登记表一起归零（「本会话已派发」）
  const timer = timers.get(project)
  if (timer) {
    clearTimeout(timer)
    timers.delete(project)
  }
  emitNow(project)
  return Boolean(had)
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
 * 扫 agent.history 里的异步子代理报告提醒，把正文挂到对应条目（内核把报告作为 user
 * 消息注入父 history，WebUI 的 buildHistory 会把它滤出会话流——面板是它唯一的可见面）。
 * 幂等：同一 id 同正文重复扫不重复写、不重复广播。整段失败静默（不影响运行收尾）。
 */
export function syncReports(project, agent) {
  try {
    const history = Array.isArray(agent?.history) ? agent.history : null
    if (!history?.length) return
    const from = Math.max(0, history.length - HISTORY_SCAN_LIMIT)
    let changed = false
    for (let i = history.length - 1; i >= from; i--) {
      const m = history[i]
      if (m?.role !== "user" || typeof m.content !== "string") continue
      if (!m.content.startsWith(REPORT_PREFIX)) continue
      const hit = matchReport(m.content)
      if (hit && attachReport(project, hit)) changed = true
    }
    if (changed) flush(project)
  } catch { /* 报告同步失败无碍运行收尾 */ }
}

function matchReport(content) {
  for (const p of REPORT_RES) {
    const m = content.match(p.re)
    if (!m) continue
    return { id: m[1], role: p.role(m), status: p.status, body: m[m.length - 1] ?? "" }
  }
  return null
}

function attachReport(project, { id, role, status, body }) {
  const key = `${role}#${id}`
  const text = unescapeXml(body)
  const truncated = text.length > REPORT_LIMIT
  const report = truncated ? text.slice(0, REPORT_LIMIT) : text
  const entry = ensureRow(project, key)
  if (entry.report === report && entry.reportTruncated === truncated && entry.status === status) return false
  entry.report = report
  entry.reportTruncated = truncated
  entry.status = status // 报告是权威终态：finished→done / error→error
  if (status === "error" && entry._errCounted !== true) {
    entry._errCounted = true // 同一行只记一次（重挂报告不重复计数）
    const s = statsFor(project, true); if (s) s.failed++
  }
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

/** 反转义内核 escapeXml（helpers.mjs：& < > " '）——&amp; 最后处理，免二次反转义 */
function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

// ================= 池校正（run_end 兜底） =================

/**
 * run_end 时按内核池（只读标量）校正状态：在池且未收尾 → 保持/置对应状态；
 * 不在池且既无完成事件也无报告 → ended（本轮结束、未见完成事件）。
 * 全程 try/catch 静默降级；绝不存池条目/childAgent/report 引用。
 */
export function reconcilePool(project, agent) {
  try {
    const t = tables.get(project)
    if (!t?.size) return
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
