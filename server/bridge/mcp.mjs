/**
 * bridge/mcp.mjs — MCP 服务器：安装（模板 / 校验 / 预检）、状态、热更新与重连
 *
 * 内核契约（0.5.x，src/mcp.mjs；内核 import 仍全部收敛在 bridge/thincoder.mjs）：
 *   connectMcpServer({ name, command, args } | { name, url, headers }) → 工具数组（带 _mcpName / _mcpTransport）
 *   removeMcpTools(agent, name)  断开并摘除该 server 的工具
 *   closeAllMcp(agent)           断开全部 transport（工具对象仍留在数组里，需自行过滤）
 *
 * 配置唯一落点：~/.thincoder/config.json 的 mcp.servers[]（与终端 TUI 的 /mcp 双向兼容）。
 * 热更新：写完配置即刻作用于实例池里的 agent（无需重启服务）；项目运行中则标记 _mcpDirty，
 * 由 runner 的 onRunEnd 钩子在收尾后按最新配置整体重连。
 */

import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import * as bus from "../lib/bus.mjs"
import * as prefs from "../store/mcp-prefs.mjs"
import { loadThincoder, poolEntries } from "./thincoder.mjs"
import * as runner from "./runner.mjs"

/** 内置安装模板（对齐 MCP 官方参考实现与常用社区服务器；uvx 系需要本机有 uv） */
export function mcpPresets(projectDir) {
  return [
    {
      id: "filesystem", desc: "文件系统（可指定目录）", transport: "stdio", command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", projectDir ?? "."],
      hint: "最后一个参数为授权目录，默认当前项目路径；可继续追加多个目录",
    },
    {
      id: "memory", desc: "知识图谱记忆", transport: "stdio", command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
    },
    {
      id: "sequential-thinking", desc: "分步推理", transport: "stdio", command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    },
    {
      id: "fetch", desc: "网页抓取（Python）", transport: "stdio", command: "uvx",
      args: ["mcp-server-fetch"], hint: "需要本机已安装 uv（uvx）",
    },
    {
      id: "git", desc: "Git 仓库操作（Python）", transport: "stdio", command: "uvx",
      args: ["mcp-server-git", "--repository", projectDir ?? "."], hint: "需要 uv；--repository 指向仓库目录",
    },
    {
      id: "playwright", desc: "浏览器自动化（社区）", transport: "stdio", command: "npx",
      args: ["-y", "@playwright/mcp@latest"], hint: "首次运行需下载浏览器，可能超过 30 秒连接超时，建议先在终端预热一次",
    },
    {
      id: "everything", desc: "官方测试服务器", transport: "stdio", command: "npx",
      args: ["-y", "@modelcontextprotocol/server-everything"],
    },
  ]
}

// ================= 校验 / 脱敏 / 预检 =================

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** 入参 → 干净的内核 server 形态（args / headers 为空时不带字段，与 TUI 一致） */
function normalizeServer(body, old) {
  const name = String(body?.name ?? "").trim()
  if (!NAME_RE.test(name)) throw new Error("名称需为 1-64 位字母/数字/._-，且以字母或数字开头")
  const transport = body?.transport === "http" || (!body?.command && body?.url) ? "http" : "stdio"

  if (transport === "http") {
    const url = String(body?.url ?? "").trim()
    if (!/^https?:\/\//.test(url)) throw new Error("HTTP server 需要 http(s) 开头的 url")
    const oldMap = old?.url ? old.headers ?? {} : {}
    const raw = Array.isArray(body?.headers) ? body.headers : []
    const headers = raw
      .map((h) => ({ key: String(h?.key ?? "").trim(), value: String(h?.value ?? "").trim() }))
      .filter((h) => h.key || h.value)
    for (const h of headers) {
      if (!h.key) throw new Error("请求头缺少名称")
      if (!h.value) h.value = String(oldMap[h.key] ?? "") // 留空 = 保留已存储的值（与 provider key 同约定）
      if (!h.value) throw new Error(`请求头 "${h.key}" 需要填值`)
    }
    return headers.length
      ? { name, url, headers: Object.fromEntries(headers.map((h) => [h.key, h.value])) }
      : { name, url }
  }

  const command = String(body?.command ?? "").trim()
  if (!command) throw new Error("stdio server 需要 command（如 npx）")
  const args = (typeof body?.args === "string" ? body.args.split("\n") : Array.isArray(body?.args) ? body.args : [])
    .map((a) => String(a).trim())
    .filter(Boolean)
  return args.length ? { name, command, args } : { name, command }
}

/** GET 响应脱敏：请求头只露尾 4 位（编辑时留空 = 保留原值） */
function maskServer(srv) {
  return {
    name: srv.name,
    transport: srv.url ? "http" : "stdio",
    command: srv.command ?? "",
    args: srv.args ?? [],
    url: srv.url ?? "",
    headers: Object.entries(srv.headers ?? {}).map(([key, value]) => ({ key, tail: String(value).slice(-4) })),
  }
}

/** 命令预检：为「未安装 npx/uvx」给出可操作提示（不阻塞保存与试连） */
export function checkCommand(cmd) {
  if (cmd.includes("/") || cmd.includes("\\")) return existsSync(cmd)
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

// ================= 配置读写（mcp.servers[]） =================

export async function listServers() {
  const t = await loadThincoder()
  return (t.config.loadConfig().mcp?.servers ?? []).map(maskServer)
}

function writeServers(t, servers) {
  const raw = t.config.loadConfig()
  raw.mcp = { ...(raw.mcp ?? {}), servers }
  t.config.saveConfig(raw)
}

/** 新增（重名即拒）：写配置 → 热更新实例池。project = 安装发起项目（带则默认勾选给该项目） */
export async function addServer(body) {
  const t = await loadThincoder()
  const srv = normalizeServer(body)
  const servers = t.config.loadConfig().mcp?.servers ?? []
  if (servers.some((s) => s.name === srv.name)) throw new Error(`MCP server "${srv.name}" 已存在（可编辑或先删除）`)
  writeServers(t, [...servers, srv])
  const adopt = prefs.absorbNewServers([...servers.map((s) => s.name), srv.name], body?.project ?? null, { adopt: [srv.name], force: true })
  const results = await applyServerToPool(t, srv)
  emit("add", srv.name, results)
  return { server: maskServer(srv), results, adopted: adopt.adopted }
}

/** 编辑（按 name 定位，名称不可改）：写配置 → 重连 */
export async function updateServer(body) {
  const t = await loadThincoder()
  const servers = t.config.loadConfig().mcp?.servers ?? []
  const idx = servers.findIndex((s) => s.name === String(body?.name ?? "").trim())
  if (idx < 0) throw new Error(`MCP server "${body?.name}" 不存在`)
  const srv = normalizeServer(body, servers[idx])
  const next = [...servers]
  next[idx] = srv
  writeServers(t, next)
  const results = await applyServerToPool(t, srv)
  emit("update", srv.name, results)
  return { server: maskServer(srv), results }
}

/** 删除：写配置 → 断开并摘除实例池里的工具（同时把各项目启用名单里的它摘除，同名重建默认回到未勾选） */
export async function removeServer(name) {
  const t = await loadThincoder()
  const servers = t.config.loadConfig().mcp?.servers ?? []
  if (!servers.some((s) => s.name === name)) throw new Error(`MCP server "${name}" 不存在`)
  writeServers(t, servers.filter((s) => s.name !== name))
  prefs.dropServer(name)
  const results = []
  for (const [dir, entry] of poolEntries()) {
    if (runner.isBusy(dir)) {
      entry._mcpDirty = true
      results.push({ project: dir, deferred: true })
      continue
    }
    removeFromEntry(t, entry, name)
    results.push({ project: dir, ok: true })
  }
  emit("remove", name, results)
  return { results }
}

// ================= JSON 导入（Claude Desktop / Cursor 的 mcpServers 格式） =================

/** POSIX 单引号转义（env 包装用） */
function shQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`
}

/** 无 name 时从命令/URL 推导一个合法名称 */
function deriveName(s) {
  const base = String(s).split(/[\\/]/).filter(Boolean).pop() ?? ""
  return base
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 48)
}

/** 单条 JSON 配置 → 内核 server；env 自动包装为 sh -c（内核无 per-server env 支持） */
function serverFromJson(name, cfg) {
  if (!cfg || typeof cfg !== "object") throw new Error("配置需为对象")
  const command = String(cfg.command ?? "").trim()
  const url = String(cfg.url ?? "").trim()
  const args = Array.isArray(cfg.args) ? cfg.args.map((a) => String(a)) : []
  const headers = Object.entries(cfg.headers ?? {})
    .filter(([k]) => String(k).trim())
    .map(([k, v]) => ({ key: String(k).trim(), value: String(v ?? "") }))

  const env = cfg.env && typeof cfg.env === "object" ? Object.entries(cfg.env) : []
  if (command && env.length) {
    if (process.platform === "win32") {
      throw new Error("含 env：Windows 需手动改成 cmd /c 包装（内核不支持 per-server env）")
    }
    const assigns = env.map(([k, v]) => `${String(k).trim()}=${shQuote(v)}`).join(" ")
    const line = ["exec", shQuote(command), ...args.map(shQuote)].join(" ")
    return { srv: normalizeServer({ name, transport: "stdio", command: "sh", args: ["-c", `${assigns} ${line}`] }), wrapped: true }
  }
  if (command) return { srv: normalizeServer({ name, transport: "stdio", command, args }), wrapped: false }
  if (url) return { srv: normalizeServer({ name, transport: "http", url, headers }), wrapped: false }
  throw new Error("缺少 command（stdio）或 url（HTTP）")
}

/**
 * 解析外部 MCP 配置 JSON（宽松）：支持
 *   { "mcpServers": { name: cfg } }        Claude Desktop / Cursor 格式
 *   [{ name, command|url, … }]             内核 mcp.servers[] 数组
 *   { "mcp": { "servers": [...] } }        config.json 片段
 *   { name: cfg } / 单个 { name, command|url }
 */
export function parseMcpJson(input) {
  let data = input
  if (typeof input === "string") {
    const text = input.trim()
    if (!text) throw new Error("请先粘贴 JSON 配置")
    try {
      data = JSON.parse(text)
    } catch (err) {
      throw new Error(`JSON 解析失败：${err?.message ?? err}`)
    }
  }
  if (!data || typeof data !== "object") throw new Error("JSON 顶层需要是对象或数组")

  const pair = (cfg) => [String(cfg?.name ?? "").trim(), cfg]
  let entries
  if (Array.isArray(data)) {
    entries = data.map(pair)
  } else if (data.mcpServers && typeof data.mcpServers === "object") {
    entries = Object.entries(data.mcpServers)
  } else if (data.servers && typeof data.servers === "object") {
    entries = Array.isArray(data.servers) ? data.servers.map(pair) : Object.entries(data.servers)
  } else if (data.mcp?.servers) {
    entries = Array.isArray(data.mcp.servers) ? data.mcp.servers.map(pair) : Object.entries(data.mcp.servers)
  } else if (data.command || data.url) {
    entries = [pair(data)] // 单个 server（name 缺失时按命令/URL 推导）
  } else {
    const vals = Object.values(data)
    const looksLikeMap = vals.length > 0 && vals.every((v) => v && typeof v === "object") && vals.some((v) => v.command || v.url)
    if (!looksLikeMap) throw new Error('未识别的格式：支持 {"mcpServers":{…}}、servers 数组，或单个 {name, command|url} 对象')
    entries = Object.entries(data)
  }

  const items = []
  const failed = []
  for (let [name, cfg] of entries) {
    if (!name) name = deriveName(cfg?.command ?? cfg?.url ?? "")
    try {
      items.push(serverFromJson(name, cfg))
    } catch (err) {
      failed.push({ name: name || "(未命名)", error: err?.message ?? String(err) })
    }
  }
  if (!items.length && !failed.length) throw new Error("没有解析出任何 MCP server")
  return { items, failed }
}

/** 批量导入：解析 → 写配置（同名跳过）→ 逐个热更新实例池。project = 安装发起项目（带则默认勾选给该项目） */
export async function importServers(input, project = null) {
  const t = await loadThincoder()
  const { items, failed } = parseMcpJson(input)
  const servers = t.config.loadConfig().mcp?.servers ?? []
  const installed = []
  const skipped = []
  const toApply = []
  for (const { srv, wrapped } of items) {
    if (servers.some((s) => s.name === srv.name)) {
      skipped.push({ name: srv.name, reason: "同名已存在（先删除或改名后再导入）" })
      continue
    }
    servers.push(srv)
    toApply.push(srv)
    installed.push({ name: srv.name, wrapped, results: [] })
  }
  if (toApply.length) {
    writeServers(t, servers)
    // 传全量 server 名（旧格式项目展开基座需要全量名单，只传新名字会丢掉该项目原本启用的其它 server）
    prefs.absorbNewServers(servers.map((s) => s.name), project, { adopt: toApply.map((s) => s.name), force: true })
  }
  for (const srv of toApply) {
    const results = await applyServerToPool(t, srv)
    installed.find((x) => x.name === srv.name).results = results
  }
  if (installed.length) emit("import", null, installed.flatMap((x) => x.results))
  return { installed, skipped, failed }
}

// ================= 连接测试 / 状态 / 重连 =================

/** 试连（dry-run）：真实拉起进程做 initialize + tools/list，随后立即断开，不影响实例池 */
export async function testServer(body) {
  const t = await loadThincoder()
  let srv
  if (body?.name && !body?.command && !body?.url) {
    const found = (t.config.loadConfig().mcp?.servers ?? []).find((s) => s.name === body.name)
    if (!found) throw new Error(`MCP server "${body.name}" 不存在`)
    srv = found
  } else {
    srv = normalizeServer(body)
  }
  const commandFound = srv.command ? checkCommand(srv.command) : true
  const started = Date.now()
  try {
    const tools = await t.mcp.connectMcpServer(srv)
    const names = tools.map((x) => x.name)
    t.mcp.closeAllMcp({ tools }) // 仅断开测试连接
    return { ok: true, tools: names, elapsedMs: Date.now() - started, commandFound }
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err), elapsedMs: Date.now() - started, commandFound }
  }
}

/** 某项目实例的连接状态（未 materialize 的项目只有配置、没有状态） */
export function statusFor(projectDir) {
  const entry = projectDir ? poolEntries().get(projectDir) : null
  if (!entry) return { materialized: false, servers: {}, warnings: [], dirty: false }
  const servers = {}
  for (const srv of entry.agent.config?.mcp?.servers ?? []) {
    const tools = (entry.agent.tools ?? []).filter((x) => x._mcpName === srv.name).map((x) => x.name)
    servers[srv.name] = { connected: tools.length > 0, tools }
  }
  return { materialized: true, servers, warnings: entry.mcpWarnings ?? [], dirty: Boolean(entry._mcpDirty) }
}

/** 该项目显式启用的 server 名单（前端勾选框直接读它，不依赖 agent 是否已加载；无记录的旧项目 = 全部启用） */
export async function enabledList(projectDir) {
  const t = await loadThincoder()
  return prefs.enabledListFor(t.config.loadConfig().mcp?.servers ?? [], projectDir)
}

/** 新项目种子：写入空启用名单（MCP 默认全不勾选，opt-in）；已有记录不动 */
export function seedProjectPrefs(projectDir) {
  prefs.seedNewProject(projectDir)
}

/** 项目移出白名单时清理其启用偏好 */
export function dropProjectPrefs(projectDir) {
  prefs.dropProject(projectDir)
}

/**
 * 按项目启用/停用：写偏好 → 对齐该项目实例池里的 MCP 工具（busy 则延迟到本轮收尾）。
 * names 为「启用名单」（opt-in），空数组 = 全不启用；只保留 config 里真实存在的 server 名。
 */
export async function setProjectEnabled(projectDir, names) {
  const t = await loadThincoder()
  const all = new Set((t.config.loadConfig().mcp?.servers ?? []).map((s) => s.name))
  const enabled = (Array.isArray(names) ? names : []).map(String).filter((n) => all.has(n))
  prefs.setEnabled(projectDir, enabled)
  const entry = poolEntries().get(projectDir)
  if (!entry) return { results: [], enabled, note: "项目尚未加载，下次打开项目时生效" }
  if (runner.isBusy(projectDir)) {
    entry._mcpDirty = true
    return { results: [{ project: projectDir, deferred: true }], enabled }
  }
  const results = await resyncEntry(t, projectDir, entry)
  emit("project", projectDir, results)
  return { results, enabled }
}

/** 手动重连：name 缺省 = 全部已配置 server；project 缺省 = 全部实例池项目 */
export async function reconnect(name, onlyProject) {
  const t = await loadThincoder()
  const servers = (t.config.loadConfig().mcp?.servers ?? []).filter((s) => !name || s.name === name)
  if (name && servers.length === 0) throw new Error(`MCP server "${name}" 不存在`)
  const results = []
  for (const srv of servers) results.push(...(await applyServerToPool(t, srv, onlyProject)))
  emit("reconnect", name ?? null, results)
  return { results }
}

/** 运行收尾：收养观察（config 里出现未登记 server = WebUI 之外安装 → 收养给本项目）+ 延迟冲刷。
 *  收养观察每轮收尾必跑（agent 改 config 不置 _mcpDirty，不能拿它当观察条件；无新名字时 absorb 内部不写盘）；
 *  收养命中则本项目强制整体重连——agent 本轮装的 server，下一轮对话即可直接用，无需重开项目。 */
export async function flushDirty(project) {
  const t = await loadThincoder()
  const all = t.config.loadConfig().mcp?.servers ?? []
  const absorb = prefs.absorbNewServers(all.map((s) => s.name), project)
  const entry = poolEntries().get(project)
  // 先判「无实例」：entry 不在池里就没有可 resync 的实例（收养已在上方落盘），直接早退。
  // 别把「无实例」和「无变更」合成一个条件——`!entry?._mcpDirty && !absorb.adopted.length` 这写法在有收养时
  // 会带着 undefined 的 entry 穿过守卫（absorb 分支破掉了「能到下一行 ⇒ entry 存在」的隐含前提）。
  if (!entry || (!entry._mcpDirty && !absorb.adopted.length)) return []
  entry._mcpDirty = false
  const results = await resyncEntry(t, project, entry)
  emit("flush", null, results)
  return results
}

// ================= 内部：实例池热更新 =================

function emit(action, name, results) {
  bus.emit({ type: "mcp", action, name, results })
}

/** 断开某 server 并摘除其工具 + 同步 agent.config（供删除 / 重连路径复用） */
function removeFromEntry(t, entry, name) {
  t.mcp.removeMcpTools(entry.agent, name)
  const mcp = entry.agent.config?.mcp
  if (mcp) mcp.servers = (mcp.servers ?? []).filter((s) => s.name !== name)
}

/**
 * 按「config + 该项目启用偏好」整体对齐某实例：断开全部 MCP 工具后重连启用的 server。
 * 配置是唯一事实源；偏好只决定该项目连哪些（组装路径见 thincoder.mjs 的 enabledOnly）。
 */
async function resyncEntry(t, project, entry) {
  const servers = prefs.enabledOnly(t.config.loadConfig().mcp?.servers ?? [], project)
  t.mcp.closeAllMcp(entry.agent)
  entry.agent.tools = (entry.agent.tools ?? []).filter((x) => !x._mcpName)
  if (entry.agent.config?.mcp) entry.agent.config.mcp.servers = servers
  const results = []
  for (const srv of servers) {
    try {
      const tools = await t.mcp.connectMcpServer(srv)
      entry.agent.tools.push(...tools)
      results.push({ project, name: srv.name, ok: true, tools: tools.map((x) => x.name) })
    } catch (err) {
      results.push({ project, name: srv.name, ok: false, error: err?.message ?? String(err) })
    }
  }
  return results
}

/** 对实例池应用某 server（新增/更新/重连）；该项目停用则跳过；busy 的项目标记延迟，收尾后冲刷 */
async function applyServerToPool(t, srv, onlyProject) {
  const results = []
  for (const [dir, entry] of poolEntries()) {
    if (onlyProject && dir !== onlyProject) continue
    if (prefs.enabledOnly([srv], dir).length === 0) {
      results.push({ project: dir, name: srv.name, disabled: true })
      continue
    }
    if (runner.isBusy(dir)) {
      entry._mcpDirty = true
      results.push({ project: dir, name: srv.name, deferred: true })
      continue
    }
    removeFromEntry(t, entry, srv.name)
    const cfg = (entry.agent.config ??= {})
    cfg.mcp ??= { servers: [] }
    cfg.mcp.servers = (cfg.mcp.servers ?? []).filter((s) => s.name !== srv.name)
    cfg.mcp.servers.push(srv)
    try {
      const tools = await t.mcp.connectMcpServer(srv)
      entry.agent.tools.push(...tools)
      results.push({ project: dir, name: srv.name, ok: true, tools: tools.map((x) => x.name) })
    } catch (err) {
      results.push({ project: dir, name: srv.name, ok: false, error: err?.message ?? String(err) })
    }
  }
  return results
}

// 运行收尾后冲刷延迟变更（runner 不 import 本模块，无循环依赖）
runner.onRunEnd((project) => { flushDirty(project).catch(() => {}) })
