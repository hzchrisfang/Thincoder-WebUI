/**
 * bridge/scheduler.mjs — 定时任务调度器（M4）
 *
 * 设计（策划书 4.8 + 已拍板决策）：
 * - 进程内调度：15s tick，结构化 schedule（every ≥1min / daily HH:MM / weekly 周几 HH:MM），
 *   五段式 cron 留升级接口
 * - 隔离执行：每任务独立 agent（不污染用户交互会话），Full Auto + maxTurns 上限 + 30 分钟看门狗
 *   （该上限与交互回合同受设置开关「超时控制」（设置 → 性能）控制：到点那一刻读开关，关闭则不中止）
 * - 重试：瞬态错误（超时/429/5xx/网络）延迟 30s 重试 1 次，其余只记录（副作用任务不重复执行）
 * - 重启恢复：任务定义持久化在 jobs.json；停机期间到点的任务，启动后首个 tick 补跑一次
 */

import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { existsSync, realpathSync } from "node:fs"
import * as bus from "../lib/bus.mjs"
import { createIsolatedAgent, loadThincoder } from "./thincoder.mjs"
import { isKnownProject } from "./runner.mjs"
import { getWatchdogEnabled } from "../lib/state.mjs"
import { envInt } from "./watchdog.mjs"
import { loadJobs, getJob, putJob, removeJob, patchJob, appendRun } from "../store/jobs.mjs"

export const RETRY_DELAY_MS = 30_000
/** 单次定时任务的上限（本仓自加，非内核面）：到点即中止该次运行。
 *  受设置开关「超时控制」（设置 → 性能）控制——与交互回合同一开关，见下方 runJob 的到点闸门。
 *  env 旋钮 `TCW_JOB_WATCHDOG_MS` 只为测试/排障（与看门狗一族同款 `envInt` 口径：非法/非正一律回退默认，不会因手滑把窗口变成 0）。 */
export const JOB_WATCHDOG_MS = envInt("TCW_JOB_WATCHDOG_MS", 30 * 60_000)
export const DEFAULT_MAX_TURNS = 30
const TICK_MS = 15_000

/** 人读时长（只为超时文案）：≥1 分钟按分钟取整，否则按秒——避免窗口被 env 缩短时印出「0.05 分钟」这类小数 */
function humanMs(ms) {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.round(ms / 1000)} 秒`
}

const running = new Set() // 运行中的 jobId
let timer = null

// ---------- schedule ----------

function parseHM(time) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? ""))
  if (!m) throw new Error("time 需为 HH:MM")
  const hh = Number(m[1])
  const mm = Number(m[2])
  if (hh > 23 || mm > 59) throw new Error("time 超出范围")
  return [hh, mm]
}

/** 由 schedule 计算自 from 起的下一次运行时间（ms） */
export function nextRunAt(schedule, from = Date.now()) {
  if (schedule?.kind === "every") {
    const every = Math.max(60_000, Number(schedule.everyMs) || 0)
    return from + every
  }
  const [hh, mm] = parseHM(schedule?.time)
  if (schedule.kind === "daily") {
    const d = new Date(from)
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0)
    if (next.getTime() <= from) next.setDate(next.getDate() + 1)
    return next.getTime()
  }
  if (schedule.kind === "weekly") {
    const wd = Number(schedule.weekday)
    if (!Number.isInteger(wd) || wd < 0 || wd > 6) throw new Error("weekday 需为 0-6（0=周日）")
    const d = new Date(from)
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0)
    next.setDate(next.getDate() + ((wd - next.getDay() + 7) % 7))
    if (next.getTime() <= from) next.setDate(next.getDate() + 7)
    return next.getTime()
  }
  throw new Error("未知 schedule 类型（every / daily / weekly）")
}

/** schedule 合法性校验（创建/更新时用） */
export function validateSchedule(schedule) {
  nextRunAt(schedule) // 非法会抛错
  return schedule
}

/** 前端展示用描述 */
export function describeSchedule(schedule) {
  if (schedule?.kind === "every") return `每 ${Math.round(Math.max(60_000, Number(schedule.everyMs) || 0) / 60000)} 分钟`
  if (schedule?.kind === "daily") return `每天 ${schedule.time}`
  if (schedule?.kind === "weekly") return `每周${"日一二三四五六"[Number(schedule.weekday)]} ${schedule.time}`
  return "—"
}

// ---------- 重试判定 ----------

/** 瞬态错误：网络层失败 + 模型端 408/425/429/5xx（与内核 RETRYABLE_STATUS 对齐） */
export function isTransientError(message) {
  const msg = String(message ?? "")
  if (/LLM API error (408|425|429|5\d\d)/.test(msg)) return true
  if (/fetch failed|network socket disconnected|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|und_err/i.test(msg)) return true
  return false
}

// ---------- CRUD ----------

/** 路径归一为 realpath（与项目白名单口径一致：/tmp → /private/tmp） */
function canonicalPath(p) {
  try {
    const abs = resolve(String(p))
    return existsSync(abs) ? realpathSync(abs) : abs
  } catch {
    return String(p)
  }
}

export function normalizeJob(body, existing = null) {
  const name = String(body.name ?? existing?.name ?? "").trim()
  const project = canonicalPath(body.project ?? existing?.project ?? "")
  const prompt = String(body.prompt ?? existing?.prompt ?? "").trim()
  const schedule = body.schedule ?? existing?.schedule
  if (!name) throw new Error("任务名称必填")
  if (!project) throw new Error("缺少 project")
  if (!isKnownProject(project)) throw new Error("项目未在白名单中")
  if (!prompt) throw new Error("提示词必填")
  validateSchedule(schedule)
  const maxTurns = Math.min(100, Math.max(1, Number(body.maxTurns ?? existing?.maxTurns ?? DEFAULT_MAX_TURNS) || DEFAULT_MAX_TURNS))
  return {
    id: existing?.id ?? randomUUID(),
    name,
    project,
    prompt,
    schedule,
    maxTurns,
    enabled: body.enabled ?? existing?.enabled ?? true,
    createdAt: existing?.createdAt ?? Date.now(),
    lastRunAt: existing?.lastRunAt ?? null,
    lastStatus: existing?.lastStatus ?? null,
    nextRunAt: existing?.nextRunAt ?? null,
  }
}

export function createJob(body) {
  const job = normalizeJob(body)
  job.nextRunAt = nextRunAt(job.schedule)
  putJob(job)
  return job
}

export function updateJob(id, body) {
  const existing = getJob(id)
  if (!existing) throw new Error("任务不存在")
  const updated = normalizeJob(body, existing)
  // schedule 变化时重算下次运行；仅改名称等不重算
  if (JSON.stringify(updated.schedule) !== JSON.stringify(existing.schedule) || updated.enabled !== existing.enabled) {
    updated.nextRunAt = updated.enabled ? nextRunAt(updated.schedule) : null
  }
  putJob(updated)
  return updated
}

export function deleteJob(id) {
  if (running.has(id)) throw new Error("任务运行中，稍后再删")
  return removeJob(id)
}

export function listJobs() {
  return loadJobs().map((j) => ({ ...j, scheduleText: describeSchedule(j.schedule) }))
}

// ---------- 调度循环 ----------

export function startScheduler() {
  if (timer) return
  timer = setInterval(tick, TICK_MS)
  setImmediate(tick) // 启动即补跑停机期间到点的任务
}

export function stopScheduler() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

function tick() {
  const now = Date.now()
  for (const job of loadJobs()) {
    if (!job.enabled || running.has(job.id)) continue
    if (job.nextRunAt != null && job.nextRunAt > now) continue
    // 先推进 nextRunAt 再异步执行，避免慢任务被重复点火
    patchJob(job.id, { nextRunAt: nextRunAt(job.schedule, now) })
    executeJob(job.id, { retried: false }).catch(() => {})
  }
}

/** 立即执行一次（不改变排期） */
export function runJobNow(id) {
  const job = getJob(id)
  if (!job) throw new Error("任务不存在")
  if (running.has(id)) throw new Error("任务已在运行中")
  executeJob(id, { retried: false }).catch(() => {})
  return true
}

// ---------- 执行 ----------

async function executeJob(id, { retried }) {
  const job = getJob(id)
  if (!job || running.has(id)) return
  running.add(id)
  const startedAt = Date.now()
  bus.emit({ type: "job_started", jobId: id, name: job.name, project: job.project })

  const t = await loadThincoder()
  const usage = { prompt: 0, completion: 0 }
  let status = "ok"
  let error = null
  let resultPreview = ""
  let ctrl = null

  try {
    if (!isKnownProject(job.project)) throw new Error("项目未在白名单中")
    const agent = await createIsolatedAgent(job.project)
    agent.autoApprove = true // 无人值守 = Full Auto（写盘/命令不再询问）
    ctrl = new AbortController()
    // 到点闸门：**到点那一刻**才读开关（实时）——开着即中止；关着就把同一条定时器再排一个完整
    // 窗口（关态下每过一窗复查一次 ⇒ 用户中途打开开关，下一个窗口即恢复保护）。
    // 句柄放在可变变量里：关态重排会换掉它，`finally` 清的是**最新**那一个（收尾后不留活定时器）。
    let watchdog = null
    const armJobWatchdog = () => {
      watchdog = setTimeout(() => {
        if (getWatchdogEnabled()) {
          ctrl.abort()
          return
        }
        armJobWatchdog() // 关闭态：下个窗口复查（开关是实时的，不能在这里一次性放弃）
      }, JOB_WATCHDOG_MS)
    }
    armJobWatchdog()
    try {
      const final = await t.agent.runAgent(
        agent,
        job.prompt,
        {
          onUsage: (u) => {
            usage.prompt += u?.prompt_tokens ?? 0
            usage.completion += u?.completion_tokens ?? 0
          },
          // 权限在 UI 层：无人值守任务必须显式放行，否则写操作全部被拒
          //（内核只认回调返回值，不自动读取 autoApprove）
          onPermissionRequest: () => Promise.resolve(true),
        },
        { signal: ctrl.signal, maxTurns: job.maxTurns ?? DEFAULT_MAX_TURNS },
      )
      resultPreview = String(final ?? "").slice(0, 500)
    } finally {
      clearTimeout(watchdog)
    }
  } catch (err) {
    if (err?.name === "ContinueError") {
      status = "paused"
      error = `达到轮数上限（${err.turn} 轮），任务未跑完`
    } else if (ctrl?.signal.aborted) {
      status = "error"
      // 文案报**本次真实耗时**与单次上限两个数：闸门是「到点那一刻读开关」，关态跨多个窗口后再打开时才中止
      // ⇒ 只写窗口长度会在那种情形下报小（实际跑了 90 分钟却写「30 分钟」）。
      error = `执行超时（看门狗：本次运行 ${humanMs(Date.now() - startedAt)}，单次上限 ${humanMs(JOB_WATCHDOG_MS)}）`
    } else {
      status = "error"
      error = err?.message ?? String(err)
    }
  }

  running.delete(id)
  const durationMs = Date.now() - startedAt

  // 瞬态错误且未重试过 → 记录本次为 retried，30s 后再跑一次（只重试这一次）
  if (status === "error" && !retried && isTransientError(error)) {
    appendRun({ jobId: id, ts: startedAt, status: "retried", durationMs, error, promptTokens: usage.prompt, completionTokens: usage.completion, resultPreview })
    bus.emit({ type: "job_retry", jobId: id, name: job.name, error, delayMs: RETRY_DELAY_MS })
    setTimeout(() => executeJob(id, { retried: true }).catch(() => {}), RETRY_DELAY_MS)
    return
  }

  appendRun({ jobId: id, ts: startedAt, status, durationMs, error, promptTokens: usage.prompt, completionTokens: usage.completion, resultPreview })
  patchJob(id, { lastRunAt: startedAt, lastStatus: status })
  bus.emit({ type: "job_done", jobId: id, name: job.name, project: job.project, status, error, durationMs, usage })
}
