/**
 * bridge/suspension.mjs — 挂起会话驱动（回合结束后台池仍 live ⇒ 服务端自动开消化轮）
 *
 * 背景：用户回合结束后后台子代理仍在跑；子代理跑完、报告生成，WebUI 此前不把报告读进会话——
 * 时间线不出现新内容，要等用户再发消息才可能接续。根因 = 内核的「挂起会话 / 消化轮」机制
 * WebUI 从未接入（runner 调 runAgent 未传 suspDriven ⇒ 落内核 headless 回退档，settle 报告
 * 只能在**下一次用户 run 的收尾**被注入，模型再下一轮才读到）。
 *
 * 装配（逐条移植 CLI 参考实现 tui/suspension-drive.mjs 的循环；判据/清场/注入全部取内核单点）：
 * - 载体 = `agent`（内核按 `_asyncSubagents` / `_asyncAdvisors` / `_consultSessions` /
 *   `_pendingAsyncResults` / `_suspended` 读，全 `?.` 空安全）；
 * - 会话 signal = `st.abort`（挂起期不置 null ⇒ 现有 `/api/abort` 即「会话级 Stop」）；
 * - 消化轮由调用方（runner 的 runTurn）用**去掉权限/问答 handler** 的一份回调执行：写盘/命令被
 *   机械拒绝（内核 dispatch.mjs 无 `onPermissionRequest` ⇒ `allowed=false` 不弹窗不悬挂；
 *   tools/question.mjs 无 `onQuestion` ⇒ 抛错），其余展示回调照旧；
 * - 注入由内核 runAgent 首行完成（`_pendingAsyncResults` 按 role 分发）——本模块只负责「把条目
 *   交到那个容器里」（settle 回调 + sweep）与退出清场，不自建第二注入点。
 *
 * 状态机（输入源映射：CLI 的 `state.pendingInput` 单槽 → WebUI 的 `st.queue`。行为等价：
 * 用户输入优先；中止时消息留在队列，会话收尾后照常执行 ⇒ 零丢失）：
 *   进入：`st.suspended` / `agent._suspended` 置位 + `agent._sessionSignal` 指会话 controller
 *         + 广播 `suspension{active:true, counts}`
 *   循环：⓵ `st.dead` 强释僵尸 ⇒ 立即退场
 *         ⓶ `sweepSettledToPending` 幂等补扫（回合边界竞态）
 *         ⓷ 用户输入优先：`st.queue` 非空 ⇒ shift ⇒ 用户回合（`_suspended` 翻 false 再翻回）
 *         ⓸ pending 非空 ‖ `upstreamWaiting` ⇒ 消化轮 / 上行唤醒轮
 *         ⓹ `!poolLive` ⇒ 自然退出（idle）
 *         ⓺ 等下一次 settle / 用户输入唤醒 / 中止（`waitForSettleOrWake`）
 *   退出 finally：aborted ⇒ discardAbortedPool/Advisors + 清 pending 容器 + cleanupConsultSessions
 *                        + 队列残留去向明示；idle ⇒ 残差按 role 注入 + 逐条 releaseSettledEntry；
 *                两路都复位标志 + `syncReports`/`reconcilePool` + 广播 `suspension{active:false}`。
 *
 * **不使用**内核的 `startSuspension`（core/agent/suspension.mjs）：其 abort 清场是无差别
 * `.clear()`——被清条目不留终态、无提醒、无事件，模型只能猜「报告到底到没到」，而
 * async-discard.mjs 头注释把无差别清池明确定义为**已修缺陷**。这里的中止清场走 async-discard
 * 的「只清已死 + 墓碑 + 整批一次模型可见提醒」单点。
 *
 * 载体字段（`agent`）：
 * - `_suspended`：挂起会话期 true；会话内的用户回合执行期 false（普通回合语义 = settle 即冻结
 *   + 条目留池），退出复位——内核 settle 分流（async-settle.mjs）按此字段决定「移交 pending」
 *   还是「⟦ev⟧done 留池」；
 * - `_sessionSignal`：挂起期 = 会话 controller.signal（会话内 spawn 的 children 共享——
 *   async-settle.mjs 的 buildChildSignal 单点），退出置 null；
 * - `_asyncWaiters`：settle / 上行 ask 入队的唤醒栓（内核 wakeAsyncWaiters 兑现）。
 */

import * as bus from "../lib/bus.mjs"
import * as subagents from "./subagents.mjs"

// ================= 内部工具 =================

/** 广播挂起态（进入 / 计数变化 / 退出三处唯一出口；`st.suspCounts` 供重连快照读取）。 */
function emitSuspension(project, st, active, counts) {
  st.suspCounts = counts ?? null
  try {
    bus.emit({ type: "suspension", project, active, counts: counts ?? null })
  } catch { /* 广播失败不阻塞驱动 */ }
}

/** 后台计数（内核 backgroundCounts；读失败就当空——绝不因计数面拖垮驱动）。 */
function countsOf(s, agent) {
  try {
    return s.backgroundCounts(agent)
  } catch {
    return { running: 0, queued: 0, pending: 0, done: 0 }
  }
}

/**
 * 等下一次 settle（池项完成——内核 settle 尾部 `wakeAsyncWaiters` 唤醒）或用户唤醒
 * （`st.suspWake`——chat 落队列后调用）或会话中止（`st.abort` 信号），三态先到先得。
 *
 * 内核同名函数（core/agent/suspension.mjs）是模块私有，故宿主自实现（同款结构：单槽
 * `st.suspWake` + `agent._asyncWaiters` 注册 + abort 监听兜底，cleanup 摘除全部注册）。
 */
function waitForSettleOrWake(agent, st) {
  return new Promise((resolve) => {
    let finished = false
    const onSettle = () => finish("settle")
    const onAbort = () => finish("aborted")
    const cleanup = () => {
      st.suspWake = null
      const i = (agent._asyncWaiters ?? []).indexOf(onSettle)
      if (i >= 0) agent._asyncWaiters.splice(i, 1)
      st.abort?.signal?.removeEventListener("abort", onAbort)
    }
    const finish = (why) => {
      if (finished) return
      finished = true
      cleanup()
      resolve(why)
    }
    ;(agent._asyncWaiters ??= []).push(onSettle)
    st.suspWake = () => finish("wake")
    const signal = st.abort?.signal
    // 依赖注入不进这里：先到先得——已中止则立即兑现，否则挂监听（once——兑现即摘）
    if (signal?.aborted) { onAbort(); return }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

// ================= 驱动 =================

/**
 * 挂起会话驱动：由 runner 在「用户回合结束 + 后台池仍 live」时进入，池空 / 中止时退出。
 *
 * @param {object}   o
 * @param {string}   o.project 项目目录（事件广播用）
 * @param {object}   o.st      服务端运行态（busy/queue/abort/suspended/suspWake/dead…）
 * @param {object}   o.agent   池内共享 agent（载体）
 * @param {object}   o.t       内核模块集合（`t.suspension` = 挂起面，缺失即本模块不会被调用）
 * @param {Function} o.runTurn 回合执行器：`(job, { digest, upstreamTurn }) => Promise<void>`——
 *                             runner 装配（run_start/runAgent/run_end + 回合收尾）；
 *                             `job` = `{ text, msgId }`（消化轮传空文本）
 */
export async function driveSuspension({ project, st, agent, t, runTurn }) {
  const s = t.suspension
  st.suspended = true
  agent._suspended = true
  agent._sessionSignal = st.abort?.signal ?? null
  emitSuspension(project, st, true, countsOf(s, agent))
  try {
    while (true) {
      // ⓵ 强释僵尸（看门狗 forceRelease）/ 会话已中止：驱动立即退场——中止后绝不再开新回合
      //   （否则队列消息会在已中止的会话里被当成用户回合消费掉，会话级 Stop 语义被破坏）
      if (st.dead || st.abort?.signal?.aborted === true) break
      // ⓶ 回合边界竞态补扫（幂等：`_inPending` 防重）
      try { s.sweepSettledToPending(agent) } catch { /* 池读取异常不拖垮驱动 */ }
      // 计数变化广播（状态行 / 胶囊数据面；值未变也发——幂等小事件，前端按值渲染）
      if (!st.dead) emitSuspension(project, st, true, countsOf(s, agent))
      // ⓷ 用户输入优先（CLI D-S5）：队列非空 ⇒ 先跑用户回合，报告留到其后的消化轮
      if (st.queue.length > 0) {
        const job = st.queue.shift()
        agent._suspended = false // 用户回合 = 普通回合语义（settle 即冻结 + 条目留池）
        try {
          await runTurn(job, {})
        } finally {
          agent._suspended = true
        }
        continue
      }
      // ⓸ pending 非空 ‖ 存在未 drain 的上行 ask → 消化轮 / 唤醒轮（谓词必须先于第 ⓹ 步退出判：
      //    「池空 + 队列留 ask」仍须开一轮把它 drain 出来）
      const upstream = (() => { try { return s.upstreamWaiting(agent) } catch { return false } })()
      if ((agent._pendingAsyncResults?.length ?? 0) > 0 || upstream) {
        await runTurn({ text: "", msgId: null }, { digest: true, upstreamTurn: upstream })
        continue
      }
      // ⓹ 池空（无 running/queued/未注入）⇒ 自然退出
      if (!s.poolLive(agent)) break
      // ⓺ 等下一次 settle / 用户唤醒 / 中止（先到先得）
      if (await waitForSettleOrWake(agent, st) === "aborted") break
    }
  } finally {
    const aborted = st.abort?.signal?.aborted === true
    agent._suspended = false
    agent._sessionSignal = null
    st.suspWake = null
    st.suspended = false
    if (aborted) {
      // 中止清场（「只清已死」单点）：墓碑 + 出池 + 队列剔除 + 整批一次模型可见提醒；
      // 存活 / 已 settle 者留池。陈旧结果一律不注入（用户显式停）。
      try {
        s.discardAbortedPool(agent)
        s.discardAbortedAdvisors(agent)
      } catch { /* 清场异常不阻塞退出 */ }
      agent._pendingAsyncResults = []
      try { s.cleanupConsultSessions(agent) } catch { /* 会诊会话清理失败不阻塞退出 */ }
      // 挂起期入队的消息不静默丢：留在 st.queue（会话收尾后 pump 照常执行），去向明示
      if (!st.dead && st.queue.length > 0) {
        try {
          bus.emit({ type: "system", project, text: `后台工作已停止；挂起期入队的 ${st.queue.length} 条消息照常执行` })
        } catch { /* 广播失败不阻塞退出 */ }
      }
    } else if (!st.dead) {
      // idle 退出残差（极端竞态：刚 settle 就被判池空）：按 role 分发注入再退——结果零丢失
      // （内核 runAgent 首行同款分发；注入后逐条 releaseSettledEntry 释放 held 引用）
      const residual = agent._pendingAsyncResults
      if (residual?.length) {
        for (const e of residual.splice(0)) {
          try {
            if (e.role === "consult") await s.injectConsultResult(agent, e)
            else await s.injectAsyncResult(agent, e)
          } catch { /* 单条注入失败不阻塞其余残差 */ }
          try { s.releaseSettledEntry(e) } catch { /* 释放幂等 */ }
        }
      }
    }
    if (!st.dead) {
      // 面板收尾（报告挂行 + 按内核池校正）——与回合收尾同源的两层静默降级
      try {
        subagents.syncReports(project, agent)
        subagents.reconcilePool(project, agent)
      } catch { /* 面板收尾失败不阻塞退出 */ }
    }
    // 退出广播：**不**加 `st.dead` 闸——它是项目级状态播报（挂起已结束），漏发会让前端
    // 「挂起中」胶囊永久粘住；僵尸运行的 agent 内容早已被 st.dead 闸拦在别处
    emitSuspension(project, st, false, st.dead ? null : countsOf(s, agent))
  }
}