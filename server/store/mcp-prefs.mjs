/**
 * store/mcp-prefs.mjs — MCP「按项目启用」偏好（WebUI 层特性，不写内核 config）
 *
 * 存 ~/.thincoder-webui/mcp-prefs.json：{ "<项目 realpath>": { enabled: ["server 名", …] } }
 * 语义（0.4.3 起 opt-in）：记录存在 = 该项目**显式启用**的名单（空数组 = 全不启用，有效状态）；
 * 项目进白名单时即写入空名单种子（MCP 默认全不勾选，见 routes POST /api/projects → seedNewProject）。
 * 无记录 = 本版本之前加入的项目，维持旧行为「全部启用」；兼容读取旧格式 { disabled: [...] }（取反）。
 * 注意：内核与终端 TUI 不感知本文件——它们始终连接 config.json 里的全部 server。
 */

import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { dataDir } from "../lib/auth.mjs"

const prefsPath = join(dataDir, "mcp-prefs.json")

function load() {
  try {
    const raw = JSON.parse(readFileSync(prefsPath, "utf8"))
    return raw && typeof raw === "object" ? raw : {}
  } catch {
    return {}
  }
}

function save(data) {
  mkdirSync(dataDir, { recursive: true })
  // 原子替换（同 state.mjs：不直接 rename 覆盖已存在目标，Windows 会 EPERM）
  const tmp = prefsPath + ".tmp"
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8")
  try { unlinkSync(prefsPath) } catch { /* 不存在就算了 */ }
  renameSync(tmp, prefsPath)
}

/**
 * 过滤出该项目启用的 server（agent 组装与热更新共用同一口径，改过滤逻辑只改这里）。
 * 无记录 = 全部启用（旧项目兼容）；显式 enabled 名单为最终语义；旧 disabled 格式取反。
 */
export function enabledOnly(servers, projectDir) {
  if (!projectDir) return servers
  const entry = load()[projectDir]
  if (!entry) return servers
  if (Array.isArray(entry.enabled)) return servers.filter((s) => entry.enabled.includes(s.name))
  if (Array.isArray(entry.disabled)) return servers.filter((s) => !entry.disabled.includes(s.name))
  return servers
}

/** 该项目显式启用的 server 名单（展开为名字数组，供前端勾选框；无记录 = 全部启用） */
export function enabledListFor(servers, projectDir) {
  return enabledOnly(servers, projectDir).map((s) => s.name)
}

/** 覆盖式写入显式启用名单；空数组 = 全不启用（有效状态，保留记录） */
export function setEnabled(projectDir, names) {
  const data = load()
  data[projectDir] = { enabled: [...new Set((names ?? []).map((n) => String(n)).filter(Boolean))] }
  save(data)
}

/** 新项目种子：写入空启用名单（默认全不勾选）；已有记录不动（重复添加项目不重置偏好） */
export function seedNewProject(projectDir) {
  const data = load()
  if (data[projectDir]) return
  data[projectDir] = { enabled: [] }
  save(data)
}

/** 项目从白名单移除时清理 */
export function dropProject(projectDir) {
  const data = load()
  if (!(projectDir in data)) return
  delete data[projectDir]
  save(data)
}

/** server 被移除时从所有项目名单里摘除（同名重建后默认回到「未勾选」，避免意外自动启用） */
export function dropServer(name) {
  const data = load()
  let changed = false
  for (const [projectDir, entry] of Object.entries(data)) {
    if (Array.isArray(entry?.enabled)) {
      const next = entry.enabled.filter((n) => n !== name)
      if (next.length !== entry.enabled.length) {
        entry.enabled = next
        changed = true
      }
    } else if (Array.isArray(entry?.disabled)) {
      const next = entry.disabled.filter((n) => n !== name)
      if (next.length !== entry.disabled.length) {
        if (next.length) entry.disabled = next
        else delete data[projectDir] // 旧格式：空名单 = 全启用，记录即可删除
        changed = true
      }
    }
  }
  if (changed) save(data)
}
