/**
 * store/usage.mjs — 用量持久化（M3）
 * node:sqlite（内置），~/.thincoder-webui/usage.db
 * 每次 LLM 调用（内核 onUsage）记一行；看板按日/按模型聚合。
 */

import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"
import { mkdirSync } from "node:fs"
import { dataDir } from "../lib/auth.mjs"

mkdirSync(dataDir, { recursive: true })
const db = new DatabaseSync(join(dataDir, "usage.db"))

db.exec(`
  CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    project TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cache_hit INTEGER NOT NULL DEFAULT 0,
    cache_miss INTEGER NOT NULL DEFAULT 0
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts)`)

const insert = db.prepare(
  `INSERT INTO usage (ts, project, provider, model, prompt_tokens, completion_tokens, cache_hit, cache_miss)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
)

/** 记录一次 LLM 调用的用量（入参缺省一律按 0） */
export function recordUsage({ project, provider, model, prompt_tokens, completion_tokens, cache_hit, cache_miss }) {
  insert.run(
    Date.now(),
    String(project ?? ""),
    String(provider ?? ""),
    String(model ?? ""),
    Number(prompt_tokens ?? 0) || 0,
    Number(completion_tokens ?? 0) || 0,
    Number(cache_hit ?? 0) || 0,
    Number(cache_miss ?? 0) || 0,
  )
}

/** 聚合查询：近 N 天总量 + 按日 + 按模型 */
export function queryUsage({ days = 7, fromTs } = {}) {
  // fromTs 优先（「当天」= 本地零点起算）；否则按自然日回溯 days 天
  const since = typeof fromTs === "number" ? fromTs : Date.now() - Number(days) * 86400_000

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens), 0) AS prompt,
              COALESCE(SUM(completion_tokens), 0) AS completion,
              COALESCE(SUM(cache_hit), 0) AS hit,
              COALESCE(SUM(cache_miss), 0) AS miss
       FROM usage WHERE ts >= ?`
    )
    .get(since)

  const byDay = db
    .prepare(
      `SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day,
              COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens), 0) AS prompt,
              COALESCE(SUM(completion_tokens), 0) AS completion,
              COALESCE(SUM(cache_hit), 0) AS hit,
              COALESCE(SUM(cache_miss), 0) AS miss
       FROM usage WHERE ts >= ?
       GROUP BY day ORDER BY day`
    )
    .all(since)

  const byModel = db
    .prepare(
      `SELECT provider, model,
              COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens), 0) AS prompt,
              COALESCE(SUM(completion_tokens), 0) AS completion,
              COALESCE(SUM(cache_hit), 0) AS hit,
              COALESCE(SUM(cache_miss), 0) AS miss
       FROM usage WHERE ts >= ?
       GROUP BY provider, model ORDER BY calls DESC LIMIT 20`
    )
    .all(since)

  return { days: typeof fromTs === "number" ? 0 : Number(days), totals, byDay, byModel }
}

/** 聚合某项目时间窗 [fromTs, toTs) 内的 LLM 调用（聊天轮次重建用；定时任务不入库，不会串数据） */
export function sumRunUsage({ project, fromTs, toTs }) {
  return db
    .prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens), 0) AS prompt,
              COALESCE(SUM(completion_tokens), 0) AS completion,
              MAX(ts) AS lastTs
       FROM usage WHERE project = ? AND ts >= ? AND ts < ?`
    )
    .get(String(project ?? ""), Number(fromTs), Number(toTs))
}

/** 删除某项目的用量记录（测试清理 / 项目移除时用） */
export function removeUsageByProject(project) {
  return db.prepare(`DELETE FROM usage WHERE project = ?`).run(String(project)).changes
}
