/**
 * bridge/thincoder.mjs — thincoder 模块加载 + 每项目 agent 实例池
 *
 * 适配内核 0.12.x（本体拆入依赖包 @thincoder/core，thincoder 本包只剩 cli/tui/acp 薄壳）：
 * - 对内核的唯一适配面：全部内核 import 收敛在本文件，升级 thincoder 只改这里
 * - 模块路径按 core 新布局映射（checkpoint→git/checkpoint、provider→provider/index、
 *   repomap→tools/repomap、gitmem→git/gitmem；session 拆为 session/session-lifecycle/session-slots）
 * - saveConfig 兼容层：旧签名 saveConfig(cfg)（整对象覆盖）桥到新 writeConfigAtomic(path, mutate)
 *   （磁盘新鲜读 + mtime 冲突门控，多实例协作安全）
 * - 会话模型迁移：新内核没有独立「当前会话文件」——全部会话都是槽位文件
 *   （{hash}.json.{n}），活动槽 = 端标记 + manifest.active。对外补 currentSessionFile()/
 *   listSlots 兼容面，sessions/rewind 的「当前文件」语义经此定位
 * - 实例池：每个项目目录一个 agent（含 memory / MCP 连接），复刻内核 cli/make-agent.mjs
 * - 首次取实例时自动恢复会话（loadSession + applySession），与 TUI 行为一致
 */

import { createRequire } from "node:module"
import { execSync } from "node:child_process"
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs"
import { join, dirname, basename } from "node:path"
import { pathToFileURL } from "node:url"
import { enabledOnly, absorbNewServers } from "../store/mcp-prefs.mjs"

const require = createRequire(import.meta.url)

let tc = null // 模块集合缓存

/** loadConfig() merged 独有、内核不消费的派生键——写盘即脏数据（运行期每次重新派生）。
 *  历史上 WebUI 的 saveConfig(loadConfig()) 全量落盘把它们写进过真机 config.json，此表同时负责清残留。 */
const DERIVED_CONFIG_KEYS = ["provider", "providersList", "providerInvalidReason", "advisor"]

/** 解析 @thincoder/core 安装目录：优先本地 node_modules，回退全局 thincoder 内嵌 */
function resolveCoreDir() {
  try {
    return dirname(require.resolve("@thincoder/core/package.json"))
  } catch { /* 本地没装 */ }
  try {
    const root = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
    const dir = join(root, "thincoder", "node_modules", "@thincoder", "core")
    if (existsSync(join(dir, "package.json"))) return dir
  } catch { /* npm 不可用 */ }
  throw new Error("找不到 @thincoder/core。请在本项目 `npm install`（thincoder ^0.12.64 自带），或 `npm install -g thincoder`。")
}

/** thincoder 薄壳版本号（展示用；内核实现在 core 里） */
function thincoderVersion() {
  for (const p of ["thincoder/package.json", join(execGlobalRoot(), "thincoder/package.json")]) {
    try { return JSON.parse(readFileSync(require.resolve(p), "utf8")).version } catch { /* 下一个 */ }
  }
  return "unknown"
}

function execGlobalRoot() {
  try { return join(execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()) } catch { return "" }
}

/** 动态加载内核模块（按文件 URL，保证内核内部相对资源/自引用解析正确） */
export async function loadThincoder() {
  if (tc) return tc
  const dir = resolveCoreDir()
  const url = (f) => pathToFileURL(join(dir, f)).href
  const [agent, config, configIo, memory, tools, session, sessionLifecycle, sessionSlots, checkpoint, embedding, mcp, provider, gitmem, rules, proxy, editDiff, shared, relayPrefix] = await Promise.all([
    import(url("agent.mjs")),
    import(url("config.mjs")),
    import(url("config-io.mjs")),
    import(url("memory.mjs")),
    import(url("tools/index.mjs")),
    import(url("session.mjs")),
    import(url("session-lifecycle.mjs")),
    import(url("session-slots.mjs")),
    import(url("git/checkpoint.mjs")),
    import(url("embedding.mjs")),
    import(url("mcp.mjs")),
    import(url("provider/index.mjs")),
    import(url("git/gitmem.mjs")),
    import(url("rules.mjs")),
    import(url("proxy.mjs")),
    // edit 判定/应用纯函数（审批 diff 预览复用——语义与实际执行零漂移）；
    // 旧内核无此拆分模块 → catch 置 null（diff 引擎退化为内置保守预览）
    import(url("tools/edit-diff.mjs")).catch(() => null),
    import(url("tools/shared.mjs")).catch(() => null),
    // 可选导入（.catch → null）：旧内核无此模块时只应丢「子代理面板」这一扩展面，
    // 绝不让 loadThincoder 整条 reject（那会连聊天/会话/回退一起瘫）
    import(url("agent/relay-prefix.mjs")).catch(() => null),
  ])

  // saveConfig 兼容层：旧语义（cfg 整对象覆盖落盘）→ 新 writeConfigAtomic（新鲜读 + mtime 门控）。
  // 调用方契约：cfg 来自 loadConfig() 的完整对象——不在 cfg 里的顶层键视为「被删除」（对齐旧整写语义，
  // 使 `delete rawConfig.embedding.apiKey` 这类嵌套删除生效）。
  // 派生键（DERIVED_CONFIG_KEYS）剔除：merged 独有、内核不消费——绝不写盘，顺带清掉磁盘上的历史残留。
  const saveConfig = (cfg2) => configIo.writeConfigAtomic(config.configPath, (raw) => {
    for (const k of Object.keys(raw)) if (!(k in cfg2)) delete raw[k]
    const clean = { ...cfg2 }
    for (const k of DERIVED_CONFIG_KEYS) { delete clean[k]; delete raw[k] }
    Object.assign(raw, clean)
  })

  // 会话兼容面：新内核的清单/端标记分散在 session-slots，这里补 listSlots / activeSlot /
  // currentSessionFile 三个帮助函数（manifest 值已是内容 digest，时间戳改取文件 mtime）
  const readManifestJson = (cwd) => {
    try { return JSON.parse(readFileSync(sessionSlots.manifestPath(cwd), "utf8")) } catch { return { slots: {} } }
  }
  const activeSlot = (cwd) => {
    const em = sessionSlots.readEndMarker(cwd)
    if (Number.isInteger(em?.slot) && em.slot >= 1) return em.slot
    const m = readManifestJson(cwd)
    if (Number.isInteger(m.active) && m.active >= 1) return m.active
    return null
  }
  const currentSessionFile = (cwd) => {
    const n = activeSlot(cwd)
    const p = n ? sessionSlots.slotPath(cwd, n) : sessionSlots.sessionPath(cwd) // 无活动槽 → 老格式裸文件兜底
    return existsSync(p) ? p : null
  }
  const listSlots = (cwd) => {
    const m = readManifestJson(cwd)
    const active = activeSlot(cwd)
    const out = []
    const seen = new Set()
    const add = (n) => {
      if (!Number.isInteger(n) || n < 1 || seen.has(n)) return
      seen.add(n)
      const p = sessionSlots.slotPath(cwd, n)
      if (!existsSync(p)) return
      let ts = null
      try { ts = statSync(p).mtimeMs } catch { /* 读不到就没有时间 */ }
      out.push({ slot: n, timestamp: ts, date: ts ? new Date(ts).toLocaleString() : "" })
    }
    for (const n of Object.keys(m.slots ?? {})) add(Number(n))
    const base = sessionSlots.sessionPath(cwd) // 目录里存在但清单未登记的槽文件也列出（懒恢复语义）
    const stem = basename(base)
    try {
      for (const f of readdirSync(dirname(base))) {
        const suffix = f.startsWith(stem + ".") ? f.slice(stem.length + 1) : ""
        add(Number(suffix))
      }
    } catch { /* 目录不存在就没有归档 */ }
    return out.filter((x) => x.slot !== active).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
  }

  // WebUI 统一会话恢复入口（内核 applySession 的包装）：恢复后把运行时模型对齐到 config.defaultModel。
  // 内核是「会话槽位绑定模型」语义——槽里记的 activeProvider/activeModel 恢复时覆盖运行时
  // （「defaultModel 只是新会话起点」），TUI 有会话级模型切换入口所以自洽；WebUI 的模型选择是
  // 全局设置（无会话级入口），槽里记的旧模型若不校正，重启/切槽/回退后会静默换回旧模型——
  // 设置页选中态（defaultModel 派生）与顶栏（agent 运行时）就此错位（0.5.3 实测踩坑）。
  // 对齐规则：defaultModel 有效 → 以它为准；无效/未设 → 维持槽位恢复结果（不引入新的不可用态）。
  // 返回值透传内核的 switched（调用方的 compactThreshold 重算用的是对齐后的 agent.provider.model）。
  const applySessionAligned = (agent, data, opts = {}) => {
    const switched = sessionLifecycle.applySession(agent, data, opts)
    const cfg = config.loadConfig()
    const r = config.parseModelRef(cfg.defaultModel, cfg.providersList)
    if (r.ok) {
      agent.activeProvider = r.provider.name
      agent.activeModel = r.model
      agent.provider = { ...r.provider, model: r.model }
    }
    return switched
  }

  const sessionMod = {
    ...session,
    applySession: applySessionAligned,
    switchToSlot: sessionLifecycle.switchToSlot,
    newSession: sessionLifecycle.newSession,
    resetSessionState: sessionLifecycle.resetSessionState,
    sessionPath: sessionSlots.sessionPath,
    slotPath: sessionSlots.slotPath,
    manifestPath: sessionSlots.manifestPath,
    activeSlot,
    currentSessionFile,
    listSlots,
  }

  const version = thincoderVersion()
  // 审批 diff 引擎注入缝：edit 预览复用内核 computeEditEntry（三形态共用判定/应用内核），
  // 预览语义 = 执行语义。注入失败（旧内核）→ diff 引擎保持内置保守预览，功能不降级。
  try {
    const { attachCoreEditHelpers } = await import("./diff.mjs")
    if (editDiff && shared) attachCoreEditHelpers({ computeEditEntry: editDiff.computeEditEntry, normalizeEOL: shared.normalizeEOL })
  } catch { /* diff.mjs 不可用是集成异常，runner 会立即暴露——此处不掩盖 */ }
  tc = {
    dir, version,
    agent, config: { ...config, saveConfig },
    memory,
    tools: { builtinTools: tools.builtinTools, assembleBuiltinTools: tools.assembleBuiltinTools },
    session: sessionMod,
    checkpoint, embedding, mcp, provider, gitmem, rules, proxy,
    // relay 前缀文法（agent/relay-prefix.mjs——内核"文法单一权威"）：子代理事件流分流
    // （bridge/subagents.mjs）的唯一解析源，不经此表就在 WebUI 侧自持第二套正则必漂移。
    // 模块缺失（旧内核）→ null：subagents.useRelay 会忽略，面板静默不启用，其余功能照旧
    relay: relayPrefix ? { parseRelayPath: relayPrefix.parseRelayPath, RELAY_PREFIX_RE: relayPrefix.RELAY_PREFIX_RE } : null,
    // 薄壳 tui 目录按安装形态探测：本地平级（node_modules/thincoder）与全局内嵌
    // （thincoder/node_modules/@thincoder/core）两种布局都覆盖。斜线命令表与
    // 思考程度设置（thinkingSet 复用内核 cmd-think.mjs 的 applyThink）共用此探测。
    tuiDir: [
      join(dir, "..", "..", "thincoder", "src", "tui"),
      join(dir, "..", "..", "..", "src", "tui"),
    ].find((p) => existsSync(p)) ?? null,
    // 斜线命令处理器（thincoder 薄壳 TUI 层）：按需动态 import 单个 cmd 模块——
    // /plan /eng /goal /skills /init 直接复用内核实现，语义零重实现（内核无稳定契约，
    // 重写判据必然漂移）。/new 走 WebUI 现有 sessions 链路，不经此表。
    slashCommands: (() => {
      const tuiDir = [
        join(dir, "..", "..", "thincoder", "src", "tui"),
        join(dir, "..", "..", "..", "src", "tui"),
      ].find((p) => existsSync(p))
      if (!tuiDir) return null
      const cmd = (name) => () => import(pathToFileURL(join(tuiDir, `cmd-${name}.mjs`)).href)
      return { plan: cmd("plan"), eng: cmd("eng"), goal: cmd("goal"), skills: cmd("skills"), init: cmd("init") }
    })(),
    // config-io 原子写（思考程度设置的单字段补丁落盘用；saveConfig 兼容层是整对象语义，
    // 单字段补丁走 configIo.writeConfigAtomic 直调——磁盘新鲜读，不整写）
    configIo,
  }
  return tc
}

/** git user.name（记忆条目作者；与内核一致的兜底） */
export function gitAuthor() {
  try {
    return execSync("git config user.name", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || "unknown"
  } catch {
    return "unknown"
  }
}

// ================= agent 实例池 =================

const pool = new Map() // projectDir -> { agent, ready, mcpWarnings }

/**
 * 组装一个项目的 agent（不进池、不恢复会话）。复刻内核 cli/make-agent.mjs 的 assembleAgent()：
 * config → proxy 注入 → memory(+embedder) → 规则合并 → project/team 层同步 →
 * assembleBuiltinTools（统一工具面：memory/code_search/doc_search/repo_outline/settings/…）→
 * MCP 连接 → createAgent。
 */
async function assembleAgent(projectDir) {
  const t = await loadThincoder()
  const { config: cfg, memory: mem, embedding } = t

  const config = cfg.loadConfig()
  const provider = config.provider
  const providers = config.providersList

  // 代理注入（对齐内核 make-agent：providers 注入 proxyUri；config.provider 是独立拷贝需同步）
  t.proxy.injectProxy(providers, config)
  if (provider?.name) provider.proxyUri = providers.find((p) => p.name === provider.name)?.proxyUri

  const memory = mem.createMemory({ dbPath: config.memory.dbPath })
  if (config.embedding?.apiKey) memory.embedder = embedding.createEmbedder(config.embedding)

  // code/doc 索引按项目根隔离（检索只命中本项目）
  memory.codeOrigin = projectDir

  // 项目层规则（.thincoder/rules/*.md）合并进 config；文件规则优先，config 规则追加去重（与内核一致）
  const fileRules = t.rules.discoverRules(projectDir)
  if (fileRules.length) {
    const filePatterns = new Set(fileRules.map((r) => r.pattern))
    const configRules = (config.agent?.streamRules || []).filter((r) => !filePatterns.has(r.pattern))
    config.agent.streamRules = [...fileRules, ...configRules]
  }

  // Project 层：同步 .thincoder/memory/ 到索引（有就同步，没有跳过）
  if (config.memory.projectDir) {
    memory.projectOrigin = join(projectDir, config.memory.projectDir)
    await mem.syncDir(memory, { layer: "project", dir: memory.projectOrigin })
  }
  // Team 层（可选）：首次自动 clone，启动只索引本地目录（与内核一致）
  const team = teamConfig(cfg, config)
  if (team) {
    await t.gitmem.ensureClone(team)
    await mem.syncDir(memory, { layer: "team", dir: team.dir })
  }

  // 统一工具装配（model 必传：漏传则 read_image 对所有模型静默消失——内核门控判据）
  const baseTools = await t.tools.assembleBuiltinTools({
    memory, cwd: projectDir, projectDir: config.memory.projectDir, author: gitAuthor(), team,
    model: provider?.model ?? null,
  })

  // MCP servers：并行连接，失败收集警告（与内核一致）；按项目启用偏好过滤（WebUI 层，见 store/mcp-prefs.mjs）。
  // 组装时做收养观察：config 里新出现的 server（agent 上一轮装完尚未收尾 / 终端 TUI / 手改）登记并收养给本项目，
  // 使「装完即可用」；服务进程生命周期内第一次观察只建基线不收养（见 prefs.absorbNewServers）
  const allServers = config.mcp?.servers ?? []
  absorbNewServers(allServers.map((s) => s.name), projectDir)
  const servers = enabledOnly(allServers, projectDir)
  let mcpTools = []
  const mcpWarnings = []
  if (servers.length) {
    const results = await Promise.allSettled(servers.map((srv) => t.mcp.connectMcpServer(srv)))
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (r.status === "fulfilled") mcpTools = mcpTools.concat(r.value)
      else mcpWarnings.push(`MCP server "${servers[i].name ?? servers[i].command}" 连接失败: ${r.reason?.message ?? r.reason}`)
    }
  }

  const agent = t.agent.createAgent({
    provider,
    tools: [...baseTools, ...mcpTools],
    config,
    cwd: projectDir,
    memory,
  })
  agent.providers = providers
  agent.activeProvider = provider.name ?? ""
  agent.activeModel = provider.model ?? null
  return { agent, mcpWarnings }
}

/**
 * 取（或组装）某项目的共享 agent（含会话恢复，对齐 TUI 启动行为）。
 */
export async function getAgent(projectDir) {
  const hit = pool.get(projectDir)
  if (hit) return hit

  const t = await loadThincoder()
  const { config: cfg, session: sess } = t
  const { agent, mcpWarnings } = await assembleAgent(projectDir)
  agent._mcpWarnings = mcpWarnings

  // 恢复上次会话（与 TUI 启动一致：同一项目目录的活动槽）
  let restored = null
  try {
    restored = await sess.loadSession(projectDir)
    if (restored) {
      const switched = sess.applySession(agent, restored)
      if (switched && agent.config?.agent?.compactThresholdAuto) {
        const { resolveCompactThreshold } = cfg
        agent.config.agent.compactThreshold = resolveCompactThreshold(null, agent.provider.model).value
      }
    }
  } catch { /* 恢复失败就当新会话 */ }

  const entry = { agent, restored, mcpWarnings, projectDir }
  pool.set(projectDir, entry)
  return entry
}

/**
 * 执行内核 TUI 斜线命令（WebUI 输入框 /xxx 触发）。
 * 直接复用内核 cmd-*.mjs 处理器（ctx 只补 WebUI 等价物：pushLine→返回行、
 * showPicker/askQuestion→拒绝——Web 无终端 picker，goal 无参时走「view+提示」而非交互）。
 * 返回 { ok, lines }——lines 是该命令在 TUI 中会打印的行（前端进时间线 notice）。
 */
export async function runSlashCommand(projectDir, command, args = []) {
  const t = await loadThincoder()
  const entry = await getAgent(projectDir)
  if (!entry) return { ok: false, lines: ["项目未加载"] }
  const loader = t.slashCommands?.[command]
  if (!loader) return { ok: false, lines: [`未知命令：/${command}`] }
  const lines = []
  const label = []
  const ctx = {
    agent: entry.agent,
    pushLine: (text, color) => lines.push(String(text)),
    pushLabel: (text) => label.push(String(text)),
    // Web 无终端交互件——goal 无参时由调用方降级为 view；其余命令不消费这两项
    showPicker: async () => null,
    askQuestion: async () => null,
    // /shell /config /mcp 才消费 persistRaw——本表五条命令不用；真被调用时明确拒绝，
    // 绝不做「顺手写盘」的隐式持久化
    persistRaw: () => lines.push("(该命令需持久化配置，WebUI 暂未支持此路径)"),
  }
  try {
    const mod = await loader()
    const handler = mod[`handle${command[0].toUpperCase()}${command.slice(1)}Command`]
    if (!handler) return { ok: false, lines: [`命令处理器缺失：/${command}`] }
    await handler(ctx, args)
    return { ok: true, lines: [...label, ...lines] }
  } catch (e) {
    return { ok: false, lines: [`/${command} 失败：${e?.message ?? String(e)}`] }
  }
}

/**
 * M4：为定时任务创建隔离 agent——独立历史、不入池、不读写项目会话文件，
 * 避免无人值守任务污染用户的交互会话。
 */
export async function createIsolatedAgent(projectDir) {
  const { agent } = await assembleAgent(projectDir)
  return agent
}

/**
 * 轻量旁路单次 LLM 调用：不进 agent 会话/上下文/工具链，只借内核的格式分派与代理注入
 * （追问建议这类「顺手一问」不该污染用户的对话历史）。
 *
 * provider 取用顺序：池内运行时 provider（= 顶栏所显模型）优先——用户切了模型，旁路调用
 * 应当跟随；该项目的 agent 尚未组装（没打开过）时回退磁盘配置派生的 provider。
 * 失败即 throw（调用方负责降级为「无建议」——non-fatal 是内核同类调用的既定纪律，
 * 见 core/generate-title.mjs）。
 */
export async function chatOnce(projectDir, { messages, maxTokens = 400, timeoutMs = 15000, stage = "suggest" } = {}) {
  const t = await loadThincoder()
  let base = pool.get(projectDir)?.agent?.provider ?? null
  if (!base?.apiKey) {
    const config = t.config.loadConfig()
    const providers = config.providersList ?? []
    t.proxy.injectProxy(providers, config)
    const p = config.provider
    base = p ? { ...p, proxyUri: providers.find((x) => x.name === p.name)?.proxyUri } : null
  }
  if (!base?.apiKey) throw new Error("模型未配置 API key")
  // maxTokens 传拷贝而非改 provider 本体：四种格式（openai/anthropic/google/responses）都认这个
  // 字段，但 provider 对象是池内共享实例，就地改会污染正在跑的 agent
  const r = await t.provider.chat({ ...base, maxTokens }, {
    messages,
    signal: AbortSignal.timeout(timeoutMs),
    logCtx: { stage },
  })
  return String(r?.content ?? "")
}

function teamConfig(cfg, config) {
  const team = config.memory?.team
  if (!team?.repo) return null
  const name = team.name ?? "default"
  return { name, repo: team.repo, dir: team.dir ?? join(cfg.configDir, "teams", name) }
}

/** provider 是否已配 key（前端展示"未配置"引导用） */
export function providerStatus(entry) {
  const p = entry.agent.provider ?? {}
  return {
    configured: Boolean(p.apiKey),
    provider: p.name ?? null,
    model: p.model ?? null,
    baseURL: p.baseURL ?? null,
    providers: (entry.agent.providers ?? []).map((x) => ({ name: x.name, model: x.model })),
    activeProvider: entry.agent.activeProvider ?? null,
  }
}

/**
 * 切换激活 provider（顶栏模型切换用）。
 * 持久化只写 config.defaultModel（"provider:model" 复合——内核 F-1/F-2 唯一事实源）；
 * config 层 activeProvider 字段内核已废除（loadConfig 读盘即迁移删除）——不再写盘；
 * agent 实例上的 activeProvider 仍作 WebUI 自身 UI 状态保留。
 */
export function switchProvider(projectDir, name) {
  const entry = pool.get(projectDir)
  if (!entry) return false
  const p = entry.agent.providers?.find((x) => x.name === name)
  if (!p) return false
  entry.agent.provider = { ...p }
  entry.agent.activeProvider = p.name
  entry.agent.activeModel = p.model ?? null
  const t = tc
  if (t) {
    try {
      const cfg = t.config.loadConfig()
      cfg.defaultModel = `${name}:${p.model}` // 唯一跨重启事实源（activeProvider 已废——内核 loadConfig 读盘即删该字段）
      t.config.saveConfig(cfg)
    } catch { /* 落盘失败不影响运行时切换 */ }
  }
  return true
}

export function poolEntries() {
  return pool
}

// ================= 思考程度（/think 等价面） =================

/**
 * 读当前思考设置（顶栏选择器显示用）。
 * 状态 = 池内运行时 provider 的 thinking/reasoningEffort 字段（与内核 TUI 面板头同式）；
 * 枚举 = specForModel(当前模型).reasoningEffortEnum（模型特定，不可硬编码）。
 * 池内无该项目实例时回退磁盘配置派生（未打开过的项目也能显示）。
 */
export async function thinkingGet(projectDir) {
  const t = await loadThincoder()
  const cfg = t.config.loadConfig()
  const providers = cfg.providersList ?? []
  const activeName = (() => {
    const hit = pool.get(projectDir)
    if (hit?.agent?.activeProvider) return hit.agent.activeProvider
    const r = t.config.parseModelRef(cfg.defaultModel, providers)
    return r.ok ? r.provider.name : null
  })()
  const p = (() => {
    const hit = pool.get(projectDir)
    if (hit?.agent?.provider?.name === activeName && hit.agent.provider) return hit.agent.provider
    return providers.find((x) => x.name === activeName) ?? null
  })()
  const autoThink = Boolean(
    pool.get(projectDir)?.agent?.config?.agent?.autoThink ?? cfg.agent?.autoThink ?? false
  )
  if (!p?.model) {
    return { supported: false, autoThink, provider: activeName, model: null, state: null, levels: [] }
  }
  // 内核 TUI 面板头同式（cmd-think.mjs:47-49）：thinking:null 是显式 off 标记；
  // undefined（从未设置）对 effort 型模型视为 ON（qwen3.x 服务端默认开思考）
  const spec = t.config.specForModel(p.model)
  const thinkApi = spec.thinkApi ?? "effort"
  const onValue = spec.thinkEnabledValue ?? "enabled"
  const isCustomThink = onValue !== "enabled"
  const thinkingEnabled =
    p.thinking?.type === onValue || (p.thinking !== null && p.thinking?.type === undefined && !isCustomThink)
  const levels = spec.reasoningEffortEnum ?? []
  // 「支持思考档」= 模型 spec 声明了 reasoningEffortEnum；无枚举（如 glm-4）不渲染选择器
  if (!levels.length) {
    return { supported: false, autoThink, provider: activeName, model: p.model, state: null, levels: [] }
  }
  const state = thinkingEnabled
    ? p.reasoningEffort && levels.includes(p.reasoningEffort)
      ? p.reasoningEffort // 具体档位
      : "on" // 开思考但没落具体档（服务端默认强度）；从未设置也在此（内核式「未设置即 ON」）
    : "off" // 显式关（effort 型 = thinking:null 标记；type 型 = {type:"disabled"}）
  return { supported: true, autoThink, provider: activeName, model: p.model, state, levels }
}

/**
 * 设置思考档位（顶栏选择器 /think 等价面）。
 * action: "auto"（切换 autoThink）| "off"（关思考）| "effort"（level = 具体档位）。
 * 复用内核 cmd-think.mjs 的 applyThink（命名导出，专为复用拆出）——档位归一（none→off）、
 * NF1 off 标记、autoThink 清理标记等内核语义零重实现。
 * syncProviderField 等价物：磁盘新鲜读 + 单字段补丁（configIo.writeConfigAtomic）+
 * 内存镜像（agent.providers 目标项 + agent.provider 运行时本体）——与 TUI config-helpers 同式。
 */
export async function thinkingSet(projectDir, action, level) {
  const t = await loadThincoder()
  if (!t.tuiDir) throw new Error("未找到内核 TUI 模块目录（cmd-think.mjs）")
  const entry = pool.get(projectDir)
  const agent = entry?.agent
  if (!agent) throw new Error("项目未加载")

  const spec = t.config.specForModel(agent.provider?.model ?? "")
  const thinkApi = spec.thinkApi ?? "effort"
  const onValue = spec.thinkEnabledValue ?? "enabled"
  const isCustomThink = onValue !== "enabled"
  const levels = spec.reasoningEffortEnum ?? []
  if (action === "effort" && !levels.includes(level)) {
    throw new Error(`档位 ${level} 不被模型 ${agent.provider?.model} 支持（可用：${levels.join("/") || "无"}）`)
  }
  if (action === "auto" && !levels.length) {
    throw new Error(`模型 ${agent.provider?.model} 未声明思考档位，不适用 Auto`)
  }
  // 选手动档时若 Auto-think 开启 → 先自动退出 Auto 再应用（内核 TUI 是报错引导两步走；
  // 下拉选择器的意图无歧义——选档即「退出自动并应用该档」，一步到位）。
  // autoThink 本身只改 agent.config 内存态（内核 applyThink 的 auto 动作同样不落盘）。
  if (action !== "auto" && agent.config?.agent?.autoThink === true) {
    agent.config.agent.autoThink = false
  }

  // 单字段补丁写盘（磁盘新鲜读——长跑进程不整写 providers 快照，保留对端改动）+ 内存镜像。
  // value === undefined → 删除字段。TUI config-helpers.syncProviderField 的 WebUI 等价物。
  const syncProviderField = async (name, field, value) => {
    const mem = agent.providers?.find((x) => x?.name === name)
    if (!mem) return
    const r = t.configIo.writeConfigAtomic(t.config.configPath, (raw) => {
      raw.providers ??= []
      const target = raw.providers.find((x) => x?.name === name)
      if (!target) return // 磁盘目标已被对端删除 → 只做内存镜像，不落盘
      if (value === undefined) delete target[field]
      else target[field] = value
    })
    if (!r?.ok) throw new Error("config changed on disk concurrently — retry")
    if (value === undefined) delete mem[field]
    else mem[field] = value
  }

  // F2 补齐（内核 cmd-think.mjs:117-119 裁定「选档位 = 要思考：清显式 off 标记——残留标记
  // 会与 reasoning_effort 矛盾同发」在 type 型模型的等价缺口）：effort 型的 off 标记是
  // thinking:null（内核已清）；type 型的 off 标记是 {type:"disabled"}（内核 effort/auto 分支
  // 不清——TUI 菜单流同样残留，WebUI 包装层补齐）。「选档 = 要思考」「开 Auto = 要思考」
  // 两个动作前置清掉 disabled 标记（内存 + 落盘同步），否则 body 会同时带 thinking:disabled
  // 与 reasoning_effort（或 auto 逐轮改写的 effort）——与 effort 型 F2 同型的矛盾载荷。
  if ((action === "effort" || action === "auto") && thinkApi === "type" && !isCustomThink
    && agent.provider?.thinking && agent.provider.thinking.type === "disabled") {
    delete agent.provider.thinking
    await syncProviderField(agent.activeProvider, "thinking", undefined)
  }

  // 前置状态与选后状态（供调用方回执）；applyThink 原地改 agent.provider + 落盘。
  // applyThink 内部消费 spec 的仅 reasoningEffortEnum（on 默认档取首个非 none）——直接透传 spec。
  const before = await thinkingGet(projectDir)
  const think = await import(pathToFileURL(join(t.tuiDir, "cmd-think.mjs")).href)
  await think.applyThink(
    { action, ...(action === "effort" ? { level } : {}) },
    agent,
    syncProviderField,
    spec,
    thinkApi === "effort",
    isCustomThink,
    onValue
  )
  const after = await thinkingGet(projectDir)
  return { before, after, ok: true }
}
