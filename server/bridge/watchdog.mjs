/**
 * bridge/watchdog.mjs — 运行停滞看门狗的**阈值梯 + 本地作业登记 + 文案**（单点权威）
 *
 * 判据（不变）：一次运行里多久没收到任何内核回调（`touch()` 心跳）算停滞 → 自动中止；
 * 再过 `STALL_FORCE_MS` 仍未收尾 → 强制释放。心跳挂点仍在 `bridge/runner.mjs` 的 callbacks。
 * **整套提前中止受设置开关「超时控制」控制（默认开）**：关闭 = 本文件的阈值梯/判据/文案
 * 一律不予执行（闸门在 runner 的 tick 顶部，关闭态连强释也不做）——那一切交回内核超时。
 *
 * 梯子（取**满足条件者里的最大档**）：
 *  ① 基线 `STALL_MS`（3 分钟）——纯等上游：首 token 前排队/慢启动、流中途断供。
 *     上游没有任何本地兜底，只能靠它兜；也覆盖 agent 组装/回退打点那两段静默。
 *  ② 挂起期 `SUSPEND_STALL_MS`（10 分钟，D5）——挂起窗口内无人输入，池里可能在跑长活。
 *  ③ **本地作业**：屏幕上的静默来自一个「本地在跑、自己有超时」的作业，不是卡住：
 *     - `execute`：内核允许 `timeoutMs` 到 **600s**，且该工具**全程无输出流**（没有心跳来源）。
 *     - `bash`：默认 120s（窗口 120+60=180s 恰好等于基线 ⇒ **默认档本就不需要豁免**），但
 *       `args.timeout` 是**模型自报**且内核**不封顶** ⇒ 显式声明更长的静默命令（`sleep 400`、
 *       不打印进度的打包…）会撞基线档。窗口 = 自报值 + 宽限，**封顶 `LOCAL_JOB_MAX_MS`（15 分钟）**；
 *       超过封顶仍无事件的静默交回看门狗（宁可少放宽——内核那条路自己不封顶，放无限窗等于关掉看门狗）。
 *     - 上下文压缩：摘要调用按设计静默（内核 `context.mjs` 头注 D11），且内核**不给它超时** ⇒ 固定窗口
 *       `COMPRESS_STALL_MS` 就是这段的安全兜底线。
 *     - `git` **网路面**（`push` / `fetch` / `pull` / `clone` / `ls-remote`）：内核按动作分流给它 **300s**
 *       （`tools/git-run.mjs` 的 `GIT_NET_TIMEOUT_MS=300_000` vs `GIT_TIMEOUT_MS=120_000`），而 `spawnGit`
 *       **缓冲输出**（不接 `ctx.onOutput`）⇒ 全程无心跳，合法的冷静默可达 5 分钟、必撞 3 分钟基线档。
 *       窗口 = 该动作预算 + 宽限（**不读模型给的 `timeout`**：内核 `git` 工具的 schema 没这个键，
 *       超时只按动作分流）；本地动作（status/diff/log…）120s ⇒ 窗口 180s 恰=基线，**行为零变化**。
 *     `MCP` 不设豁免：硬编码 120s（`mcp/helpers.mjs`），静默到不了 3 分钟。
 *
 * **病因文案的真实性（2026-09-29 修——旧写法是死代码）**：抬高阈值的那条作业恰好在「发通知的那一跳」
 *  `until` 到期，因此**通知时它已不在 `st.jobs` 里**（旧代码在这一刻反查活动作业 ⇒ 恒得 null ⇒ 文案
 * 永远回落基线，病因素材全部作废）。现改为**病因留档**：条目到期时若**从未收到结束信号**，就把它的
 * 元数据从 `st.jobs` 移入 `st.overdue`（摘除信号到达时一并撤回）；`stallNotice` 从留档里挑「窗口在本轮
 * 静默期内关闭（`until >= lastEventAt`）」且窗口最大的那条作为病因。**阈值判据一字未改**：`pickStallMs` /
 * `activeJobs` 从不看 `st.overdue`，到期即失效的安全性质原样保留。
 *
 * **登记与摘除（在飞判据）** —— 三条路径各自成立，且每条都有 `until` 到期时间兜底：
 *  - **主线条目**：`onToolCall` 带 callId 登记、`onToolResult` 同 callId 摘除（内核两处都传
 *    `toolCall.id`：`agent/dispatch.mjs:263/320` 与 `:375/444`）。⇒ **同批兄弟工具的结果不会把它误摘**
 *    （这正是旧「时间锚点」判据的缺陷：锚点要求「此后一个事件都没有」，而内核把同批全部工具调用
 *    的 onToolCall 发在任何工具执行**之前**，兄弟结果必然晚于武装时刻 ⇒ 豁免被误作废、长作业照样被掐）。
 *  - **子代理条目**（中继名 `role#N/execute`）：结果内核不中继 ⇒ 靠**作用域**摘：同一作用域内工具是
 *    串行的，任何后续同作用域事件（`clearScopeJobs`）即意味着上个作业已结束。嵌套作用域互不误伤
 *    （作用域是**完整前缀链**，`eng-coder#2/` 与 `eng-coder#2/explore#1/` 是两个作用域）。
 *  - **压缩**：`onCompressStart` 登记、`onCompress`/`onCompressFail` 摘除。
 */

// ── 基线 / 挂起期 / 强释（env 可覆盖；键名是外部契约，勿改）──
/** env 阈值读法（单点）：非数字 / 非正 / 空串 / **正但小于 1**（`0.5`、`1e-3`）一律回默认值。
 *  旧写法（`Number(process.env.X ?? 默认)`）的后果（**均可从本文件复核**）：① `pickStallMs` 恒得 NaN
 *  ⇒ `now - lastEventAt >= NaN` 为 false，阈值形同失效；而 `STALL_MS = NaN` 还会让 `WATCH_INTERVAL_MS`
 *  也变 NaN ⇒ `setInterval(fn, NaN)` 退化成 ≈0ms 空转。② **强释分支仍可达**——`deadline` 的输入是
 *  独立的 `TCW_STALL_FORCE_MS`（`runner.mjs` 的 `st.deadline = now + STALL_FORCE_MS`），不吃 `STALL_MS`。
 *  ③ 正的小数经 `Math.floor(0.5) = 0` 会把阈值直接归零（⇒ 每一跳都判停滞），所以下限一并兜住。
 *  该解析函数同时供 `scheduler.mjs` 的定时任务上限（`TCW_JOB_WATCHDOG_MS`）复用——同一口径只此一份。 */
export function envInt(name, fallback) {
  const n = Number(process.env[name])
  if (!Number.isFinite(n) || n <= 0) return fallback
  const m = Math.floor(n)
  return m >= 1 ? m : fallback
}
export const STALL_MS = envInt("TCW_STALL_MS", 180_000) // 无任何事件多久算停滞（基线 3 分钟）
export const SUSPEND_STALL_MS = envInt("TCW_SUSPEND_STALL_MS", 600_000) // 挂起期（D5）10 分钟
export const STALL_FORCE_MS = envInt("TCW_STALL_FORCE_MS", 15_000) // 停滞中止后多久仍未结束 → 强制释放
export const WATCH_INTERVAL_MS = Math.max(1000, Math.min(20_000, Math.floor(STALL_MS / 4)))

// ── 本地作业 ──
export const LOCAL_JOB_SLACK_MS = envInt("TCW_LOCAL_JOB_SLACK_MS", 60_000) // 自报预算之外的宽限（晚于工具自身杀进程；可覆盖——e2e 用极小值复现「作业过期仍未收尾」的病因文案）
export const EXECUTE_FALLBACK_BUDGET_MS = 30_000 // execute 未给 timeoutMs 时内核的默认值
export const EXECUTE_MAX_BUDGET_MS = 600_000 // 内核对 execute.timeoutMs 的上限（Math.min(t, 600_000)）
export const BASH_FALLBACK_BUDGET_MS = 120_000 // 内核 tools/shared.mjs 的 BASH_TIMEOUT_MS
// git 的预算按**动作**分流（内核 tools/git-run.mjs:31/32/34/65：网路面 300s、本地动作 120s）
export const GIT_FALLBACK_BUDGET_MS = 120_000 // 本地动作（status/diff/log…）
export const GIT_NET_BUDGET_MS = 300_000 // 网路面（push/fetch/pull/clone/ls-remote）
/** 内核 `GIT_NET_ACTIONS` 的镜像；**动作用 `args.action` 读**（内核该工具的 schema 键） */
export const GIT_NET_ACTIONS = new Set(["push", "fetch", "pull", "clone", "ls-remote"])
export const LOCAL_JOB_MAX_MS = envInt("TCW_LOCAL_JOB_MAX_MS", 900_000) // 豁免窗口封顶 15 分钟
export const COMPRESS_STALL_MS = envInt("TCW_COMPRESS_STALL_MS", 300_000) // 压缩窗口 5 分钟
/** 需要豁免的本地作业工具（基名）——判定单点，runner 不另写白名单 */
export const LOCAL_JOB_TOOLS = new Set(["execute", "bash", "git"])

/** 工具基名：中继调用形如 `explore#1/execute`，取 `/` 后那段（**单点**——runner 各调用点也用它） */
export function baseName(name) {
  const s = String(name ?? "")
  return s.includes("/") ? s.split("/").pop() : s
}

/** 该动作是不是 git 的**网路面**（内核 `GIT_NET_ACTIONS` 的镜像判据，文案与窗口共用） */
export function isGitNetAction(action) {
  return GIT_NET_ACTIONS.has(String(action ?? ""))
}

/**
 * 本地作业的豁免窗口（ms）；0 = 该工具不属于本地作业（不豁免）。
 * 预算口径逐字对齐内核：execute 非法/非正 → 30s、否则上限 600s；bash 非法/非正 → 120s（内核不封顶，
 * 本函数的封顶只作用于**豁免窗口**，不影响命令本身能跑多久）；git 只按**动作**取档（网路面 300s /
 * 本地 120s）——内核 `git` 工具的 schema **没有** `timeout` 键，模型给的值内核不认，故这里也不读它。
 */
export function localJobWindowMs(tool, args) {
  if (!LOCAL_JOB_TOOLS.has(tool)) return 0
  let budget
  if (tool === "execute") {
    const t = Number(args?.timeoutMs)
    budget = Number.isFinite(t) && t > 0 ? Math.min(t, EXECUTE_MAX_BUDGET_MS) : EXECUTE_FALLBACK_BUDGET_MS
  } else if (tool === "bash") {
    const t = Number(args?.timeout)
    budget = Number.isFinite(t) && t > 0 ? t : BASH_FALLBACK_BUDGET_MS
  } else {
    budget = isGitNetAction(args?.action) ? GIT_NET_BUDGET_MS : GIT_FALLBACK_BUDGET_MS
  }
  return Math.min(budget + LOCAL_JOB_SLACK_MS, LOCAL_JOB_MAX_MS)
}

let seq = 0

/**
 * 登记一次本地作业（该次调用本身算心跳）。
 * @param {string} scope 中继作用域（主线 = ""，子代理 = `role#N/`，嵌套 = 完整前缀链）
 * @param {string|undefined} callId 内核的工具调用 id（主线条目靠它与 onToolResult 配对）
 * @returns {boolean} 是否命中本地作业工具
 */
export function armLocalJob(st, now, scope, callId, name, args) {
  const tool = baseName(name)
  if (!LOCAL_JOB_TOOLS.has(tool)) return false
  st.lastEventAt = now
  const stallMs = localJobWindowMs(tool, args)
  const key = `${scope}\u0000${callId ?? `auto#${++seq}`}`
  st.overdue?.delete(key) // 同键复用：arm 即撤回上一轮同键作业的病因留档（保持「留档 = 从未收尾」不变量）
  st.jobs.set(key, {
    scope, tool, kind: "local", stallMs, until: now + stallMs,
    action: tool === "git" ? String(args?.action ?? "") : null, // 病因文案要能区分网路面/本地动作
    // 无 callId 的占位条目（`auto#N`）**没有配对摘除路径**（`clearLocalJob` 见 callId 为空即早退）⇒ 它一旦
    // 到期进留档，就会把「正常结束但没被配对摘除」的那条作业误报成病因。标上它，`overdueCause` 会跳过。
    unpaired: callId == null,
  })
  return true
}

/** 主线条目摘除（同 callId）；子代理条目由 `clearScopeJobs` / `until` 兜。
 *  摘除同时**撤回病因留档**——作业真收尾了，就不该再被当成停滞病因（照实报「网络/上游」）。 */
export function clearLocalJob(st, scope, callId) {
  if (callId == null) return false
  const key = `${scope}\u0000${callId}`
  st.overdue?.delete(key)
  return st.jobs.delete(key)
}

/** 同一作用域内的**真·后续事件**（新的工具调用 / 正文 / 思考）⇒ 该作用域上一个本地作业已结束
 *  （子代理内工具串行）。**工具输出不算**：它来自**正在跑的**那个工具（bash 边跑边吐），清掉等于让
 *  「先打印几行再长时间静默」的长命令自摘豁免、按基线档被误杀（e2e T6 专钉这条）。主线传 "" 时 no-op。 */
export function clearScopeJobs(st, scope) {
  if (!scope) return false
  let hit = false
  for (const [key, job] of st.jobs) {
    if (job.scope === scope && key.startsWith(`${scope}\u0000`)) { st.jobs.delete(key); st.overdue?.delete(key); hit = true }
  }
  return hit
}

/** 压缩作业：登记（`onCompressStart`）/ 摘除（`onCompress` / `onCompressFail`）。 */
export function armCompressJob(st, now) {
  st.lastEventAt = now
  st.overdue?.delete("\u0000compress") // 同上：重新压缩即撤回上一轮同键留档
  st.jobs.set("\u0000compress", { scope: null, tool: "compress", kind: "compress", stallMs: COMPRESS_STALL_MS, until: now + COMPRESS_STALL_MS })
}

export function clearCompressJob(st) {
  st.overdue?.delete("\u0000compress")
  return st.jobs.delete("\u0000compress")
}

/** 该中继 token 能否作为「这个作用域上一个作业已结束」的证据（scope 摘除的闸门）。
 *  **`⟦ev⟧approval` 不能**：它在工具**等待审批**时由内核发出（`agent/dispatch.mjs:300` 在 `await` 提示
 *  之前），此时工具正 pending——把它当结束信号会让刚登记的作业**立刻被摘掉**（与「工具输出」同型，
 *  e2e T7 专钉）。其余协议事件都落在回合/子代理边界（`turn` 起、`done`/`settled`/`stopped` 终），可作证；
 *  非协议 token = 子代理在说话 ⇒ 它不在工具里，也可作证。 */
export function tokenProvesJobEnd(tok) {
  const m = String(tok ?? "").match(/⟦ev⟧([a-z]+)/)
  return m?.[1] !== "approval"
}

/** 仍在窗口内的作业（过期即不参与判据）。 */
export function activeJobs(st, now = Date.now()) {
  const out = []
  for (const job of st.jobs.values()) if (now < job.until) out.push(job)
  return out
}

/** 过期条目从**判据面**移出（看门狗每跳一次）——阈值判据一字不动（到期即失效，安全性质照旧），
 *  但只要它从未收到过结束信号，就把它的元数据移入 `st.overdue` 作**病因留档**（仅供 `stallNotice`；
 *  `pickStallMs` / `activeJobs` 从不看它）。 */
export function pruneExpiredJobs(st, now = Date.now()) {
  for (const [key, job] of st.jobs) {
    if (now < job.until) continue
    st.jobs.delete(key)
    ;(st.overdue ??= new Map()).set(key, job)
  }
}

/** 病因留档里挑出**该为这段静默负责**的那条：窗口在本轮静默期内关闭（`until >= lastEventAt`，即静默
 *  开始时它还在飞）、且从未收到结束信号 ⇒ 它「超过自己的超时仍未收尾」。取窗口最大者；没有 ⇒ null。
 *  已知边界：**子代理作用域**条目收不到工具结果（内核不中继），所以「未清」≠「真的没跑完」——
 *  这种情形文案只能作「最可能的病因」（子代理那侧没再接话时，说它挂在我们等过的那条命令上是最近的近似）。 */
function overdueCause(st) {
  let best = null
  for (const job of st.overdue?.values() ?? []) {
    if (job.until < st.lastEventAt) continue
    if (job.unpaired) continue // 无 callId 的占位条目没有配对摘除路径 ⇒ 「未清」不代表「真没收尾」（见 armLocalJob）
    if (!best || job.stallMs > best.stallMs) best = job
  }
  return best
}

/** 阈值梯取最大档：基线/挂起期 与 在飞的本地作业窗口 比较 */
export function pickStallMs(st, now = Date.now()) {
  const base = st.suspended ? Math.max(STALL_MS, SUSPEND_STALL_MS) : STALL_MS
  let work = 0
  for (const job of activeJobs(st, now)) work = Math.max(work, job.stallMs)
  return Math.max(base, work)
}

/** 停滞提示文案：数字取**本次实际生效档**（含病因作业自己的窗口），并说明是哪一档
 *  （病因不同，别一律说「网络/上游」）。**病因分档字句全保留**；尾题在 2026-09-29 统一加了一句
 *  「可在设置 → 性能 → 超时控制 中关闭」（开关默认开；关闭后本函数不再被调用）。 */
export function stallNotice(st, now = Date.now()) {
  const cause = overdueCause(st)
  const stallMs = Math.max(pickStallMs(st, now), cause?.stallMs ?? 0)
  const human = stallMs >= 60_000 ? `${Math.round(stallMs / 60_000)} 分钟` : `${Math.round(stallMs / 1000)} 秒`
  const why = cause == null
    ? "（疑似网络/上游停滞）"
    : cause.tool === "execute"
      ? "（execute 已超过它自己的超时仍未收尾，疑似脚本挂死）"
      : cause.tool === "bash"
        ? "（bash 已超过它自己的超时仍未收尾，疑似命令挂死）"
        : cause.tool === "git"
          ? isGitNetAction(cause.action)
            ? `（git ${cause.action} 是网路操作：已超过它自己的超时仍未收尾，疑似远端/网络挂死）`
            : `（git ${cause.action || "本地命令"} 迟迟未收尾）`
          : cause.kind === "compress"
            ? "（上下文压缩迟迟未收尾，疑似摘要调用挂死）"
            : "（疑似网络/上游停滞）"
  return `${human}无任何事件${why}，正在自动中止（可在设置 → 性能 → 超时控制 中关闭）…`
}
