/**
 * store/mcp-prefs.mjs — MCP「按项目启用」偏好（WebUI 层特性，不写内核 config）
 *
 * 存 ~/.thincoder-webui/mcp-prefs.json：
 *   { "<项目 realpath>": { enabled: ["server 名", …] }, "__known": { "server 名": 首见时间戳 } }
 * 语义（0.4.3 opt-in，0.8.3 收紧）：记录存在 = 该项目**显式启用**的名单（空数组 = 全不启用，有效状态）；
 * 项目进白名单时即写入空名单种子（MCP 默认全不勾选，见 routes POST /api/projects → seedNewProject）。
 * 无记录 / 记录无有效名单 = **全不启用**（fail-closed）——「新装 server 默认不勾选任何项目」对所有项目严格
 * 成立，不再有「旧项目全启用」盲区（0.4.3 的存量盲区：旧格式项目按取反语义把新 server 自动包进启用面）。
 * 兼容读取旧格式 { disabled: [...] }（取反 = 未列入 disabled 的都启用），用户下次勾选操作自然覆写为新格式。
 * 新装 server 的默认勾选归属：
 *   - WebUI 内安装/导入：请求带 project（安装发起项目）→ 直接写进该项目启用名单（bridge/mcp 调 absorbNewServers adopt）；
 *   - WebUI 之外安装（agent / 终端 TUI / 手改 config）：「孤儿收养」——config 里出现从未登记过的 server 名时
 *     （absorbNewServers，观察点 = agent 组装 + 运行收尾），登记之并收养给当前观察项目；服务进程首次观察
 *     只登记不收养（基线，防止升级后存量 server 被批量勾上）。
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
 * 无记录 / 记录无有效名单 = 全不启用（0.8.3 起 fail-closed）；显式 enabled 名单为最终语义；旧 disabled 格式取反。
 */
export function enabledOnly(servers, projectDir) {
  if (!projectDir) return servers
  const entry = load()[projectDir]
  if (!entry) return []
  if (Array.isArray(entry.enabled)) return servers.filter((s) => entry.enabled.includes(s.name))
  if (Array.isArray(entry.disabled)) return servers.filter((s) => !entry.disabled.includes(s.name))
  return []
}

/** 该项目显式启用的 server 名单（展开为名字数组，供前端勾选框；无记录 = 全不启用） */
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

/**
 * 登记观察到的 server 名字（__known 登记表）；「新出现」的（config 有、从未登记）视为 WebUI 之外安装——
 * 收养给 projectDir（合并进其启用名单），agent 本轮装、下一轮即可用。调用方：agent 组装
 * （thincoder.assembleAgent）与运行收尾（bridge/mcp.flushDirty）——一个先于执行、一个紧随执行，
 * 共同覆盖 agent 安装链路；WebUI 安装/导入（bridge/mcp.addServer / importServers）以
 * { adopt: [新名字], force: true } 显式收养给安装发起项目。
 * 基线：偏好文件里尚无 __known（本功能上线后首次观察）→ 只登记不收养（防止升级后存量 server 被批量勾上）；
 * force = true 跳过基线（WebUI 显式安装是用户明确意图，不受基线吞没）。
 * opts.adopt = 可收养的名字白名单（缺省 = 全部新名字都可收养）；基线生效时一律不收养。
 * 返回 { adopted: [收养给 projectDir 的名字] }；无新名字时不写盘。
 */
export function absorbNewServers(names, projectDir, opts = {}) {
  const data = load()
  const baseline = !("__known" in data)
  const known = (data.__known ??= {})
  const list = [...new Set((names ?? []).map((n) => String(n)).filter(Boolean))]
  const adoptSet = Array.isArray(opts.adopt) ? new Set(opts.adopt.map(String)) : null
  const fresh = list.filter((n) => !known[n])
  const toAdopt = baseline && !opts.force ? [] : fresh.filter((n) => !adoptSet || adoptSet.has(n))
  for (const n of list) if (!known[n]) known[n] = Date.now()
  if (toAdopt.length && projectDir) {
    const prev = data[projectDir]
    // 合并基座：enabled 名单优先；旧 disabled 格式先按取反展开为 enabled（收养写入即完成该项目的格式迁移）
    const base = Array.isArray(prev?.enabled)
      ? prev.enabled
      : Array.isArray(prev?.disabled)
        ? list.filter((n) => !prev.disabled.includes(n))
        : []
    const enabled = [...new Set([...base, ...toAdopt])]
    data[projectDir] = { ...prev, enabled }
    delete data[projectDir].disabled
  }
  if (fresh.length) save(data)
  return { adopted: projectDir ? toAdopt : [] }
}

/** 项目从白名单移除时清理 */
export function dropProject(projectDir) {
  const data = load()
  if (!(projectDir in data)) return
  delete data[projectDir]
  save(data)
}

/** server 被移除时从所有项目名单与登记表里摘除（同名重装视为全新安装，可再被收养） */
export function dropServer(name) {
  const data = load()
  let changed = false
  if (data.__known && typeof data.__known === "object" && name in data.__known) {
    delete data.__known[name]
    changed = true
  }
  for (const [projectDir, entry] of Object.entries(data)) {
    if (projectDir.startsWith("__")) continue // 元数据键（__known 等），不是项目
    if (Array.isArray(entry?.enabled)) {
      const next = entry.enabled.filter((n) => n !== name)
      if (next.length !== entry.enabled.length) {
        entry.enabled = next
        changed = true
      }
    } else if (Array.isArray(entry?.disabled)) {
      const next = entry.disabled.filter((n) => n !== name)
      if (next.length !== entry.disabled.length) {
        // 旧格式（取反语义）：非空保留，空 = 该项目记录失去信息量——fail-closed 下无记录 = 全不启用，
        // 与「enabled:[]」等价，统一改写为新格式保留显式空名单（避免 dropServer 静默改变项目语义）
        if (next.length) entry.disabled = next
        else data[projectDir] = { enabled: [] }
        changed = true
      }
    }
  }
  if (changed) save(data)
}
