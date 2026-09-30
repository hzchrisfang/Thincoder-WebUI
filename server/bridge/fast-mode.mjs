/**
 * bridge/fast-mode.mjs — 极速模式（单轮）的**提醒文案唯一权威**。
 *
 * 极速模式 = 用户用 `/fast` 斜线命令为**一轮**显式授权的提速档：跳过纯仪式动作、临时把审批档
 * 推到 full-auto、并强制启用看门狗；该轮结束自动解除、回到用户原本的设置（状态机在 bridge/runner.mjs）。
 *
 * 载体：内核既有的「瞬时提醒」通道（`agent.history.push({ role:"user", content, transient:true })`），
 * 与内核工程模式提醒 injectEngineeringReminder 同一路子。落盘/上线各说各话（**已核验，非推断**）：
 *   - 人读线（slot 的 `history`）：`transient` 不入记录（@thincoder/core/session-segments.mjs 的 shouldAppend）；
 *   - 机读线（slot 的 `contextHistory`）：**刻意保留** transient（@thincoder/core/session.mjs:111-116
 *     「KEEP transient messages — resume must rebuild the machine line byte-identical」）⇒ 提醒会随本轮
 *     结束前那次 saveSession 落盘，并在**会话恢复时回到机器线**（所以解除时必须同时把活历史里的它摘掉；
 *     下一次 saveSession 会用摘净后的历史重写该槽文件）；
 *   - 上线请求：本地字段被剥掉、只有 role/content 出门（@thincoder/core/provider/core.mjs:124-128）——
 *     **正文照常发给模型**；
 *   - WebUI 面：历史重建丢弃 `[System reminder` 开头的注入（bridge/sessions.mjs）⇒ 不进时间线。
 * 零内核改动（规则 E：内核安装目录不可改），WebUI 侧「叠加一条覆盖性提醒」是唯一可行形态。
 *
 * 文案语言与内核纪律层一致（英文）：它要与 slot 纪律同场竞争，同语言才不产生语域割裂。
 * 改动文案只改这里一处。
 */

export const FAST_REMINDER = [
  "[System reminder: FAST MODE (极速模式) is armed by the user for THIS turn only — the user ran the /fast slash command and it lifts automatically when this turn ends. This is an explicit user-authorized speed override of the standard working discipline, not a waiver on correctness.",
  "SKIP this turn (non-essential ceremony — the user already accepted these omissions): task-list bookkeeping (do not call `task`); doc_search and reading the owning design docs; updating owning docs at the end of the turn; the `verify` gate and per-write `lint` calls; advisor reviews and multi-model consults; subagent delegation (do the work inline in this session); ledger writes, checkpoints, plan mode, memory writes; long preambles — batch independent tool calls into one turn.",
  "NEVER SKIP (the quality floor): read the exact files you are about to edit, before you edit them; run the project's own test/build command for the surface you changed (if the only available verification is a long full-suite run, say so in one line instead of skipping it silently); never fabricate file contents, command output or test results — report failures as they are; destructive or irreversible operations are NOT approval-gated this turn (approvals are off), so never run one without an explicit user instruction.",
  "STOP AND SAY SO if this turns out NOT to be a small change (new feature, interface change, multi-module, or anything other callers depend on): do not silently widen fast mode — report it and let the user decide whether to continue fast or re-run the turn normally.",
  "End the reply with one short line listing what you skipped this turn.]",
].join("\n")

/** 提醒的识别前缀（摘除配对用；文案首行由此开头）。比对**段落全等**更鲁棒：
 *  即便内核在传递链路上对 content 做了首尾空白/包裹规范化，前缀仍能认出它。 */
const FAST_PREFIX = "[System reminder: FAST MODE"

/**
 * 注入极速模式提醒（本轮的**唯一注入点**：runner 的用户回合起点、runAgent 之前调用一次）。
 * 无返回值；调用方负责 `st.fastArmed` 闸门。
 */
export function injectFastReminder(agent) {
  agent.history.push({ role: "user", content: FAST_REMINDER, transient: true })
}

/**
 * 从活历史里摘掉极速提醒（解除时调用：runner 的 setFast(false) / forceRelease 路径）。
 *
 * 为什么必须摘：`transient` 只保证**不进人读线、不把本地字段上线**——消息对象仍在 `agent.history` 里，
 * 而历史是后续每一轮请求的主体（机读线还会被 saveSession 写进 slot 文件、恢复时原样装回）。不摘的话，
 * 模型在之后的普通轮里仍能看到「FAST MODE is armed for THIS turn」，把一次性的提速授权当成持续有效
 * （= 单轮语义泄漏，也确实会让后面的轮次照旧省略仪式）。
 */
export function removeFastReminder(agent) {
  const h = agent?.history
  if (!Array.isArray(h)) return
  for (let i = h.length - 1; i >= 0; i--) {
    const m = h[i]
    if (m?.transient && m.role === "user" && typeof m.content === "string" && m.content.startsWith(FAST_PREFIX)) h.splice(i, 1)
  }
}
