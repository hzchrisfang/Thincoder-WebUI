/**
 * store/jobs.mjs — 定时任务持久化 + 运行日志（M4）
 * jobs 存 ~/.thincoder-webui/jobs.json（原子写）；运行日志存 usage.db 的 job_runs 表。
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { dataDir } from "../lib/auth.mjs"

mkdirSync(dataDir, { recursive: true })
const jobsPath = join(dataDir, "jobs.json")

const db = new DatabaseSync(join(dataDir, "usage.db"))
db.exec(`
  CREATE TABLE IF NOT EXISTS job_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    status TEXT NOT NULL,
    duration_ms INTEGER DEFAULT 0,
    error TEXT,
    prompt_tokens INTEGER DEFAULT 0,
    completion_tokens INTEGER DEFAULT 0,
    result_preview TEXT DEFAULT ''
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_job_runs_job ON job_runs(job_id, ts)`)

// ---------- jobs ----------

export function loadJobs() {
  try {
    const j = JSON.parse(readFileSync(jobsPath, "utf8"))
    return Array.isArray(j.jobs) ? j.jobs : []
  } catch {
    return []
  }
}

export function saveJobs(jobs) {
  // 原子替换（与 state.mjs 同样的跨平台考虑）
  const tmp = jobsPath + ".tmp"
  writeFileSync(tmp, JSON.stringify({ jobs }, null, 2), "utf8")
  try { unlinkSync(jobsPath) } catch { /* 不存在就算了 */ }
  renameSync(tmp, jobsPath)
}

export function getJob(id) {
  return loadJobs().find((j) => j.id === id) ?? null
}

export function putJob(job) {
  const jobs = loadJobs()
  const i = jobs.findIndex((j) => j.id === job.id)
  if (i >= 0) jobs[i] = job
  else jobs.push(job)
  saveJobs(jobs)
  return job
}

export function removeJob(id) {
  const jobs = loadJobs()
  const next = jobs.filter((j) => j.id !== id)
  if (next.length !== jobs.length) {
    saveJobs(next)
    return true
  }
  return false
}

export function patchJob(id, patch) {
  const job = getJob(id)
  if (!job) return null
  const updated = { ...job, ...patch }
  putJob(updated)
  return updated
}

// ---------- 运行日志 ----------

const insertRun = db.prepare(
  `INSERT INTO job_runs (job_id, ts, status, duration_ms, error, prompt_tokens, completion_tokens, result_preview)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
)

export function appendRun({ jobId, ts, status, durationMs, error, promptTokens, completionTokens, resultPreview }) {
  insertRun.run(
    String(jobId),
    Number(ts) || Date.now(),
    String(status),
    Number(durationMs) || 0,
    error == null ? null : String(error).slice(0, 2000),
    Number(promptTokens) || 0,
    Number(completionTokens) || 0,
    String(resultPreview ?? "").slice(0, 1000),
  )
  pruneRuns()
}

export function listRuns(jobId, limit = 50) {
  return db
    .prepare(
      `SELECT id, ts, status, duration_ms AS durationMs, error,
              prompt_tokens AS promptTokens, completion_tokens AS completionTokens,
              result_preview AS resultPreview
       FROM job_runs WHERE job_id = ? ORDER BY ts DESC, id DESC LIMIT ?`
    )
    .all(String(jobId), Number(limit) || 50)
}

/** 全局只保留最近 500 条运行记录 */
function pruneRuns(keep = 500) {
  db.prepare(
    `DELETE FROM job_runs WHERE id NOT IN (SELECT id FROM job_runs ORDER BY ts DESC, id DESC LIMIT ?)`
  ).run(keep)
}
