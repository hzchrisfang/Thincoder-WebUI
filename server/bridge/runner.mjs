/**
 * bridge/runner.mjs — runAgent 编排：单飞 / 排队 / 中断 / 事件映射 / 审批挂起
 *
 * 每个项目独立状态：{ busy, queue, abort, mode, allowlist }
 * 审批三档（策划书 4.4）：suggest（全问）/ auto-edit（写盘免批，bash 问）/ full-auto（等价内核 AUTO）
 */

import { randomUUID } from "node:crypto"
import * as bus from "../lib/bus.mjs"
import { listProjects, getWatchdogEnabled } from "../lib/state.mjs"
import { getAgent, loadThincoder, providerStatus, poolEntries } from "./thincoder.mjs"
import { diffForTool } from "./diff.mjs"
import * as rewind from "./rewind.mjs"
import * as subagents from "./subagents.mjs"
import { driveSuspension } from "./suspension.mjs"
import { injectFastReminder, removeFastReminder } from "./fast-mode.mjs"
import { recordUsage } from "../store/usage.mjs"
import {
  STALL_FORCE_MS, WATCH_INTERVAL_MS,
  armCompressJob, armLocalJob, baseName, clearCompressJob, clearLocalJob, clearScopeJobs,
  pickStallMs, pruneExpiredJobs, stallNotice, tokenProvesJobEnd,
} from "./watchdog.mjs"

const states = new Map() // projectDir -> run state
const pendingPerms = new Map() // reqId -> { resolve, project, name, args }
const pendingQuestions = new Map() // reqId -> { resolve, project }
const toolQueues = new Map() // project -> Map(fullName -> [callId])
const planActions = new Map() // project -> 最近一次 plan 工具的 action（enter/exit）
const recentResults = new Map() // callId -> 完整结果（供前端按需拉取，上限 200 条）
const runEndHooks = [] // 运行收尾回调（MCP 延迟热更新等；注册方在别的模块，避免循环依赖）

/** 注册「某项目一轮运行收尾（run_end 之后、队列续跑之前）」回调 */
export function onRunEnd(hook) {
  runEndHooks.push(hook)
}

export const MODES = ["suggest", "auto-edit", "full-auto"]
const AUTO_EDIT_AUTO = new Set(["write", "edit", "delete"]) // auto-edit 档免批的工具（基名）
const RESULT_PREVIEW_LIMIT = 8000

// 看门狗（坑 39/41：内核压缩调用不接 AbortSignal，网络停滞时"停止"叫不动）：阈值梯与停滞文案的
// 单点权威在 bridge/watchdog.mjs（基线 3 分钟 / 挂起期 10 分钟 / 本地作业豁免三档），本文件只用不定义。

function freshState() {
  return {
    busy: false, queue: [], abort: null, mode: "suggest", allowlist: new Set(),
    // 极速模式（单轮，用户用 /fast 授权；语义与文案见 bridge/fast-mode.mjs）——两态：
    //   fastArmed             = 已武装，等下一轮消费（此时**尚未**注入提醒）
    //   fastActive            = 本轮正在极速跑（轮首由 fastArmed 转入，轮末解除）
    //   modeBeforeFast        = 武装前的档位 = 「设置里的档位」（退出时恢复的目标）
    //   modeTouchedDuringFast = 极速期间用户手点改过档（真 ⇒ 退出时不覆盖用户的新选择）
    // 生命周期：轮首消费（armed → active）→ 轮末解除（endFastTurn）。两态分开的原因：挂起窗口里
    // 消费队列的是同一会话的**另一个用户回合**——它绝不许继承极速（否则未授权的消息免审批开跑）。
    fastArmed: false, fastActive: false, modeBeforeFast: null, modeTouchedDuringFast: false,
    // 挂起会话态：suspended = 驱动在跑（busy 保持 true）；suspCounts = 最近一次计数播报
    // （重连快照读它）；suspWake = 驱动等待栓的用户唤醒口（chat 落队列后兑现）
    suspended: false, suspCounts: null, suspWake: null,
    // 看门狗状态（jobs = 在飞的本地作业登记：主线条目按 callId 配对摘除、子代理条目按作用域摘，
    // 每条自带 until 到期；overdue = 过期但**从未收尾**者的病因留档，只服务停滞文案——
    // 判据与窗口见 bridge/watchdog.mjs）
    lastEventAt: 0, waitingHuman: false, dead: false, stall: false, deadline: 0, timer: null,
    jobs: new Map(),
    overdue: new Map(),
  }
}

function stateFor(project) {
  let st = states.get(project)
  if (!st) {
    st = freshState()
    states.set(project, st)
  }
  return st
}

/** 白名单校验：只允许项目清单内的目录（策划书 4.11） */
export function isKnownProject(dir) {
  return listProjects().some((p) => p.dir === dir)
}

// ================= 对外操作 =================

export function chat(project, text) {
  const st = stateFor(project)
  const msgId = randomUUID()
  st.queue.push({ text, msgId })
  bus.emit({ type: "queued", project, queued: st.queue.length })
  // 挂起会话期：新消息唤醒驱动（用户输入优先于消化轮——不必等下一次 settle）
  st.suspWake?.()
  pump(project)
  return msgId
}

/** 清空待发队列（会话回退时用：否则回退后队列里的消息会立刻执行，状态错乱） */
export function clearQueue(project) {
  const st = states.get(project)
  if (!st || st.queue.length === 0) return 0
  const n = st.queue.length
  st.queue.length = 0
  bus.emit({ type: "queued", project, queued: 0 })
  return n
}

/**
 * 会话回退期间独占项目：置 busy 阻止 pump 启动新运行，并摘走待发队列。
 * 回退是异步的多步文件操作，期间必须挡住新的 chat（多标签/多客户端场景）。
 */
export function beginExclusive(project) {
  const st = stateFor(project)
  if (st.busy) return null
  st.busy = true
  const carry = st.queue.slice()
  st.queue.length = 0
  return { carry }
}

export function endExclusive(project, carry) {
  const st = states.get(project)
  st.busy = false
  st.abort = null
  if (Array.isArray(carry) && carry.length) {
    st.queue = carry
    setImmediate(() => pump(project))
  }
}

export function abort(project) {
  const st = states.get(project)
  if (!st?.abort) return false
  if (!st.abort.signal.aborted) st.abort.abort()
  // 审批/提问挂起时 signal 叫不醒内核（内核 dispatch.mjs:302 权限 await 不接 signal）：
  // 把挂起的审批/提问就地落定——审批=拒绝、提问=停止应答，内核在最近的 signal 检查点抛
  // AbortError 正常收尾。幂等：settle 幂等 + 表删除后重复调用无效果。
  if (st.waitingHuman) {
    for (const [reqId, p] of pendingPerms) {
      if (p.project !== project) continue
      pendingPerms.delete(reqId)
      p.resolve(false)
      bus.emit({ type: "decision", project, reqId, allow: false, name: p.name, byStop: true })
    }
    for (const [reqId, q] of pendingQuestions) {
      if (q.project !== project) continue
      pendingQuestions.delete(reqId)
      q.resolve("（用户已停止运行）")
      bus.emit({ type: "answered", project, reqId, byStop: true })
    }
  }
  return true
}

export function isBusy(project) {
  return states.get(project)?.busy ?? false
}

/**
 * 档位落定（唯一落点）：写 st.mode + 同步池内 agent 的 autoApprove（审批档的内核面）+ 广播。
 * `internal` = 由极速模式自己驱动（进入/退出）：此时**不算**「用户手点改档」——否则退出恢复会把
 * 极速自己写的那次 full-auto 误记成用户意愿，modeBeforeFast 就永远回不去。
 */
function applyMode(project, st, mode, { internal } = {}) {
  st.mode = mode
  const entry = poolEntries().get(project)
  if (entry) entry.agent.autoApprove = mode === "full-auto"
  bus.emit({ type: "mode", project, mode })
  if (!internal && fastShown(st)) st.modeTouchedDuringFast = true
}

export function setMode(project, mode) {
  if (!MODES.includes(mode)) return false
  const st = stateFor(project)
  applyMode(project, st, mode)
  return true
}

/** 极速武装态广播（单点）：setFast / 轮末解除 / 强释路径共用——状态变了就必须广播，客户端只认事件。 */
function emitFast(project, armed) {
  bus.emit({ type: "fast", project, armed })
}

/** 对外可见的极速态（武装中或正在跑都该点亮徽标；口径与 snapshot().fast 一致）。
 *  注意消费时机：applyMode 的「用户手点改档」判定必须看这个合计值、而不是 st.fastArmed——
 *  轮中 fastArmed 已转 fastActive，只看 armed 会把用户的档位选择当成无效并在轮末覆盖。 */
function fastShown(st) {
  return Boolean(st?.fastArmed || st?.fastActive)
}

/**
 * 极速轮收尾（**唯一解除点**：runTurn 的轮末 finally；另供 finishSession 做异常路径的防御性清理）。
 * 摘提醒 → 恢复档位（用户手点过就不覆盖）→ 清元数据 → 广播 armed:false。
 * `t` 在场（轮末正常路径）时**补一次落盘**：机读线 contextHistory 会保留 transient（core/session.mjs:116），
 * 必须用摘净后的历史重写槽文件——否则陈旧提醒会在会话恢复后（恢复时原样装回机器线）此后每一轮都发给模型。
 */
function endFastTurn(project, st, t = null, agent = null) {
  if (!st.fastArmed && !st.fastActive) return
  st.fastArmed = false
  st.fastActive = false
  const live = agent ?? poolEntries().get(project)?.agent
  removeFastReminder(live)
  if (!st.modeTouchedDuringFast && MODES.includes(st.modeBeforeFast)) {
    applyMode(project, st, st.modeBeforeFast, { internal: true })
  }
  st.modeBeforeFast = null
  st.modeTouchedDuringFast = false
  emitFast(project, false)
  if (t && live) saveSessionSafe(t, live, project)
}

/**
 * 极速模式（单轮）——用户授权的提速档（WebUI 侧内存态，零内核改动；文案见 bridge/fast-mode.mjs）。
 *
 * armed=true：幂等。首次武装记住当前档位（= 「设置里的档位」：WebUI 的 mode 是每项目内存态、
 *   新会话回 suggest），临时把审批档推到 full-auto（本轮免审批）并令看门狗强制启用（armWatchdog 闸门）；
 *   **此时还没注入提醒**——下一条消息（用户回合）在轮首消费、轮末解除。
 * armed=false：用户撤装（或会话边界清除）。已武装未跑 ⇒ 立即兑现退出（恢复档位 + 摘提醒 + 广播）；
 *   正在跑（fastActive）⇒ 只清武装位，档位/提醒交给该轮轮末的 endFastTurn（运行中该命令本就
 *   被 /api/command 的 409 挡住，这条只是防御）。
 * 两向都**不写任何全局偏好**（审批档/看门狗一律仅本项目本轮的内存态，不落 state.json）。
 * 返回生效后的武装位（armed）。
 */
export function setFast(project, armed) {
  const st = stateFor(project)
  if (armed) {
    if (!st.fastArmed && !st.fastActive) {
      st.modeBeforeFast = st.mode
      st.modeTouchedDuringFast = false
      st.fastArmed = true
      applyMode(project, st, "full-auto", { internal: true })
    }
    emitFast(project, fastShown(st))
  } else if (st.fastActive) {
    st.fastArmed = false // 正在跑：档位/提醒交给该轮轮末的 endFastTurn
  } else {
    endFastTurn(project, st) // 已武装未跑（或本就非极速）：立即兑现退出（内部 early-return + 广播）
  }
  return st.fastArmed
}

/** 该项目当前是否处于极速模式（武装中或正在跑；未建状态的项目 = false） */
export function isFast(project) {
  return fastShown(states.get(project))
}

export function decidePermission(reqId, allow, remember) {
  const p = pendingPerms.get(reqId)
  if (!p) return false
  pendingPerms.delete(reqId)
  if (remember && allow) {
    const base = baseName(p.name)
    stateFor(p.project).allowlist.add(base)
  }
  p.resolve(allow)
  bus.emit({ type: "decision", project: p.project, reqId, allow, remember: Boolean(remember), name: p.name })
  return true
}

export function answerQuestion(reqId, answer) {
  const q = pendingQuestions.get(reqId)
  if (!q) return false
  pendingQuestions.delete(reqId)
  q.resolve(String(answer ?? ""))
  bus.emit({ type: "answered", project: q.project, reqId })
  return true
}

export function getToolResult(callId) {
  return recentResults.get(callId) ?? null
}

/** 方案文本提取：从后往前找携带 plan 工具调用且有正文的 assistant 消息 */
function extractPlanText(agent) {
  const history = agent.history ?? []
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m?.role !== "assistant" || !m.content) continue
    const hasPlanCall = (m.tool_calls ?? []).some((tc) => tc.function?.name === "plan")
    if (hasPlanCall) return String(m.content)
  }
  // 兜底：最后一条有正文的 assistant 消息
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]
    if (m?.role === "assistant" && m.content) return String(m.content)
  }
  return ""
}

/** SSE 连接时的状态快照 */
export function snapshot() {
  const projects = listProjects().map((p) => p.dir)
  const active = {}
  for (const dir of projects) {
    const st = states.get(dir)
    const entry = poolEntries().get(dir)
    active[dir] = {
      busy: st?.busy ?? false,
      queued: st?.queue.length ?? 0,
      mode: st?.mode ?? "suggest",
      fast: !!(st?.fastArmed || st?.fastActive),
      planMode: entry?.agent.planMode ?? false,
      provider: entry ? providerStatus(entry) : null,
      // 挂起会话态（重连一致性：挂起期 busy 必为 true，否则前端显空闲、服务端 409 闸门与显示不一致）
      suspended: st?.suspended ?? false,
      counts: st?.suspended ? (st.suspCounts ?? null) : null,
    }
  }
  return {
    projects,
    active,
    subagents: subagents.snapshotAll(),
    subagentStats: subagents.snapshotStatsAll(), // 0.9.0 进度统计（已派发/已结束/失败）
    pendingApprovals: [...pendingPerms.values()].map((p) => ({ reqId: p.reqId, project: p.project, name: p.name, args: p.args, diff: p.diff ?? null })),
    pendingQuestions: [...pendingQuestions.values()].map((q) => ({ reqId: q.reqId, project: q.project, question: q.question, options: q.options })),
  }
}

/** 物化某项目 agent（前端项目切换时调用），返回 provider 状态 + MCP 警告 */
export async function openProject(project) {
  const entry = await getAgent(project)
  const warnings = entry.mcpWarnings ?? []
  if (warnings.length && !entry._warned) {
    entry._warned = true
    bus.emit({ type: "system", project, text: `MCP 连接警告：\n${warnings.join("\n")}` })
  }
  return providerStatus(entry)
}

// ================= 内部执行 =================

function shouldPrompt(st, fullName) {
  const base = baseName(fullName)
  if (st.mode === "full-auto") return false
  if (st.allowlist.has(base)) return false
  if (st.mode === "auto-edit") return !AUTO_EDIT_AUTO.has(base)
  return true // suggest
}

async function pump(project) {
  const st = stateFor(project)
  if (st.busy || st.queue.length === 0) return
  st.busy = true
  const job = st.queue.shift()
  bus.emit({ type: "run_start", project, queued: st.queue.length, digest: false })

  // 盲区消灭：abort 控制器与看门狗在一切 await 之前就位。getAgent 组装（MCP 连接、
  // memory/team 同步）可能长时间挂起，那段窗口里停止按钮曾是空操作（st.abort 为 null）、
  // 看门狗也未装——同样的「转圈+停不掉」无人看护。早停的信号在 runAgent 首个检查点生效；
  // 组装真挂死则由看门狗按既有停滞→中止→强释路径兜底。
  const abortCtrl = new AbortController()
  st.abort = abortCtrl
  st.lastEventAt = Date.now()
  st.stall = false
  st.jobs.clear() // 跨轮复用同一 state：本轮从零起算（作业登记与病因留档都不跨回合）
  st.overdue.clear()
  toolQueues.set(project, new Map())
  armWatchdog(project, st)

  let agent = null
  const t = await loadThincoder()
  // relay 前缀文法注入（子代理事件流分流用；同步路径无法 await 动态 import——此处在 runAgent 前注入）
  subagents.useRelay(t.relay)
  try {
    const entry = await getAgent(project)
    agent = entry.agent
  } catch (err) {
    bus.emit({ type: "error", project, message: `agent 初始化失败：${err.message}` })
    finishTurn(project, st, agent, false)
    finishSession(project, st)
    return
  }

  // 子代理面板行跨轮累积（= 本会话的子代理活动记录）：后台子代理常活过父回合，行若在每轮起始
  // **无条件**清掉，它的进度（模型/轮次/当前工具）就随之丢失，迟到的报告也只能挂到空行上。
  // 于是清空分两条口径：① 会话边界无条件清——新建/切换会话（sessions.mjs）、回退（rewind.mjs）、
  // 移除项目（routes.mjs）；② 新一轮**用户**回合起点安全清（clearIfIdle：无活跃行 ∧ 无待消化行 ∧
  // 池内无 live 才清）——面板只反映本轮，用户不必在一堆历史行里找「本轮」。
  // 消化轮（suspension.mjs 的 runTurn digest=true）是同一会话内的自动轮，不走这里（它也不经 pump）。
  // 登记表另按终态行上限自裁（subagents.mjs 的 prune）。
  subagents.clearIfIdle(project, agent)

  // 会话回退：为"这条消息发出之前"的状态打点（工作区树快照 + 会话文件副本）。
  // 失败/降级都不阻塞运行，只提示。用户回合专用（消化轮是系统轮，不产生回退点）。
  const captureRewind = async (j) => {
    try {
      const r = await rewind.capture(project, { msgId: j.msgId, text: j.text })
      for (const w of r.warnings ?? []) bus.emit({ type: "system", project, text: w })
    } catch (err) {
      bus.emit({ type: "system", project, text: `会话回退打点失败（不影响本次运行）：${err.message}` })
    }
  }
  await captureRewind(job)

  // 看门狗心跳：任何内核回调都算"还活着"；zombie（dead）一律吞掉
  const touch = () => { st.lastEventAt = Date.now() }

  const callbacks = {
    onToken: (tok) => {
      // 死状态（看门狗强释后，见 forceRelease）：本轮一律丢弃——否则被弃用 agent 的迟到中继
      // 会把刚清场的面板行重新「复活」成一条永不收尾的 running
      if (st.dead) return
      // 带 relay 前缀（子代理中继）的 token 分流进「子代理」面板，不进会话流（心跳照旧）；
      // 但**摘除闸门**要过 `tokenProvesJobEnd`：`⟦ev⟧approval` 是工具**等待审批**时发的，
      // 此时该作用域的作业正 pending——拿它当结束信号会让刚登记的作业立刻消失（e2e T7 专钉）。
      if (subagents.routeToken(project, tok)) {
        if (tokenProvesJobEnd(tok)) clearScopeJobs(st, subagents.relayScopeOf(tok))
        touch()
        return
      }
      // 兜底：未带前缀的事件 token 是协议控制字符（⟦ev⟧…）——绝不进会话
      if (typeof tok === "string" && tok.startsWith("⟦ev⟧")) { touch(); return }
      touch()
      bus.emit({ type: "token", project, text: tok })
    },
    onReasoning: (tok) => {
      if (st.dead) return
      if (subagents.routeReasoning(project, tok)) { clearScopeJobs(st, subagents.relayScopeOf(tok)); touch(); return }
      touch()
      bus.emit({ type: "reasoning", project, text: tok })
    },
    onToolCall: (name, args, id) => {
      if (st.dead) return
      const at = Date.now()
      // 本地作业（execute / bash，含子代理中继的同名调用）需单独登记：该工具**全程无输出**时
      // 没有任何回调，看门狗无从得知它还在跑。判定与窗口见 bridge/watchdog.mjs。
      // 顺序：先摘同作用域的旧条目（同作用域内工具串行 ⇒ 新调用 = 旧作业已结束），再登记本次。
      const scope = subagents.relayScopeOf(name)
      clearScopeJobs(st, scope)
      if (!armLocalJob(st, at, scope, id, name, args)) touch() // 命中本地作业：函数内已记心跳
      if (subagents.routeToolCall(project, name, args)) return
      const callId = randomUUID()
      const queues = toolQueues.get(project)
      if (!queues.has(name)) queues.set(name, [])
      queues.get(name).push(callId)
      // M2：记录 plan 动作，供 tool_result 时判定模式切换与方案捕获
      const baseForPlan = baseName(name)
      if (baseForPlan === "plan" && args?.action) planActions.set(project, args.action)
      bus.emit({ type: "tool_call", project, callId, name, args })
    },
    onToolResult: (name, result, toolId, subKey) => {
      if (st.dead) return
      // 主线条目的本地作业：结果到达即摘（callId 配对——同批兄弟的结果不会误摘，它们是别的 id）
      clearLocalJob(st, subagents.relayScopeOf(name), toolId)
      // 同步子代理完成信号（dispatch 第 4 参 = `role#N`——depth-0 sync 子代理不发 ⟦ev⟧done，
      // 这是它唯一的完成通道）：只冻面板行，**不消费**主线事件
      subagents.routeSyncComplete(project, subKey, result)
      // 同步子代理（depth-0）内核**不发** `⟦ev⟧done`——上面那个 `subKey`（onToolResult 第 4 参）就是它唯一的
      // 收尾信号。此刻该子代理确实已结束 ⇒ 顺手摘掉它作用域的看门狗作业（否则它最后一条静默本地作业
      // 会留到 `until` 到期进病因留档、被误指成后续上游静默的病因）。幂等：无条目时 no-op；
      // 嵌套子代理的 scope 是完整前缀链（`eng-coder#2/explore#1/`），本行只覆盖 depth-0。
      if (subKey) clearScopeJobs(st, `${subKey}/`)
      if (subagents.routeToolResult(project, name, result)) { touch(); return }
      touch()
      const queues = toolQueues.get(project)
      const ids = queues?.get(name)
      const callId = ids?.length ? ids.shift() : randomUUID()
      const isError = typeof result === "string" && result.startsWith("Error")
      const preview = result.length > RESULT_PREVIEW_LIMIT ? result.slice(0, RESULT_PREVIEW_LIMIT) : result
      recentResults.set(callId, result)
      if (recentResults.size > 200) recentResults.delete(recentResults.keys().next().value)
      bus.emit({
        type: "tool_result", project, callId, name, isError,
        preview, truncated: result.length > RESULT_PREVIEW_LIMIT, fullLength: result.length,
      })
      // M2：plan 模式切换事件 + 方案捕获（方案文本 = 携带 plan exit 调用的 assistant 消息正文）
      const base = baseName(name)
      if (base === "plan" && !isError) {
        bus.emit({ type: "plan_mode", project, planMode: agent.planMode })
        if (planActions.get(project) === "exit" && !agent.planMode) {
          bus.emit({ type: "plan_presented", project, plan: extractPlanText(agent) })
        }
        planActions.delete(project)
      }
    },
    onToolOutput: (name, chunk) => {
      if (st.dead) return
      // 中继（子代理）分支：**只打心跳、不摘同作用域作业**——输出块来自**正在跑的**那个工具
      // （bash 边跑边吐），不是「后续事件」；若在这里 clearScopeJobs，子代理里「先打印几行再长时间静默」
      // 的长命令会把自己的豁免摘掉、按基线档被误杀（e2e T6 钉住；主线分支同理，见下一行）。
      if (subagents.routeToolOutput(project, name, chunk)) { touch(); return }
      touch()
      bus.emit({ type: "tool_output", project, name, chunk: String(chunk).slice(0, 4096) })
    },
    onPermissionRequest: (name, args) => {
      if (st.dead) return Promise.resolve(false)
      touch()
      if (!shouldPrompt(st, name)) return Promise.resolve(true)
      const reqId = randomUUID()
      // M1：文件变更类工具预生成 diff，随审批事件下发（失败不阻塞审批）
      const base = baseName(name)
      let diff = null
      if (base === "write" || base === "edit" || base === "delete") {
        diff = diffForTool(base, args, project)
      }
      bus.emit({ type: "permission_request", project, reqId, name, args, mode: st.mode, diff })
      return new Promise((resolve) => {
        st.waitingHuman = true // 等人是常态，不算停滞
        const settle = (v) => { st.waitingHuman = false; touch(); resolve(v) }
        pendingPerms.set(reqId, { resolve: settle, project, name, args, reqId, diff })
      })
    },
    onQuestion: (question, options) => {
      if (st.dead) return Promise.resolve("（运行已终止，无人应答）")
      touch()
      const reqId = randomUUID()
      bus.emit({ type: "question", project, reqId, question, options: options ?? [] })
      return new Promise((resolve) => {
        st.waitingHuman = true
        const settle = (v) => { st.waitingHuman = false; touch(); resolve(v) }
        pendingQuestions.set(reqId, { resolve: settle, project, reqId, question, options })
      })
    },
    onTaskUpdate: (items) => { if (!st.dead) { touch(); bus.emit({ type: "task_update", project, items }) } },
    onUsage: (usage) => {
      if (st.dead) return
      touch()
      bus.emit({ type: "usage", project, usage })
      // M3：用量落库（失败不阻塞主流程）
      try {
        recordUsage({
          project,
          provider: agent.provider?.name,
          model: agent.provider?.model,
          prompt_tokens: usage?.prompt_tokens,
          completion_tokens: usage?.completion_tokens,
          cache_hit: usage?.prompt_cache_hit_tokens,
          cache_miss: usage?.prompt_cache_miss_tokens,
        })
      } catch { /* 统计失败无碍运行 */ }
    },
    // 压缩的「开始」是内核在摘要调用**之前**发的唯一信号（该调用按设计静默、无超时）——豁免窗口的
    // 依据；失败也是事件 ⇒ 打心跳（用户可见面零改：压缩失败仍不上屏，与 onCompress 一样只发成功面）
    onCompressStart: () => { if (!st.dead) armCompressJob(st, Date.now()) },
    onCompressFail: () => { if (!st.dead) { clearCompressJob(st); touch() } },
    onCompress: () => { if (!st.dead) { clearCompressJob(st); touch(); bus.emit({ type: "compress", project }) } },
    onTurnEnd: () => {
      if (st.dead) return
      touch()
      saveSessionSafe(t, agent, project)
    },
  }

  // 消化轮回调（D3 静音 + 机械拒绝）：去掉权限/问答 handler 的一份——内核据此走
  // 「无 onPermissionRequest ⇒ allowed=false（不弹窗、不悬挂）」「无 onQuestion ⇒ 抛错」
  // （dispatch.mjs / tools/question.mjs），= CLI 手动档 askPermission/askBatchPermission/
  // askQuestion 三 null 的等价装配。其余展示回调（token/工具/用量…）照旧，消化轮正文正常上屏。
  const digestCallbacks = { ...callbacks, onPermissionRequest: undefined, onQuestion: undefined }

  // 挂起会话驱动可用性（内核面缺失 = 旧内核）：两处同判——不传 suspDriven（否则 settled 只留池、
  // 无人消化）+ 不进挂起会话，整体退回今日的 headless 档。
  const canSuspend = Boolean(t.suspension)

  /**
   * 回合执行器（用户回合 / 挂起期用户回合 / 消化轮统一入口）：
   * - 用户回合：普通语义（callbacks 全档、suspDriven 恒为 canSuspend）——挂起会话里的用户回合
   *   由驱动把 `agent._suspended` 翻 false（settle 即冻结 + 条目留池），与普通回合一致；
   * - 消化轮（autoTurn）：空输入 + 去权限/问答回调；撞轮数上限时手动档静默停（部分消化留在
   *   历史、会话回挂起，system 明示）/ full-auto 档照 CLI 自动续跑；
   * - 每轮收尾：saveSession + finishTurn（面板同步 + run_end，带 digest 标记）。
   * `started`：本轮 run_start / 回退打点已由 pump 提前做过（首个用户回合——早发 run_start 让
   * 前端立刻进入运行态，不等 agent 组装/MCP 连接）。
   */
  const runTurn = async (j, { digest = false, started = false, upstreamTurn = false } = {}) => {
    if (!started) {
      bus.emit({ type: "run_start", project, queued: st.queue.length, digest })
      if (!digest) await captureRewind(j)
    }
    const signal = st.abort?.signal ?? abortCtrl.signal
    const base = { signal, autoTurn: digest, upstreamTurn, suspDriven: canSuspend }
    if (!digest) {
      // 极速轮的两端都在这里：**轮首消费**（armed → active）+ 紧随其后的**自愈摘除**——
      // 先无条件摘掉历史里可能存在的提醒（上一轮若崩在极速轮里，机读线会把陈旧提醒装回历史），
      // 于是不变量成立：历史里有该提醒 ⇔ 正在极速轮中，且每轮至多一条。
      if (st.fastArmed) { st.fastArmed = false; st.fastActive = true }
      removeFastReminder(agent)
      try {
        // 极速模式提醒：本轮唯一注入点（瞬时注入，不进时间线；见 bridge/fast-mode.mjs）
        if (st.fastActive) injectFastReminder(agent)
        await t.agent.runAgent(agent, j.text, callbacks, base)
        if (!st.dead) bus.emit({ type: "done", project })
      } catch (err) {
        reportRunError(project, st, signal, err)
      } finally {
        if (!st.dead) {
          saveSessionSafe(t, agent, project)
          // 本回合是否**即将进入挂起会话**（判定与服务端进驱动那一处同源）：随 run_end 下发，
          // 前端据此跳过追问建议旁路——挂起期会话忙（409），那条请求注定空返。
          // 必须在**本回合收尾时**算：`suspension{active:true}` 晚于 run_end 发出，前端那一刻
          // 还不知道会不会挂起（所以前端单靠 `!suspended` 挡不住这条）。
          const suspending = canSuspend && t.suspension.poolLive(agent)
          finishTurn(project, st, agent, false, suspending)
          // **轮末解除**（唯一解除点）：必须赶在挂起驱动之前——挂起窗口里消费队列的是同一会话的
          // 另一个用户回合，它不得继承极速（无注入、档位已回设置值、看门狗闸门回全局偏好）。
          endFastTurn(project, st, t, agent)
        }
      }
      return
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await t.agent.runAgent(agent, "", digestCallbacks, { ...base, resume: attempt > 0 })
        break
      } catch (err) {
        if (err?.name !== "ContinueError") {
          reportRunError(project, st, signal, err)
          break
        }
        // 轮数上限：full-auto（无人值守授权）自动续跑；手动档静默停——部分消化已在历史里
        if (agent.autoApprove && !st.dead && !signal.aborted) continue
        if (!st.dead) {
          bus.emit({
            type: "system", project,
            text: `后台报告消化达到轮数上限（${err.turn} 轮），本轮消化停止；已读入的部分留在会话历史，下一条消息可继续推进`,
          })
        }
        break
      }
    }
    if (!st.dead) {
      saveSessionSafe(t, agent, project)
      finishTurn(project, st, agent, true)
    }
  }

  try {
    await runTurn(job, { started: true })
  } finally {
    // 看门狗**不在此处摘**：挂起窗口（下面那段）必须仍有停滞看护——清理权交给 finishSession
    // （会话真正收尾），阈值由 armWatchdog 按阈值梯取档（挂起期 / 本地作业豁免，见 watchdog.mjs）。
    // 早摘的代价：挂起期（含消化轮自身那条长 LLM 调用）完全失去自动中止，池项永不 settle 时
    // 会话永久 busy（只能手点 Stop）；`st.suspended` 分支也会因定时器已死而恒不可达。
    if (!st.dead) {
      saveSessionSafe(t, agent, project)
      // 回合结束后台池仍 live ⇒ 进入挂起会话（会话级 busy 保持 true）：池项 settle 即自动开
      // 消化轮把报告读进会话，池空自然退出；用户 Stop ⇒ 会话 controller 中止 ⇒ 驱动清场。
      if (canSuspend && !abortCtrl.signal.aborted && t.suspension.poolLive(agent)) {
        await driveSuspension({ project, st, agent, t, runTurn })
      }
      finishSession(project, st)
    }
  }
}

/** 运行期错误 → 事件（用户回合 / 消化轮共用；zombie 运行一律静默丢弃）。 */
function reportRunError(project, st, signal, err) {
  if (st.dead) return // zombie 运行（已被强制释放）：一切收尾都不再属于当前状态
  if (signal?.aborted) bus.emit({ type: "aborted", project })
  else if (err?.name === "ContinueError") bus.emit({ type: "paused", project, message: `达到轮数上限（${err.turn} 轮），任务已暂停，可继续对话推进` })
  else bus.emit({ type: "error", project, message: err?.message ?? String(err) })
}

/**
 * 回合收尾（每轮一次，含消化轮）：把异步子代理的最终报告挂到面板 + 按内核池校正状态
 * （两层自身 try/catch，这里再加一层——报告同步的任何意外不得影响 run_end 协议）→ 广播 run_end。
 * `digest` 标记区分「用户回合」与「自动消化轮」——前端据此跳过完成音 / 追问建议（机制静音）。
 */
function finishTurn(project, st, agent = null, digest = false, suspending = false) {
  if (st.dead) return
  try {
    subagents.syncReports(project, agent)
    subagents.reconcilePool(project, agent)
  } catch { /* 子代理收尾失败不阻塞运行收尾 */ }
  bus.emit({ type: "run_end", project, queued: st.queue.length, digest, suspending })
}

/**
 * 会话收尾（pump 退出 / agent 初始化失败早退 / 挂起会话结束）：释放运行态 + 收尾钩子 + 队列续跑。
 * 与 finishTurn 分离的原因：消化轮是同一会话内的轮次，不能每轮都触发收尾钩子（mcp.flushDirty）
 * 或提前把 busy 放开（挂起期必须保持 busy——会话切换/回退/斜线命令的 409 闸门靠它）。
 */
function finishSession(project, st) {
  if (st.dead) return
  st.busy = false
  st.abort = null
  st.suspended = false // 双保险（驱动 finally 已复位；异常路径不得留下「挂起中」）
  st.suspWake = null
  st.suspCounts = null
  if (st.timer) { clearInterval(st.timer); st.timer = null } // 初始化失败早退路径也会带走看门狗
  for (const hook of runEndHooks) {
    try { hook(project) } catch { /* 收尾钩子失败不阻塞队列 */ }
  }
  // 极速防御性清理（正常路径已在 runTurn 的轮末 finally 解除）：异常/早退路径不得留下脏值
  if (st.fastArmed || st.fastActive) endFastTurn(project, st)
  if (st.queue.length > 0) setImmediate(() => pump(project))
}

// ================= 看门狗 =================

function armWatchdog(project, st) {
  st.timer = setInterval(() => {
    if (st.dead || !st.busy) {
      if (st.timer) { clearInterval(st.timer); st.timer = null }
      return
    }
     // 超时控制开关（设置 → 性能；默认开）——闸门只此一处，热生效（每跳重读偏好，不重启）。
    // 关闭态：不检测、不中止、不做叫不动时的兜底强释（`st.deadline` 永不启动），一切交回内核超时。
    // 同时把心跳与停滞态复位：关闭期间 `st.lastEventAt` 会越来越旧、`st.stall` 可能停在真，
    // 不复位则「关→开」的下一跳会立刻判停滞（甚至直接走强释分支）——就成了「一开就杀」。
    // 极速轮强制启用（本批新语义）：不看全局偏好，极速的那一轮必须有停滞看护（武装未跑时无影响：
    // 看门狗只在 busy 时跳）。只影响本轮、热生效（每跳重读两态，不改全局开关、不落盘），退出即回设置值。
    if (!(st.fastArmed || st.fastActive || getWatchdogEnabled())) {
      const now = Date.now()
      st.lastEventAt = now
      st.stall = false
      st.deadline = 0
      return
    }
    if (st.waitingHuman) return // 在等人审批/回答：不是停滞
    const now = Date.now()
    pruneExpiredJobs(st, now) // 过期作业不再参与判据（纯卫生）
    // 阈值梯（基线 / 挂起期 / 在飞的本地作业）与停滞文案的单点权威在 bridge/watchdog.mjs：
    // 判据不变（任何内核回调 touch() 续命），只是窗口按「这段静默里有没有本地作业在跑」取档。
    const stallMs = pickStallMs(st, now)
    if (!st.stall) {
      if (now - st.lastEventAt < stallMs) return
      st.stall = true
      st.deadline = now + STALL_FORCE_MS
      bus.emit({ type: "system", project, text: stallNotice(st, now) })
      try { st.abort?.abort() } catch { /* 忽略 */ }
      return
    }
    if (now >= st.deadline) forceRelease(project, st)
  }, WATCH_INTERVAL_MS)
}

/** 中止都叫不动的 zombie 运行（内核压缩无 signal）：整对象弃用 + agent 丢弃重建，救回队列 */
function forceRelease(project, st) {
  if (st.timer) { clearInterval(st.timer); st.timer = null }
  st.dead = true
  st.busy = false
  st.abort = null
  // 挂起驱动可能正停在「等 settle / wake / abort」上：强释路径（今天恒由看门狗先 abort 触发）
  // 也必须兑现一次唤醒——否则 `st.dead` 只在循环头可见，驱动永远醒不过来（挂起胶囊粘住 +
  // 会话永不收尾）。显式唤醒后驱动走它已有的 st.dead 退场分支（跳过残差注入与面板收尾）。
  st.suspWake?.()
  const carry = st.queue.slice()
  st.queue.length = 0
  // 极速解除的另一半（摘提醒）必须赶在弃用池项之前——被弃的 agent 活历史里仍留着本轮提醒
  if (st.fastArmed || st.fastActive) removeFastReminder(poolEntries().get(project)?.agent)
  poolEntries().delete(project) // 弃用卡死 agent；下个 run 会 getAgent 重建并从落盘会话恢复
  const fresh = freshState()
  // 档位算法：本轮已死 ⇒ freshState 不继承 fast 两态（默认 false），但退出恢复要替它兑现——
  // 极速轮期间（**含「已武装、尚未轮首消费」那一小段**：武装时 st.mode 已被推成 full-auto）没被用户
  // 手点改档 ⇒ 恢复 modeBeforeFast（= 「设置里的档位」），否则保留 st.mode。
  // 判据与 endFastTurn 的两态同源（:194）——只看 fastActive 会让「武装后立刻强释」把档位永久停在 full-auto。
  // （池项已被丢弃，autoApprove 由下次 getAgent 重建，属既有行为，本批不改。）
  fresh.mode = (st.fastActive || st.fastArmed) && st.modeBeforeFast && !st.modeTouchedDuringFast ? st.modeBeforeFast : st.mode
  fresh.allowlist = st.allowlist
  fresh.queue = carry
  states.set(project, fresh)
  // 极速在这条路径上同样算「退出」（本轮已死 ⇒ 新状态不继承武装，档位已按上式算好）：
  // **状态变了就必须广播**——客户端档位靠 mode 事件、极速徽标靠 fast 事件，快照只在 SSE 建连时下发。
  if (st.fastArmed || st.fastActive) emitFast(project, false)
  if (fresh.mode !== st.mode) bus.emit({ type: "mode", project, mode: fresh.mode })
  bus.emit({ type: "error", project, message: "运行停滞且中止无效（已知内核压缩调用不接 AbortSignal 的缺陷），已强制释放；下一条消息将自动从上次落盘的会话继续（可在设置 → 性能 → 超时控制 中关闭）" })
  // zombie 运行不再走 finishRun（st.dead）——活跃行就地落 ended（终态行保留：面板行是会话级
  // 活动记录），免停在 running/转圈；此后该 agent 的一切回调已被 st.dead 闸门丢弃，不会复活行
  subagents.reconcilePool(project, null)
  bus.emit({ type: "run_end", project, queued: carry.length, digest: false, suspending: false }) // 与正常收尾协议一致：前端靠 run_end 复位 running
  if (carry.length > 0) setImmediate(() => pump(project))
}

/** 会话落盘（内核 saveSession 直写活动槽文件；失败不阻塞运行） */
function saveSessionSafe(t, agent, project) {
  if (!agent) return
  try {
    t.session.saveSession(agent)
  } catch { /* 保存失败不阻塞运行 */ }
}
