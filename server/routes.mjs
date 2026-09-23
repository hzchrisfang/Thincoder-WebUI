/**
 * routes.mjs — HTTP 路由分发：登录 / REST API / SSE / 静态托管（零依赖）
 */

import { join, resolve, normalize, extname, dirname } from "node:path"
import { readFile, stat, open } from "node:fs/promises"
import { existsSync, readdirSync, realpathSync, statSync, readFileSync } from "node:fs"
import { homedir, networkInterfaces } from "node:os"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { getToken, isAuthed, COOKIE_NAME } from "./lib/auth.mjs"
import * as bus from "./lib/bus.mjs"
import { listProjects, addProject, removeProject, getHost, setHost } from "./lib/state.mjs"
import { getServerReg } from "./lib/server-reg.mjs"
import * as runner from "./bridge/runner.mjs"
import * as mcp from "./bridge/mcp.mjs"
import { loadThincoder, poolEntries, runSlashCommand, getAgent } from "./bridge/thincoder.mjs"
import * as sessions from "./bridge/sessions.mjs"
import * as subagents from "./bridge/subagents.mjs"
import { suggestFollowups } from "./bridge/suggest.mjs"
import * as gitm from "./bridge/git.mjs"
import * as rewind from "./bridge/rewind.mjs"
import { queryUsage, removeUsageByProject } from "./store/usage.mjs"
import { checkKernelUpdate, compareVersions } from "./lib/kernel-update.mjs"
import * as jobsStore from "./store/jobs.mjs"
import * as scheduler from "./bridge/scheduler.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const staticDir = join(__dirname, "static")
// 版本号唯一来源：根 package.json（发版时只改这里 + CHANGELOG.md）
const WEBUI_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")).version ?? "unknown"
  } catch {
    return "unknown"
  }
})()
// 右侧文档预览的单文件读取上限（超出只回前 N 字节并标记 truncated）
const FILE_PREVIEW_LIMIT = 512 * 1024
// 本次服务进程的启动标识（每次启动重新生成）——前端比对它识别「服务重启过」，
// 用于重启后首次打开时默认展开历史面板；进程活着它就不变
const BOOT_ID = randomUUID()
// raw 预览流（/api/file?raw=1）：仅开放适合预览的文件类型；图片 10MB、网页/SVG 2MB
const RAW_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
}
const RAW_SIZE_LIMIT = { image: 10 * 1024 * 1024, doc: 2 * 1024 * 1024 }

/**
 * 列出本机可用于局域网访问的 IPv4 地址（跳过回环与内部接口）。
 * 优先返回 192.168.x / 10.x / 172.16-31.x 这类私有网段，其次链路本地/其他。
 */
function lanAddresses() {
  const out = []
  const nets = networkInterfaces()
  for (const [name, addrs] of Object.entries(nets)) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue
      out.push({ name, address: a.address })
    }
  }
  const priv = (ip) =>
    /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  // 私有网段优先，其余（如 169.254 链路本地）排后面
  return out.sort((x, y) => Number(priv(y.address)) - Number(priv(x.address)))
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".map": "application/json",
}

function json(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
  res.end(body)
}

function text(res, code, body, type = "text/plain; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type })
  res.end(body)
}

async function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolveBody, reject) => {
    let size = 0
    const chunks = []
    req.on("data", (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error("请求体过大"))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on("end", () => {
      try {
        resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {})
      } catch {
        reject(new Error("请求体不是合法 JSON"))
      }
    })
    req.on("error", reject)
  })
}

// ================= 登录 =================

function handleLogin(req, res, url) {
  const supplied = url.searchParams.get("token") ?? ""
  if (supplied && supplied === getToken()) {
    res.writeHead(302, {
      "Set-Cookie": `${COOKIE_NAME}=${encodeURIComponent(supplied)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
      Location: "/",
    })
    return res.end()
  }
  text(res, 401, "token 无效。请使用服务启动时打印的登录链接。")
}

// ================= API =================

async function handleApi(req, res, url) {
  const p = url.pathname
  const method = req.method

  try {
    // ---- 事件流 ----
    if (p === "/api/events" && method === "GET") {
      bus.initSseStream(req, res)
      const remove = bus.addClient(res)
      // 连接即推送快照（只发给该新客户端）
      res.write(`data: ${JSON.stringify({ type: "snapshot", ...runner.snapshot(), ts: Date.now() })}\n\n`)
      req.on("close", remove)
      return
    }

    // ---- 状态与项目 ----
    if (p === "/api/state" && method === "GET") return json(res, 200, runner.snapshot())

    if (p === "/api/projects" && method === "GET") return json(res, 200, { projects: listProjects() })
    if (p === "/api/projects" && method === "POST") {
      const body = await readBody(req)
      const dir = normalizePath(body.dir)
      if (!dir) return json(res, 400, { error: "缺少 dir" })
      if (!existsSync(dir) || !statSyncIsDir(dir)) return json(res, 400, { error: "目录不存在" })
      const isNew = !listProjects().some((p) => p.dir === dir)
      const projects = addProject(dir)
      if (isNew) mcp.seedProjectPrefs(dir) // 新项目 MCP 默认全不勾选（opt-in 种子，见 store/mcp-prefs.mjs）
      return json(res, 200, { projects })
    }
    if (p === "/api/projects" && method === "DELETE") {
      const body = await readBody(req)
      const dir = normalizePath(body.dir)
      if (!runner.isKnownProject(dir)) return json(res, 403, { error: "项目未在白名单中" })
      if (runner.isBusy(dir)) return json(res, 409, { error: "该项目有任务运行中，无法移除" })
      // 以下三步同步执行（原子）：清队列 → 弃内存 agent（内含未落盘历史，防止写回已删会话）→ 移出白名单（挡住新 chat）
      runner.clearQueue(dir)
      poolEntries().delete(dir)
      const projects = removeProject(dir)
      // 清该项目在 thincoder 中的历史数据；项目目录内的文件一概不动
      await sessions.purgeSessions(dir) // 内核会话：当前会话 + 归档槽位 + manifest
      rewind.resetProject(dir) // 回退点：git 快照引用 + 会话副本 + 撤销栈
      removeUsageByProject(dir) // 用量记录
      mcp.dropProjectPrefs(dir) // 「按项目启用」偏好
      subagents.clear(dir) // 子代理面板行（登记表按项目键存内存——项目移除即清，免重加时残留）
      return json(res, 200, { projects })
    }

    // ---- 目录浏览（添加项目时的资源管理器选目录） ----
    if (p === "/api/fs" && method === "GET") {
      const dir = normalizePath(url.searchParams.get("dir") || homedir())
      if (!dir || !existsSync(dir) || !statSyncIsDir(dir)) return json(res, 400, { error: "目录不存在" })
      try {
        const entries = readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith("."))
          .map((d) => ({ name: d.name }))
          .sort((a, b) => a.name.localeCompare(b.name))
        const parent = dirname(dir)
        return json(res, 200, { dir, parent: parent === dir ? null : parent, entries })
      } catch (e) {
        return json(res, 400, { error: `读取目录失败：${e.message}` })
      }
    }

    if (p === "/api/open" && method === "POST") {
      const body = await readBody(req)
      const dir = normalizePath(body.project)
      if (!runner.isKnownProject(dir)) return json(res, 403, { error: "项目未在白名单中" })
      const provider = await runner.openProject(dir)
      return json(res, 200, { provider })
    }

    // ---- 对话 ----
    if (p === "/api/chat" && method === "POST") {
      const body = await readBody(req)
      const dir = normalizePath(body.project)
      const msg = String(body.text ?? "").trim()
      if (!runner.isKnownProject(dir)) return json(res, 403, { error: "项目未在白名单中" })
      if (!msg) return json(res, 400, { error: "消息为空" })
      const msgId = runner.chat(dir, msg)
      return json(res, 202, { ok: true, msgId })
    }
    if (p === "/api/abort" && method === "POST") {
      const body = await readBody(req)
      const dir = normalizePath(body.project)
      return json(res, 200, { aborted: runner.abort(dir) })
    }
    if (p === "/api/mode" && method === "POST") {
      const body = await readBody(req)
      const dir = normalizePath(body.project)
      if (!runner.setMode(dir, body.mode)) return json(res, 400, { error: "无效模式", modes: runner.MODES })
      return json(res, 200, { ok: true })
    }

    // ---- 会话管理（M2） ----
    if (p === "/api/sessions" && method === "GET") {
      const dir = normalizePath(url.searchParams.get("project"))
      if (!runner.isKnownProject(dir)) return json(res, 403, { error: "项目未在白名单中" })
      return json(res, 200, await sessions.listSessions(dir))
    }
    if (p === "/api/history" && method === "GET") {
      const dir = normalizePath(url.searchParams.get("project"))
      if (!runner.isKnownProject(dir)) return json(res, 403, { error: "项目未在白名单中" })
      return json(res, 200, { items: await sessions.buildHistory(dir) })
    }
    // ---- 文件预览（右侧文档面板） ----
    if (p === "/api/file" && method === "GET") {
      const dir = normalizePath(url.searchParams.get("project"))
      if (!runner.isKnownProject(dir)) return json(res, 403, { error: "项目未在白名单中" })
      const rel = String(url.searchParams.get("path") ?? "")
      const abs = resolve(dir, rel)
      // 防路径穿越：解析后的绝对路径必须仍在项目目录内
      if (abs !== dir && !abs.startsWith(dir.endsWith("/") ? dir : dir + "/")) {
        return json(res, 403, { error: "路径越界" })
      }
      try {
        const st = statSync(abs)
        if (!st.isFile()) return json(res, 400, { error: "不是文件" })
        // raw 预览流：图片 / 网页直接回原始字节，供前端 <img> / <iframe> 使用
        if (url.searchParams.get("raw") === "1") {
          const ext = extname(abs).toLowerCase()
          const mime = RAW_MIME[ext]
          if (!mime) return json(res, 415, { error: "该类型不支持预览" })
          const limit = mime.startsWith("image/") ? RAW_SIZE_LIMIT.image : RAW_SIZE_LIMIT.doc
          if (st.size > limit) return json(res, 413, { error: "文件过大，无法预览" })
          res.writeHead(200, {
            "Content-Type": mime,
            "Content-Length": st.size,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            // HTML/SVG 一律进唯一源沙盒：脚本、表单、弹窗全部失效，只做静态预览
            "Content-Security-Policy": "sandbox",
          })
          res.end(await readFile(abs))
          return
        }
        if (st.size > FILE_PREVIEW_LIMIT) {
          const fh = await open(abs, "r")
          const buf = Buffer.alloc(FILE_PREVIEW_LIMIT)
          const { bytesRead } = await fh.read(buf, 0, FILE_PREVIEW_LIMIT, 0)
          await fh.close()
          return json(res, 200, {
            text: buf.subarray(0, bytesRead).toString("utf8"),
            truncated: true,
            size: st.size,
          })
        }
        return json(res, 200, { text: await readFile(abs, "utf8"), truncated: false, size: st.size })
      } catch (e) {
        return json(res, 404, { error: `读取失败：${e.code === "ENOENT" ? "文件不存在" : e.message}` })
      }
    }
    if (p === "/api/sessions/new" && method === "POST") {
      const body = await readBody(req)
      const dir = normalizePath(body.project)
      if (!runner.isKnownProject(dir)) return json(res, 403, { error: "项目未在白名单中" })
      if (runner.isBusy(dir)) return json(res, 409, { error: "运行中，无法新建会话" })
      await sessions.newSession(dir)
      rewind.resetProject(dir)
      bus.emit({ type: "session_changed", project: dir, reason: "new" })
      return json(res, 200, { ok: true })
    }
    // 斜线命令（WebUI 输入框 /xxx）：/new 走上面 sessions 链路；其余经内核 TUI 处理器。
    // 运行中不接受命令（/plan /eng 翻转运行时状态，跑一半翻会撕裂该轮语义）
    if (p === "/api/command" && method === "POST") {
      const body = await readBody(req)
      const dir = normalizePath(body.project)
      if (!runner.isKnownProject(dir)) return json(res, 403, { error: "项目未在白名单中" })
      if (runner.isBusy(dir)) return json(res, 409, { error: "运行中，无法执行命令" })
      const command = String(body.command ?? "").replace(/^\//, "").toLowerCase()
      const args = Array.isArray(body.args) ? body.args.map(String) : []
      // /new：复用现有新建会话链路（等价 TUI /new：归档旧槽 + 重置回退栈）
      if (command === "new") {
        await sessions.newSession(dir)
        rewind.resetProject(dir)
        bus.emit({ type: "session_changed", project: dir, reason: "new" })
        return json(res, 200, { ok: true, lines: ["已新建会话（原会话归档）"] })
      }
      // /goal 无参在 TUI 里是交互 picker——Web 降级为查看当前目标
      if (command === "goal" && args.length === 0) args.push("view")
      const r = await runSlashCommand(dir, command, args)
      // /plan /eng 翻转了 agent 运行时状态——广播让全部在线页面同步（顶栏 PLAN 徽标等）
      if (r.ok && (command === "plan" || command === "eng")) {
        const entry = await getAgent(dir)
        bus.emit({ type: "plan_mode", project: dir, planMode: Boolean(entry?.agent?.planMode) })
      }
      return json(res, r.ok ? 200 : 400, r)
    }
    // 一轮结束后自动生成的追问建议（旁路小调用，不进会话）。运行中不生成：上下文还在变，
    // 前端此时也不该拉；生成失败返回空数组（前端语义 = 没有建议）
    if (p === "/api/suggest" && method === "POST") {
      const body = await readBody(req)
      const dir = normalizePath(body.project)
      if (!runner.isKnownProject(dir)) return json(res, 403, { error: "项目未在白名单中" })
      if (runner.isBusy(dir)) return json(res, 200, { suggestions: [] })
      const suggestions = await suggestFollowups(dir, {
        user: typeof body.user === "string" ? body.user : "",
        assistant: typeof body.assistant === "string" ? body.assistant : "",
        planMode: Boolean(body.planMode),
      })
      return json(res, 200, { suggestions })
    }
    if (p === "/api/sessions/switch" && method === "POST") {
      const body = await readBody(req)
      const dir = normalizePath(body.project)
      if (!runner.isKnownProject(dir)) return json(res, 403, { error: "项目未在白名单中" })
      if (runner.isBusy(dir)) return json(res, 409, { error: "运行中，无法切换会话" })
      await sessions.switchSession(dir, body.slot)
      rewind.resetProject(dir)
      bus.emit({ type: "session_changed", project: dir, reason: "switch", slot: Number(body.slot) })
      return json(res, 200, { ok: true })
    }
    if (p === "/api/sessions/delete" && method === "POST") {
      // 删除归档槽位（纯文件操作：不影响当前会话，运行中也可执行）
      const body = await readBody(req)
      const dir = normalizePath(body.project)
      if (!runner.isKnownProject(dir)) return json(res, 403, { error: "项目未在白名单中" })
      try {
        const slot = await sessions.deleteSlot(dir, body.slot)
        bus.emit({ type: "session_changed", project: dir, reason: "delete", slot })
        return json(res, 200, { ok: true, slot })
      } catch (err) {
        return json(res, 404, { error: err?.message ?? String(err) })
      }
    }

    // ---- 审批 / 问答 ----
    if (p === "/api/decision" && method === "POST") {
      const body = await readBody(req)
      const ok = runner.decidePermission(body.reqId, Boolean(body.allow), Boolean(body.remember))
      return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: "审批请求不存在或已处理" })
    }
    if (p === "/api/answer" && method === "POST") {
      const body = await readBody(req)
      const ok = runner.answerQuestion(body.reqId, body.answer)
      return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: "提问不存在或已回答" })
    }

    // ---- 工具结果按需拉取 ----
    if (p.startsWith("/api/tool-result/") && method === "GET") {
      const callId = p.slice("/api/tool-result/".length)
      const result = runner.getToolResult(callId)
      return result == null ? json(res, 404, { error: "无此结果（可能已过期）" }) : json(res, 200, { callId, result })
    }

    // ---- 配置（M3 全集：providers CRUD / 激活 / 连接测试 / embedding） ----
    if (p === "/api/config/presets" && method === "GET") {
      const t = await loadThincoder()
      const presets = Object.entries(t.config.PROVIDER_PRESETS).map(([name, v]) => ({
        name, desc: v.desc, baseURL: v.baseURL, model: v.model,
      }))
      return json(res, 200, { presets })
    }
    if (p === "/api/config/providers" && method === "GET") {
      const t = await loadThincoder()
      const cfg = t.config.loadConfig()
      return json(res, 200, {
        providers: (cfg.providersList ?? []).map(maskProvider),
        activeProvider: activeProviderName(t, cfg.defaultModel, cfg.providersList),
        embedding: {
          configured: Boolean(cfg.embedding?.apiKey),
          baseURL: cfg.embedding?.baseURL ?? null,
          model: cfg.embedding?.model ?? null,
        },
      })
    }
    if (p === "/api/config/provider" && method === "POST") {
      // 快速配置入口（SetupPanel）：upsert + 设为激活
      const body = await readBody(req)
      const { name, baseURL, apiKey, model } = body
      if (!name || !baseURL || !apiKey || !model) return json(res, 400, { error: "name/baseURL/apiKey/model 均为必填" })
      if (!/^https?:\/\//.test(baseURL)) return json(res, 400, { error: "baseURL 需为 http(s) 地址" })
      const t = await loadThincoder()
      upsertProvider(t, { name, baseURL, apiKey, model })
      setActiveProvider(t, name)
      return json(res, 200, { ok: true, activeProvider: name })
    }
    if (p === "/api/config/providers" && method === "PUT") {
      const body = await readBody(req)
      const { name, baseURL, apiKey, model } = body
      if (!name || !baseURL || !model) return json(res, 400, { error: "name/baseURL/model 均为必填" })
      if (!/^https?:\/\//.test(baseURL)) return json(res, 400, { error: "baseURL 需为 http(s) 地址" })
      const t = await loadThincoder()
      upsertProvider(t, { name, baseURL, apiKey, model }) // apiKey 留空 = 保留原 key
      return json(res, 200, { ok: true })
    }
    if (p === "/api/config/providers" && method === "DELETE") {
      const body = await readBody(req)
      const name = String(body.name ?? "")
      if (!name) return json(res, 400, { error: "缺少 name" })
      const t = await loadThincoder()
      const rawConfig = t.config.loadConfig()
      const providers = (rawConfig.providers ?? []).filter((x) => x.name !== name)
      if (providers.length === (rawConfig.providers ?? []).length) return json(res, 404, { error: "供应商不存在" })
      // 「删除的是当前默认渠道」判据 = defaultModel 指向它（activeProvider 已废——内核 loadConfig 读盘即删该字段）
      const removedActive = activeProviderName(t, rawConfig.defaultModel, rawConfig.providers) === name
      rawConfig.providers = providers
      if (removedActive) {
        const next = providers[0]
        // defaultModel 指向已删渠道 → 回退首个渠道；无渠道/无模型 → null（运行时解析为空，前端显示未配置）
        rawConfig.defaultModel = next?.model ? `${next.name}:${next.model}` : null
      }
      t.config.saveConfig(rawConfig)
      // 实例池同步：移除该 provider；若某实例正在用它，切到 defaultModel 指向的渠道（没有则标记未配置）
      const fallbackName = activeProviderName(t, rawConfig.defaultModel, providers)
      for (const entry of poolEntries().values()) {
        entry.agent.providers = (entry.agent.providers ?? []).filter((x) => x.name !== name)
        if (entry.agent.provider?.name === name) {
          const next = entry.agent.providers.find((x) => x.name === fallbackName) ?? entry.agent.providers[0]
          if (next) {
            entry.agent.provider = { ...next }
            entry.agent.activeProvider = next.name
          } else {
            entry.agent.provider = { name, baseURL: "", apiKey: "", model: "" }
            entry.agent.activeProvider = null
          }
        }
      }
      return json(res, 200, { ok: true, activeProvider: fallbackName })
    }
    if (p === "/api/config/active" && method === "POST") {
      const body = await readBody(req)
      const name = String(body.name ?? "")
      const t = await loadThincoder()
      const cfg = t.config.loadConfig()
      if (!(cfg.providersList ?? []).some((x) => x.name === name)) return json(res, 404, { error: "供应商不存在" })
      setActiveProvider(t, name)
      return json(res, 200, { ok: true, activeProvider: name })
    }
    if (p === "/api/config/test" && method === "POST") {
      const body = await readBody(req)
      const t = await loadThincoder()
      let spec = { baseURL: body.baseURL, apiKey: body.apiKey, model: body.model }
      if (body.name) {
        const cfg = t.config.loadConfig()
        const found = (cfg.providersList ?? []).find((x) => x.name === body.name)
        if (!found) return json(res, 404, { error: "供应商不存在" })
        spec = { baseURL: found.baseURL, apiKey: body.apiKey || found.apiKey, model: found.model }
      }
      if (!spec.baseURL || !spec.apiKey || !spec.model) return json(res, 400, { error: "缺少 baseURL/apiKey/model" })
      try {
        const provider = t.provider.createProvider(spec)
        const models = await t.provider.listModels(provider, { signal: AbortSignal.timeout(8000) })
        return json(res, 200, { ok: true, models })
      } catch (err) {
        return json(res, 200, { ok: false, error: err?.message ?? String(err) })
      }
    }
    if (p === "/api/config/embedding" && method === "PUT") {
      const body = await readBody(req)
      const apiKey = String(body.apiKey ?? "").trim()
      const t = await loadThincoder()
      const rawConfig = t.config.loadConfig()
      rawConfig.embedding = { ...(rawConfig.embedding ?? {}) }
      if (apiKey) rawConfig.embedding.apiKey = apiKey
      else delete rawConfig.embedding.apiKey
      t.config.saveConfig(rawConfig)
      // 实例池热更新向量检索开关
      for (const entry of poolEntries().values()) {
        if (!entry.agent.memory) continue
        entry.agent.memory.embedder = apiKey ? t.embedding.createEmbedder(rawConfig.embedding) : null
      }
      return json(res, 200, { ok: true, configured: Boolean(apiKey) })
    }

    // ---- MCP 服务器（安装 / 维护：stdio 或 HTTP；写内核 config + 实例池热更新） ----
    if (p === "/api/mcp" && method === "GET") {
      const dir = requireProject(url, runner) // 非白名单/未提供 → 只给配置与模板，无实例状态
      return json(res, 200, {
        servers: await mcp.listServers(),
        presets: mcp.mcpPresets(dir),
        status: mcp.statusFor(dir),
        enabled: await mcp.enabledList(dir),
      })
    }
    if (p === "/api/mcp/project" && method === "PUT") {
      // 按项目启用/停用：{project, enabled:[server 名]}（opt-in 名单，空数组 = 全不启用）
      const body = await readBody(req)
      const dir = normalizePath(body.project)
      if (!dir || !runner.isKnownProject(dir)) return json(res, 403, { error: "项目未在白名单中" })
      try {
        return json(res, 200, { ok: true, ...(await mcp.setProjectEnabled(dir, body.enabled)) })
      } catch (err) {
        return json(res, 400, { error: err?.message ?? String(err) })
      }
    }
    if (p === "/api/mcp/servers" && method === "POST") {
      const body = await readBody(req)
      try {
        return json(res, 200, { ok: true, ...(await mcp.addServer(body)) })
      } catch (err) {
        return json(res, 400, { error: err?.message ?? String(err) })
      }
    }
    if (p === "/api/mcp/servers" && method === "PUT") {
      const body = await readBody(req)
      try {
        return json(res, 200, { ok: true, ...(await mcp.updateServer(body)) })
      } catch (err) {
        return json(res, 400, { error: err?.message ?? String(err) })
      }
    }
    if (p === "/api/mcp/servers" && method === "DELETE") {
      const body = await readBody(req)
      try {
        return json(res, 200, { ok: true, ...(await mcp.removeServer(String(body.name ?? ""))) })
      } catch (err) {
        return json(res, 400, { error: err?.message ?? String(err) })
      }
    }
    if (p === "/api/mcp/test" && method === "POST") {
      const body = await readBody(req)
      try {
        return json(res, 200, await mcp.testServer(body)) // 失败也 200：结果里带 ok/error
      } catch (err) {
        return json(res, 400, { error: err?.message ?? String(err) })
      }
    }
    if (p === "/api/mcp/import" && method === "POST") {
      // 粘贴 JSON 导入（mcpServers 等格式）；解析级错误 400，单条错误在 failed 里
      const body = await readBody(req)
      try {
        return json(res, 200, { ok: true, ...(await mcp.importServers(body.json ?? body)) })
      } catch (err) {
        return json(res, 400, { error: err?.message ?? String(err) })
      }
    }
    if (p === "/api/mcp/reconnect" && method === "POST") {
      const body = await readBody(req)
      const dir = requireProject(url, runner)
      try {
        return json(res, 200, { ok: true, ...(await mcp.reconnect(body.name ? String(body.name) : null, dir)) })
      } catch (err) {
        return json(res, 400, { error: err?.message ?? String(err) })
      }
    }

    // ---- 用量（M3） ----
    if (p === "/api/usage" && method === "GET") {
      const raw = url.searchParams.get("days")
      // days=0 → 「当天」：本地零点起算
      if (raw !== null && Number(raw) === 0) {
        const midnight = new Date()
        midnight.setHours(0, 0, 0, 0)
        return json(res, 200, queryUsage({ fromTs: midnight.getTime() }))
      }
      const days = Math.min(365, Math.max(1, Number(raw ?? 7) || 7))
      return json(res, 200, queryUsage({ days }))
    }

    // ---- Git 与检查点（M3，只读优先） ----
    if (p === "/api/git/status" && method === "GET") {
      const dir = requireProject(url, runner)
      if (dir === null) return json(res, 403, { error: "项目未在白名单中" })
      if (!gitm.isRepo(dir)) return json(res, 200, { repo: false })
      return json(res, 200, gitm.gitStatus(dir))
    }
    if (p === "/api/git/log" && method === "GET") {
      const dir = requireProject(url, runner)
      if (dir === null) return json(res, 403, { error: "项目未在白名单中" })
      if (!gitm.isRepo(dir)) return json(res, 200, { repo: false, commits: [] })
      return json(res, 200, { repo: true, commits: gitm.gitLog(dir, Number(url.searchParams.get("n") ?? 30)) })
    }
    if (p === "/api/git/diff" && method === "GET") {
      const dir = requireProject(url, runner)
      if (dir === null) return json(res, 403, { error: "项目未在白名单中" })
      const path = url.searchParams.get("path")
      if (!path) return json(res, 400, { error: "缺少 path" })
      if (!gitm.isRepo(dir)) return json(res, 200, { repo: false })
      return json(res, 200, { repo: true, ...gitm.gitFileDiff(dir, path, { staged: url.searchParams.get("staged") === "1" }) })
    }
    if (p === "/api/checkpoints" && method === "GET") {
      const dir = requireProject(url, runner)
      if (dir === null) return json(res, 403, { error: "项目未在白名单中" })
      return json(res, 200, { checkpoints: await gitm.listCheckpoints(dir) })
    }
    if (p === "/api/checkpoints/create" && method === "POST") {
      const body = await readBody(req)
      const dir = normalizePath(body.project)
      if (!runner.isKnownProject(dir)) return json(res, 403, { error: "项目未在白名单中" })
      return json(res, 200, { checkpoint: await gitm.createCheckpoint(dir) })
    }
    if (p === "/api/checkpoints/rewind" && method === "POST") {
      const body = await readBody(req)
      const dir = normalizePath(body.project)
      if (!runner.isKnownProject(dir)) return json(res, 403, { error: "项目未在白名单中" })
      if (runner.isBusy(dir)) return json(res, 409, { error: "运行中，无法回滚（文件可能正在被修改）" })
      const summary = await gitm.rewindCheckpoint(dir, body.id)
      bus.emit({ type: "system", project: dir, text: `已回滚到检查点 ${body.id}（回滚前的状态已自动存为新快照）` })
      return json(res, 200, { ok: true, summary })
    }

    // ---- 会话回退（复制 / 回退） ----
    if (p === "/api/rewind/points" && method === "GET") {
      const dir = requireProject(url, runner)
      if (dir === null) return json(res, 403, { error: "项目未在白名单中" })
      return json(res, 200, rewind.listPoints(dir))
    }
    if (p === "/api/rewind/preview" && method === "GET") {
      const dir = requireProject(url, runner)
      if (dir === null) return json(res, 403, { error: "项目未在白名单中" })
      const id = url.searchParams.get("id")
      if (!id) return json(res, 400, { error: "缺少 id" })
      if (runner.isBusy(dir)) return json(res, 409, { error: "运行中，无法回退" })
      try {
        return json(res, 200, rewind.previewRollback(dir, id))
      } catch (e) {
        return json(res, 404, { error: e.message })
      }
    }
    if (p === "/api/rewind" && method === "POST") {
      const body = await readBody(req)
      const dir = normalizePath(body.project)
      if (!runner.isKnownProject(dir)) return json(res, 403, { error: "项目未在白名单中" })
      if (runner.isBusy(dir)) return json(res, 409, { error: "运行中，无法回退（文件可能正在被修改）" })
      // 独占项目：挡住在回退过程中新到达的消息，并摘走待发队列（回退后它们对应的状态已不存在）
      const exclusive = runner.beginExclusive(dir)
      if (!exclusive) return json(res, 409, { error: "运行中，无法回退" })
      let summary
      try {
        summary = await rewind.rollback(dir, String(body.id ?? ""))
      } catch (e) {
        runner.endExclusive(dir, exclusive.carry) // 失败：把队列还回去，什么都不丢
        return json(res, 400, { error: e.message })
      }
      const cleared = exclusive.carry.length
      runner.endExclusive(dir) // 成功：待发队列作废（已在上方数量里告知用户）
      bus.emit({ type: "rewound", project: dir, ...summary, cleared })
      return json(res, 200, { ok: true, summary: { ...summary, cleared } })
    }
    if (p === "/api/rewind/undo" && method === "POST") {
      const body = await readBody(req)
      const dir = normalizePath(body.project)
      if (!runner.isKnownProject(dir)) return json(res, 403, { error: "项目未在白名单中" })
      if (runner.isBusy(dir)) return json(res, 409, { error: "运行中，无法撤销回退" })
      const exclusive = runner.beginExclusive(dir)
      if (!exclusive) return json(res, 409, { error: "运行中，无法撤销回退" })
      let summary
      try {
        summary = await rewind.undoRollback(dir)
      } catch (e) {
        runner.endExclusive(dir, exclusive.carry)
        return json(res, 400, { error: e.message })
      }
      runner.endExclusive(dir)
      bus.emit({ type: "rewound", project: dir, undo: true, ...summary })
      return json(res, 200, { ok: true, summary })
    }

    // ---- 定时任务（M4） ----
    if (p === "/api/jobs" && method === "GET") {
      return json(res, 200, { jobs: scheduler.listJobs() })
    }
    if (p === "/api/jobs" && method === "POST") {
      const body = await readBody(req)
      const job = scheduler.createJob(body)
      return json(res, 200, { job })
    }
    if (p === "/api/jobs" && method === "PUT") {
      const body = await readBody(req)
      if (!body.id) return json(res, 400, { error: "缺少 id" })
      const job = scheduler.updateJob(String(body.id), body)
      return json(res, 200, { job })
    }
    if (p === "/api/jobs" && method === "DELETE") {
      const body = await readBody(req)
      const ok = scheduler.deleteJob(String(body.id ?? ""))
      return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: "任务不存在" })
    }
    if (p === "/api/jobs/run" && method === "POST") {
      const body = await readBody(req)
      scheduler.runJobNow(String(body.id ?? ""))
      return json(res, 202, { ok: true })
    }
    if (p.startsWith("/api/jobs/") && p.endsWith("/runs") && method === "GET") {
      const id = p.slice("/api/jobs/".length, -"/runs".length)
      return json(res, 200, { runs: jobsStore.listRuns(id, Number(url.searchParams.get("limit") ?? 50)) })
    }

    // ---- 安全（M3） ----
    if (p === "/api/host" && method === "GET") {
      return json(res, 200, {
        host: getHost(),
        port: getServerReg()?.port ?? null,
        lanAddresses: lanAddresses(),
      })
    }
    if (p === "/api/host" && method === "POST") {
      const body = await readBody(req)
      const host = String(body.host ?? "")
      if (!["0.0.0.0", "127.0.0.1"].includes(host)) return json(res, 400, { error: "host 仅支持 0.0.0.0 或 127.0.0.1" })
      setHost(host)
      json(res, 200, { ok: true, host })
      // 先让本次应答冲刷出去，再断开其余连接（含 SSE 长连接，否则 close 永远等不完），
      // 在 close 完成回调里换 host 重新 listen（直接 listen 会因服务未真正关闭而报错）
      const reg = getServerReg()
      if (reg) {
        setTimeout(() => {
          try { reg.server.closeAllConnections?.() } catch { /* 忽略 */ }
          reg.server.close(() => {
            reg.server.listen(reg.port, host)
          })
        }, 30)
      }
      return
    }
    if (p === "/api/token" && method === "GET") {
      return json(res, 200, { token: getToken() })
    }

    // ---- 元信息 ----
    if (p === "/api/version" && method === "GET") {
      let thincoderVersion = null
      try { thincoderVersion = (await loadThincoder()).version } catch { /* 未安装 */ }
      return json(res, 200, { webui: WEBUI_VERSION, thincoder: thincoderVersion, boot: BOOT_ID })
    }
    // 内核最新版检查（服务端带 TTL 缓存，成功 4h / 失败 5min；并发共享在途请求）
    if (p === "/api/kernel-update" && method === "GET") {
      let thincoderVersion = null
      try { thincoderVersion = (await loadThincoder()).version } catch { /* 未安装 */ }
      const u = await checkKernelUpdate()
      return json(res, 200, {
        installed: thincoderVersion,
        latest: u.latest,
        source: u.source,
        checkedAt: u.checkedAt,
        error: u.error,
        outdated: !!(thincoderVersion && u.latest && compareVersions(u.latest, thincoderVersion) > 0),
      })
    }

    json(res, 404, { error: `未知接口 ${method} ${p}` })
  } catch (err) {
    json(res, 500, { error: err?.message ?? String(err) })
  }
}

// ================= 静态托管 =================

async function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") return text(res, 405, "Method Not Allowed")
  if (!existsSync(staticDir)) {
    return text(res, 503, "前端尚未构建：请先 `npm run build`（或开发模式 `npm run dev`）。", "text/plain; charset=utf-8")
  }
  let pathname = decodeURIComponent(url.pathname)
  if (pathname === "/") pathname = "/index.html"
  const filePath = resolve(join(staticDir, normalize(pathname)))
  // 防路径穿越
  if (!filePath.startsWith(staticDir)) return text(res, 403, "Forbidden")
  try {
    const s = await stat(filePath)
    if (s.isDirectory()) return text(res, 403, "Forbidden")
    const data = await readFile(filePath)
    const mime = MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream"
    res.writeHead(200, {
      "Content-Type": mime,
      "Cache-Control": pathname === "/index.html" ? "no-cache" : "public, max-age=31536000, immutable",
    })
    res.end(req.method === "HEAD" ? undefined : data)
  } catch {
    // SPA 回退：非文件路径一律给 index.html（前端路由）
    try {
      const data = await readFile(join(staticDir, "index.html"))
      res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" })
      res.end(data)
    } catch {
      text(res, 404, "Not Found")
    }
  }
}

// ================= 工具 =================

function normalizePath(p) {
  if (!p || typeof p !== "string") return null
  try {
    const abs = resolve(p.startsWith("~") ? join(process.env.HOME ?? "", p.slice(1)) : p)
    return existsSync(abs) ? realpathSync(abs) : abs
  } catch {
    return null
  }
}

/** 查询参数取项目（白名单外返回 null） */
function requireProject(url, runnerRef) {
  const dir = normalizePath(url.searchParams.get("project"))
  return runnerRef.isKnownProject(dir) ? dir : null
}

/** key 脱敏：只露尾 4 位 */
function maskProvider(pv) {
  const key = pv.apiKey ?? ""
  return {
    name: pv.name,
    baseURL: pv.baseURL ?? "",
    model: pv.model ?? "",
    hasKey: Boolean(key),
    keyTail: key ? key.slice(-4) : "",
  }
}

/** 当前默认渠道名——由 defaultModel（"provider:model" 复合，唯一跨重启事实源）派生，无效/缺失 → null。
 *  0.12.x 起内核 loadConfig 把 legacy activeProvider 迁移进 defaultModel 后读盘即删该字段——
 *  它只能当派生只读值用，任何写盘都会被内核在下一次读盘时抹掉。 */
function activeProviderName(t, defaultModel, providers) {
  const r = t.config.parseModelRef(defaultModel, providers ?? [])
  return r.ok ? r.provider.name : null
}

/** provider upsert：写内核 config + 热更新实例池（apiKey 缺省 = 保留原 key） */
function upsertProvider(t, { name, baseURL, apiKey, model }) {
  const rawConfig = t.config.loadConfig()
  const providers = rawConfig.providers ?? []
  const existing = providers.find((x) => x.name === name)
  if (existing) {
    Object.assign(existing, { baseURL, model })
    if (apiKey) existing.apiKey = apiKey
  } else {
    if (!apiKey) throw new Error("新增供应商必须提供 apiKey")
    providers.push({ name, baseURL, apiKey, model })
  }
  rawConfig.providers = providers
  const active = activeProviderName(t, rawConfig.defaultModel, providers)
  // defaultModel 是唯一跨重启事实源（activeProvider 已废）：无有效默认渠道 → 本次渠道兜底（首次配置入口）；
  // 编辑的正是默认渠道 → 同步模型段（运行时模型段优先于 providers[].model）；其余情况不动——不覆盖用户当前选择
  if (!active || active === name) rawConfig.defaultModel = `${name}:${model}`
  t.config.saveConfig(rawConfig)
  for (const entry of poolEntries().values()) {
    let pp = entry.agent.providers?.find((x) => x.name === name)
    if (!pp) {
      pp = { name, baseURL, apiKey: apiKey ?? "", model }
      entry.agent.providers = [...(entry.agent.providers ?? []), pp]
    } else {
      Object.assign(pp, { baseURL, model })
      if (apiKey) pp.apiKey = apiKey
    }
    if (entry.agent.provider?.name === name) {
      entry.agent.provider = { ...pp }
      entry.agent.activeProvider = name
    }
  }
}

/** 切换激活 provider：写内核 config + 热更新实例池当前模型 */
function setActiveProvider(t, name) {
  const rawConfig = t.config.loadConfig()
  const found = (rawConfig.providers ?? []).find((x) => x.name === name)
  if (!found) throw new Error("供应商不存在")
  rawConfig.defaultModel = `${name}:${found.model}` // 唯一跨重启事实源（activeProvider 已废——内核 loadConfig 读盘即删该字段）
  t.config.saveConfig(rawConfig)
  for (const entry of poolEntries().values()) {
    let pp = entry.agent.providers?.find((x) => x.name === name)
    if (!pp) {
      pp = { ...found }
      entry.agent.providers = [...(entry.agent.providers ?? []), pp]
    }
    entry.agent.provider = { ...pp }
    entry.agent.activeProvider = name
  }
}

function statSyncIsDir(dir) {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

// ================= 入口 =================

// 免鉴权公开资源：浏览器会在「不带 cookie」的请求里抓这几个文件——Chrome 拉 web app manifest 的凭据模式
// 与普通子资源不同（实测其请求不带 token cookie），带鉴权会让它 401：manifest 读不到 → 站点永远不可安装，
// 只能退回「创建快捷方式」，落盘 shim 图标退化成字母占位图（2026-09-22 实测取证）。
// 清单只含品牌图标与 manifest，不含任何数据接口与页面。
const PUBLIC_ASSETS = new Set([
  "/site.webmanifest",
  "/favicon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
])

export async function handleRequest(req, res) {
  const url = new URL(req.url, "http://localhost")

  if (url.pathname === "/login") return handleLogin(req, res, url)
  if (!PUBLIC_ASSETS.has(url.pathname) && !isAuthed(req, url)) {
    if (url.pathname.startsWith("/api/")) return json(res, 401, { error: "未授权：请使用登录链接进入" })
    return text(res, 401, "<h2>未授权</h2><p>请使用服务启动时打印的登录链接访问。</p>", "text/html; charset=utf-8")
  }
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url)
  return serveStatic(req, res, url)
}
