/**
 * state.mjs — webui 自身状态（项目清单等），存 ~/.thincoder-webui/state.json。
 * 不碰 ~/.thincoder（那是 thincoder 内核的数据目录）。
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { dataDir } from "./auth.mjs"

const statePath = join(dataDir, "state.json")

export function loadState() {
  try {
    const s = JSON.parse(readFileSync(statePath, "utf8"))
    return {
      projects: Array.isArray(s.projects) ? s.projects : [],
      host: typeof s.host === "string" && s.host ? s.host : undefined,
    }
  } catch {
    return { projects: [] }
  }
}

export function saveState(state) {
  // 原子替换（不用 rename 直接覆盖已存在目标：Windows 会 EPERM，与内核 session.mjs 同样处理）
  const tmp = statePath + ".tmp"
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8")
  try { unlinkSync(statePath) } catch { /* 不存在就算了 */ }
  renameSync(tmp, statePath)
}

export function listProjects() {
  return loadState().projects
}

export function addProject(dir) {
  const s = loadState()
  if (!s.projects.some((p) => p.dir === dir)) {
    s.projects.push({ dir, addedAt: Date.now() })
    saveState(s)
  }
  return s.projects
}

export function removeProject(dir) {
  const s = loadState()
  s.projects = s.projects.filter((p) => p.dir !== dir)
  saveState(s)
  return s.projects
}

/** 监听 host 偏好（M3 设置页"仅本机"开关），默认 0.0.0.0 */
export function getHost() {
  return loadState().host ?? "0.0.0.0"
}

export function setHost(host) {
  const s = loadState()
  s.host = host
  saveState(s)
}
