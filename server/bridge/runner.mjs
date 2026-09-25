/**
 * bridge/runner.mjs — runAgent 编排：单飞 / 排队 / 中断 / 事件映射 / 审批挂起
 *
 * 每个项目独立状态：{ busy, queue, abort, mode, allowlist }
 * 审批三档（策划书 4.4）：suggest（全问）/ auto-edit（写盘免批，bash 问）/ full-auto（等价内核 AUTO）
 */

import { randomUUID } from "node:crypto"
import * as bus from "../lib/bus.mjs"
import { listProjects } from "../lib/state.mjs"
import { getAgent, loadThincoder, providerStatus, poolEntries } from "./thincoder.mjs"
import { diffForTool } from "./diff.mjs"
import * as rewind from "./rewind.mjs"
import * as subagents from "./subagents.mjs"
import { driveSuspension } from "./suspension.mjs"
import { recordUsage } from "../store/usage.mjs"

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

// 看门狗（坑 39/41：内核压缩调用不接 AbortSignal，网络停滞时"停止"叫不动）
const STALL_MS = Number(process.env.TCW_STALL_MS ?? 180_000) // 无任何事件多久算停滞（默认 3 分钟）
// 挂起期阈值（D5）：挂起会话没有用户输入，但池里可能长时间在跑超长工具 / 慢首 token / 排队静默
// ——普通阈值会误杀。判据不变（任何内核回调 touch() 续命），只是窗口放宽到 10 分钟。
const SUSPEND_STALL_MS = Number(process.env.TCW_SUSPEND_STALL_MS ?? 600_000)
const STALL_FORCE_MS = Number(process.env.TCW_STALL_FORCE_MS ?? 15_000) // 停滞中止后多久仍未结束 → 强制释放
const WATCH_INTERVAL_MS = Math.max(1000, Math.min(20_000, Math.floor(STALL_MS / 4)))

function freshState() {
  return {
    busy: false, queue: [], abort: null, mode: "suggest", allowlist: new Set(),
    // 挂起会话态：suspended = 驱动在跑（busy 保持 true）；suspCounts = 最近一次计数播报
    // （重连快照读它）；suspWake = 驱动等待栓的用户唤醒口（chat 落队列后兑现）
    suspended: false, suspCounts: null, suspWake: null,
    // 看门狗状态
    lastEventAt: 0, waitingHuman: false, dead: false, stall: false, deadline: 0, timer: null,
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

export function setMode(project, mode) {
  if (!MODES.includes(mode)) return false
  const st = stateFor(project)
  st.mode = mode
  const entry = poolEntries().get(project)
  if (entry) entry.agent.autoApprove = mode === "full-auto"
  bus.emit({ type: "mode", project, mode })
  return true
}

export function decidePermission(reqId, allow, remember) {
  const p = pendingPerms.get(reqId)
  if (!p) return false
  pendingPerms.delete(reqId)
  if (remember && allow) {
    const base = p.name.includes("/") ? p.name.split("/").pop() : p.name
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
  const base = fullName.includes("/") ? fullName.split("/").pop() : fullName
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
      // 带 relay 前缀（子代理中继）的 token 分流进「子代理」面板，不进会话流（心跳照旧）
      if (subagents.routeToken(project, tok)) { touch(); return }
      // 兜底：未带前缀的事件 token 是协议控制字符（⟦ev⟧…）——绝不进会话
      if (typeof tok === "string" && tok.startsWith("⟦ev⟧")) { touch(); return }
      touch()
      bus.emit({ type: "token", project, text: tok })
    },
    onReasoning: (tok) => {
      if (st.dead) return
      if (subagents.routeReasoning(project, tok)) { touch(); return }
      touch()
      bus.emit({ type: "reasoning", project, text: tok })
    },
    onToolCall: (name, args) => {
      if (st.dead) return
      if (subagents.routeToolCall(project, name, args)) { touch(); return }
      touch()
      const callId = randomUUID()
      const queues = toolQueues.get(project)
      if (!queues.has(name)) queues.set(name, [])
      queues.get(name).push(callId)
      // M2：记录 plan 动作，供 tool_result 时判定模式切换与方案捕获
      const baseForPlan = name.includes("/") ? name.split("/").pop() : name
      if (baseForPlan === "plan" && args?.action) planActions.set(project, args.action)
      bus.emit({ type: "tool_call", project, callId, name, args })
    },
    onToolResult: (name, result, toolId, subKey) => {
      if (st.dead) return
      // 同步子代理完成信号（dispatch 第 4 参 = `role#N`——depth-0 sync 子代理不发 ⟦ev⟧done，
      // 这是它唯一的完成通道）：只冻面板行，**不消费**主线事件
      subagents.routeSyncComplete(project, subKey, result)
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
      const base = name.includes("/") ? name.split("/").pop() : name
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
      const base = name.includes("/") ? name.split("/").pop() : name
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
    onCompress: () => { if (!st.dead) { touch(); bus.emit({ type: "compress", project }) } },
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
      try {
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
    // （会话真正收尾），阈值由 armWatchdog 按 `st.suspended` 取放宽档（TCW_SUSPEND_STALL_MS）。
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
  if (st.queue.length > 0) setImmediate(() => pump(project))
}

// ================= 看门狗 =================

function armWatchdog(project, st) {
  st.timer = setInterval(() => {
    if (st.dead || !st.busy) {
      if (st.timer) { clearInterval(st.timer); st.timer = null }
      return
    }
    if (st.waitingHuman) return // 在等人审批/回答：不是停滞
    const now = Date.now()
    // 挂起期阈值放宽（D5）：判据不变（任何内核回调 touch() 续命），只是窗口取 SUSPEND_STALL_MS
    const stallMs = st.suspended ? Math.max(STALL_MS, SUSPEND_STALL_MS) : STALL_MS
    if (!st.stall) {
      if (now - st.lastEventAt < stallMs) return
      st.stall = true
      st.deadline = now + STALL_FORCE_MS
      bus.emit({ type: "system", project, text: `${stallMs >= 60_000 ? `${Math.round(stallMs / 60000)} 分钟` : `${Math.round(stallMs / 1000)} 秒`}无任何事件（疑似网络/上游停滞），正在自动中止…` })
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
  poolEntries().delete(project) // 弃用卡死 agent；下个 run 会 getAgent 重建并从落盘会话恢复
  const fresh = freshState()
  fresh.mode = st.mode
  fresh.allowlist = st.allowlist
  fresh.queue = carry
  states.set(project, fresh)
  bus.emit({ type: "error", project, message: "运行停滞且中止无效（已知内核压缩调用不接 AbortSignal 的缺陷），已强制释放；下一条消息将自动从上次落盘的会话继续" })
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
