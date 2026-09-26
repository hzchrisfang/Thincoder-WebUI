/**
 * bridge/scheduler.mjs — 定时任务调度器（M4）
 *
 * 设计（策划书 4.8 + 已拍板决策）：
 * - 进程内调度：15s tick，结构化 schedule（every ≥1min / daily HH:MM / weekly 周几 HH:MM），
 *   五段式 cron 留升级接口
 * - 隔离执行：每任务独立 agent（不污染用户交互会话），Full Auto + maxTurns 上限 + 30 分钟看门狗
 * - 重试：瞬态错误（超时/429/5xx/网络）延迟 30s 重试 1 次，其余只记录（副作用任务不重复执行）
 * - 重启恢复：任务定义持久化在 jobs.json；停机期间到点的任务，启动后首个 tick 补跑一次
 */

import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { existsSync, realpathSync } from "node:fs"
import * as bus from "../lib/bus.mjs"
import { createIsolatedAgent, loadThincoder } from "./thincoder.mjs"
import { isKnownProject } from "./runner.mjs"
import { loadJobs, saveJobs, getJob, putJob, removeJob, patchJob, appendRun } from "../store/jobs.mjs"

export const RETRY_DELAY_MS = 30_000
export const JOB_WATCHDOG_MS = 30 * 60_000
export const DEFAULT_MAX_TURNS = 30
const TICK_MS = 15_000

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
  let changed = false
  for (const job of loadJobs()) {
    if (!job.enabled || running.has(job.id)) continue
    if (job.nextRunAt != null && job.nextRunAt > now) continue
    // 先推进 nextRunAt 再异步执行，避免慢任务被重复点火
    patchJob(job.id, { nextRunAt: nextRunAt(job.schedule, now) })
    changed = true
    executeJob(job.id, { retried: false }).catch(() => {})
  }
  void changed
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
    const watchdog = setTimeout(() => ctrl.abort(), JOB_WATCHDOG_MS)
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
      error = `执行超时（${JOB_WATCHDOG_MS / 60000} 分钟看门狗）`
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
