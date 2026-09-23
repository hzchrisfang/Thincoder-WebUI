/**
 * bridge/sessions.mjs — 会话管理（M2）
 *
 * 薄封装内核 session 模块（0.12.x 槽位模型：全部会话都是槽位文件 {hash}.json.{n}，当前会话 = 活动槽）：
 * 列表（当前 + 归档槽位，带预览）/ 新建（内核分配新空槽，旧会话原地保留即归档）/
 * 切换 / 删除归档槽位，以及从 agent.history 重建前端时间线（修复"刷新页面丢时间线"）。
 */

import { readFileSync, existsSync, unlinkSync, writeFileSync, renameSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { loadThincoder, poolEntries } from "./thincoder.mjs"
import { alignHistory } from "./rewind.mjs"
import { isBusy } from "./runner.mjs"
import * as subagents from "./subagents.mjs"
import { sumRunUsage } from "../store/usage.mjs"

const HISTORY_RESULT_LIMIT = 8000
const SYSTEM_REMINDER_PREFIX = "[System reminder"

/** 重置 agent 内存态为新会话（内核 resetSessionState 清全部会话级运行态；落盘配套 = 内核 newSession 的空槽） */
function resetAgent(entry, t) {
  t.session.resetSessionState(entry.agent)
  entry.agent.autoApprove = false // WebUI 语义：新会话回到 suggest 档（内核有意跨会话保留，这里按 WebUI 旧行为复位）
  entry.restored = null
}

/** 取会话文件（当前或槽位）的预览信息；读不到返回空预览 */
function filePreview(path) {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"))
    const history = Array.isArray(data.history) ? data.history : []
    const firstUser = history.find((m) => m.role === "user" && typeof m.content === "string" && !m.content.startsWith(SYSTEM_REMINDER_PREFIX))
    return {
      msgs: history.length,
      preview: firstUser ? String(firstUser.content).slice(0, 60) : "",
      updatedAt: data.updatedAt ?? null,
    }
  } catch {
    return { msgs: 0, preview: "", updatedAt: null }
  }
}

/** 列出某项目的当前会话 + 归档槽位（槽位带预览） */
export async function listSessions(project) {
  const t = await loadThincoder()
  const sess = t.session
  // 槽位模型：当前会话 = 活动槽文件（可能没有 → 空预览）
  const cur = sess.currentSessionFile(project)
  const current = cur ? filePreview(cur) : { msgs: 0, preview: "", updatedAt: null }
  const slots = sess.listSlots(project).map(({ slot, timestamp, date }) => {
    const p = filePreview(sess.sessionPath(project) + "." + slot)
    return { slot, timestamp, date, msgs: p.msgs, preview: p.preview }
  })
  return { current, slots }
}

/**
 * 新建会话：内核槽位模型下旧会话原地保留即「归档」——调内核 newSession 分配新空槽并翻 active → 重置内存态。
 * 当前会话是空槽时不新开（复用空槽，只清内存态）——避免连点「+」产出一串空槽位。
 */
export async function newSession(project) {
  const t = await loadThincoder()
  // 新会话：子代理面板清空（上一个会话的进度行对新会话无意义）
  subagents.clear(project)
  const cur = t.session.currentSessionFile(project)
  if (cur && filePreview(cur).msgs === 0) {
    const entry = poolEntries().get(project)
    if (entry) resetAgent(entry, t)
    return
  }
  await t.session.newSession(project)
  const entry = poolEntries().get(project)
  if (entry) resetAgent(entry, t)
}

// ========== 归档槽位：删除（内核没有该操作，桥接层按同一落盘格式实现） ==========

/** 槽位元数据文件 {hash}.json.manifest（内核私有格式：{ slots: { "<n>": ts } }） */
function manifestPath(project, sess) {
  return sess.sessionPath(project) + ".manifest"
}

function readManifest(project, sess) {
  try {
    const p = manifestPath(project, sess)
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { slots: {} }
  } catch {
    return { slots: {} }
  }
}

/** 原子写（同内核 writeSessionFile：临时文件 + 替换，Windows 不能直接 rename 覆盖） */
function writeManifest(project, sess, manifest) {
  const p = manifestPath(project, sess)
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(manifest), "utf8")
  try { unlinkSync(p) } catch { /* 旧文件不存在就算了 */ }
  renameSync(tmp, p)
}

/** 删除一个归档槽位：删槽位文件 + 从 manifest 摘除（纯文件操作，运行中也可安全执行） */
export async function deleteSlot(project, slot) {
  const t = await loadThincoder()
  const n = Number(slot)
  if (!Number.isInteger(n) || n < 1) throw new Error("槽位号非法")
  const m = readManifest(project, t.session)
  if (!m.slots?.[n]) throw new Error(`槽位 #${n} 不存在`)
  try { unlinkSync(`${t.session.sessionPath(project)}.${n}`) } catch { /* 文件已不在也照样摘元数据 */ }
  delete m.slots[n]
  writeManifest(project, t.session, m)
  return n
}

/** 清空某项目的全部会话历史：当前会话 + 全部归档槽位 + manifest（移除项目时用；项目目录文件不动） */
export async function purgeSessions(project) {
  const t = await loadThincoder()
  const sess = t.session
  const base = sess.sessionPath(project)
  let removed = 0
  try { unlinkSync(base); removed++ } catch { /* 本来就没有 */ }
  const m = readManifest(project, sess)
  for (const n of Object.keys(m.slots ?? {})) {
    try { unlinkSync(`${base}.${n}`); removed++ } catch { /* 文件已不在也照样清元数据 */ }
  }
  try { unlinkSync(manifestPath(project, sess)); removed++ } catch { /* 本来就没有 */ }
  return removed
}

/** 切换到归档槽位（内核会先自动归档当前会话；调用方需先确认非运行中） */
export async function switchSession(project, slot) {
  const t = await loadThincoder()
  const data = t.session.switchToSlot(project, Number(slot))
  if (!data) throw new Error("槽位不存在或读取失败")
  const entry = poolEntries().get(project)
  if (entry) {
    t.session.applySession(entry.agent, data)
    entry.restored = data
  }
  subagents.clear(project) // 切槽：子代理面板清空（面板行只对当前会话的进度有意义）
}

/**
 * 从 agent.history 重建时间线（渲染用，非显示原文回放）。
 * 过滤：transient 消息与 [System reminder 注入；tool 结果按 tool_call_id 精确配对。
 */
export async function buildHistory(project) {
  const { getAgent } = await import("./thincoder.mjs")
  const entry = await getAgent(project)
  const items = []
  const userTexts = [] // 供回退点对齐（顺序与 items 里的 user 条目一致）
  const toolByCallId = new Map()
  let seq = 0
  const nid = () => `h${(seq++).toString(36)}`

  for (const m of entry.agent.history) {
    if (m.transient) continue

    if (m.role === "user") {
      if (typeof m.content === "string" && !m.content.startsWith(SYSTEM_REMINDER_PREFIX)) {
        userTexts.push(m.content)
        items.push({ kind: "user", id: nid(), text: m.content })
      }
      continue
    }

    if (m.role === "assistant") {
      for (const tc of m.tool_calls ?? []) {
        let args = {}
        try { args = JSON.parse(tc.function.arguments || "{}") } catch { /* 坏参数按空展示 */ }
        const item = {
          kind: "tool",
          id: nid(),
          tool: { callId: tc.id, name: tc.function.name, args, state: "running" },
        }
        toolByCallId.set(tc.id, item)
        items.push(item)
      }
      if (typeof m.content === "string" && m.content) {
        items.push({
          kind: "assistant",
          id: nid(),
          text: m.content,
          reasoning: typeof m.reasoning_content === "string" ? m.reasoning_content : "",
          done: true,
        })
      }
      continue
    }

    if (m.role === "tool") {
      const target = toolByCallId.get(m.tool_call_id)
      if (!target) continue
      const result = typeof m.content === "string" ? m.content : String(m.content ?? "")
      target.tool.state = result.startsWith("Error") ? "error" : "ok"
      target.tool.preview = result.length > HISTORY_RESULT_LIMIT ? result.slice(0, HISTORY_RESULT_LIMIT) : result
      target.tool.truncated = result.length > HISTORY_RESULT_LIMIT
      target.tool.fullLength = result.length
      continue
    }
  }

  // 运行中恢复的会话可能有悬空的 running 工具（中断的 tool_calls）：repairHistory 会在下次运行时修复，
  // 渲染侧把未配对到结果的标记为 error，避免永久转圈
  for (const item of items) {
    if (item.kind === "tool" && item.tool.state === "running") {
      item.tool.state = "error"
      item.tool.preview = item.tool.preview ?? "（上次运行在此中断，无结果）"
    }
  }

  // 会话回退：把 user 条目对齐到快照记录（对不上的——TUI 发的、已被压缩的、超出保留窗口的——不带 rewindId/ts）
  const aligned = alignHistory(project, userTexts)
  let n = 0
  for (const item of items) {
    if (item.kind !== "user") continue
    const rec = aligned[n++]
    if (rec) {
      item.rewindId = rec.id
      item.ts = rec.ts
    }
  }

  // 轮次总结重建：用量库逐次记录聊天的 LLM 调用（定时任务不入库），按相邻用户消息的时间窗聚合出
  // 每轮 token 与完成时刻（该轮最后一次调用 ≈ 收尾时间）。无打点时间的消息无法定界，对应轮次跳过；
  // 运行中的最后一轮也跳过——收尾时实时流的 run_end 会补上总结。
  const bounds = []
  items.forEach((it, i) => {
    if (it.kind === "user" && typeof it.ts === "number") bounds.push({ i, ts: it.ts })
  })
  const busy = isBusy(project)
  const inserts = []
  for (let k = 0; k < bounds.length; k++) {
    if (busy && k === bounds.length - 1) break
    const to = k + 1 < bounds.length ? bounds[k + 1].ts : Date.now()
    if (to <= bounds[k].ts) continue
    const sum = sumRunUsage({ project, fromTs: bounds[k].ts, toTs: to })
    if (!sum.calls) continue
    inserts.push({
      at: k + 1 < bounds.length ? bounds[k + 1].i : items.length,
      item: { kind: "runEnd", id: nid(), ts: sum.lastTs, prompt: sum.prompt, completion: sum.completion },
    })
  }
  for (let k = inserts.length - 1; k >= 0; k--) items.splice(inserts[k].at, 0, inserts[k].item)
  return items
}
