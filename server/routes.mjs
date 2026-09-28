/**
 * routes.mjs — HTTP 路由分发：登录 / REST API / SSE / 静态托管（零依赖）
 */

import { join, resolve, normalize, extname, dirname, relative, isAbsolute, sep } from "node:path"
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
import * as skills from "./bridge/skills.mjs"
import * as skillImport from "./bridge/skills-import.mjs"
import { loadThincoder, poolEntries, runSlashCommand, getAgent, thinkingGet, thinkingSet } from "./bridge/thincoder.mjs"
import * as sessions from "./bridge/sessions.mjs"
import * as subagents from "./bridge/subagents.mjs"
import { suggestFollowups } from "./bridge/suggest.mjs"
import * as gitm from "./bridge/git.mjs"
import * as rewind from "./bridge/rewind.mjs"
import { queryUsage, removeUsageByProject } from "./store/usage.mjs"
import { checkKernelUpdate, compareVersions } from "./lib/kernel-update.mjs"
import { checkWebuiUpdate } from "./lib/webui-update.mjs"
import { startWebuiUpdate, webuiUpdateState } from "./lib/webui-apply.mjs"
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

    // 「位置」枚举（盘符 / 挂载卷 / 根）：win32 上 C:\ 与 D:\ 是互不相邻的独立树——dirname 到盘根
    // 返回自身（实测 win32 dirname("C:\\") === "C:\\"），「上一级」走到 C:\ 即到顶；界面上没有
    // 枚举入口，别的盘就永远不可达（不是路径处理错，是导航入口缺失）
    if (p === "/api/fs/roots" && method === "GET") return json(res, 200, { roots: listFsRoots() })

    // ---- 目录浏览（添加项目选目录 / 输入框插文件路径；files=1 时同时返回文件条目） ----
    if (p === "/api/fs" && method === "GET") {
      const dir = normalizePath(url.searchParams.get("dir") || homedir())
      const withFiles = url.searchParams.get("files") === "1"
      if (!dir || !existsSync(dir) || !statSyncIsDir(dir)) return json(res, 400, { error: "目录不存在" })
      try {
        const entries = readdirSync(dir, { withFileTypes: true })
          .filter((d) => !d.name.startsWith(".") && (d.isDirectory() || withFiles))
          .map((d) => ({ name: d.name, isDir: d.isDirectory() }))
          .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
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
      // 防路径穿越：relative 判定（前缀 startsWith 在 Windows 反斜杠分隔符下失效）——
      // abs 不在 dir 下时 relative 返回 ".."/".."+sep 开头或绝对路径；abs === dir（请求目录本身）也拒。
      // 注意用 ".."+sep 而非裸 startsWith("..")：后者会把 "..config" 这类合法文件误杀
      const relCheck = relative(dir, abs)
      if (relCheck === "" || relCheck === ".." || relCheck.startsWith(".." + sep) || isAbsolute(relCheck)) {
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
        activeModel: activeModelOf(t, cfg.defaultModel, cfg.providersList),
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
      // 渠道删除 + 三类级联（默认渠道回退 / 子代理三档 / 会诊条目）**合成一次原子写盘**。
      // 为何不能拆两次写（先前实现 = saveConfig 落渠道与会诊、再 writeSubagentModelPatch 清子代理/审阅）：
      // 第二次写有失败路径（mtime 冲突）⇒ 盘上留下**半态**：渠道已删、子代理/审阅引用还在（派发即失败），
      // 前端收 500 以为没删成，**重试只会得 404**（渠道已不在）——残留只能去设置页手点一次「跟随主线」才能清。
      // 子代理模型级联：三类引用中**指向被删渠道**的，本次一并清成「跟随主线」——否则删渠道后
      // 子任务/评审仍指向不存在的渠道，派发即失败（悬挂引用）。
      // ⚠️ 判据**必须作用在原始存储值上**，不能拿 subagentModelsOf 的**合成值**来判：角色槽的合成值
      // 可能是「主线渠道:裸模型名」（内核 `resolveChildProvider` 把非渠道裸值当主线上的模型名用），
      // 用合成值判会把一条与本次删除**无关**的配置误清成跟随主线。
      // 判据与内核自己的级联同式：`v === name || v.startsWith(name + ":")`（core/config-io.mjs:189，
      // 含**裸渠道名**那一支）；会诊条目**只能移除、不能回退**（没有继承语义，内侧 loadConfig 会在
      // 合并态滤掉指向未知渠道的条目、但**不动盘**——同名渠道重建即无声复活）。
      // 报告用的 `reverted` / `droppedConsult` 在 mutate 闭包里收集：`writeConfigAtomic` 的 mutate
      // 确认只跑一次（冲突时不重跑、直接返 `{ok:false}`），闭包捕获安全。
      let reverts = []
      let droppedConsult = []
      const w = await t.configIo.writeConfigAtomic(t.config.configPath, (raw) => {
        const before = Array.isArray(raw.providers) ? raw.providers : []
        // 「删除的是当前默认渠道」判据 = defaultModel 指向它（activeProvider 已废——内核 loadConfig 读盘即删该字段）
        const wasActive = activeProviderName(t, raw.defaultModel, before) === name
        raw.providers = before.filter((x) => x.name !== name)
        if (wasActive) {
          // defaultModel 指向已删渠道 → 回退首个渠道；无渠道/无模型 → null（运行时解析为空，前端显示未配置）
          const next = raw.providers[0]
          raw.defaultModel = next?.model ? `${next.name}:${next.model}` : null
        }
        reverts = []
        droppedConsult = raw.agent ? dropConsultModelsOf(raw.agent, name) : []
        const sub = raw.agent?.subagentModels
        if (sub && typeof sub === "object") {
          for (const kind of ["explore", "coder"]) {
            const v = sub[kind]
            if (typeof v === "string" && (v === name || v.startsWith(`${name}:`))) {
              delete sub[kind]
              reverts.push(kind)
            }
          }
          if (!Object.keys(sub).length) delete raw.agent.subagentModels
        }
        const adv = raw.agent?.advisor
        if (adv && typeof adv === "object" && adv.provider === name) {
          // provider 与 model **成对清**（残留 model 会被内核贴回主线渠道，「跟随主线」静默失效）；
          // guard 等其它 advisor 设置保留（与 writeSubagentModelPatch 的清除分支同口径）。
          delete adv.provider
          delete adv.model
          reverts.push("advisor")
          if (!Object.keys(adv).length) delete raw.agent.advisor
        }
      })
      if (!w?.ok) throw new Error("config changed on disk concurrently — retry")
      // 内存热同步（不落盘）：子代理三档、审阅档与删除渠道各自的活引用面。
      if (reverts.length) syncSubagentModelPatchToPool({ values: Object.fromEntries(reverts.map((k) => [k, null])) })
      const cfgAfter = t.config.loadConfig()
      const fallbackName = activeProviderName(t, cfgAfter.defaultModel, cfgAfter.providers)
      // 实例池同步：移除该 provider；若某实例正在用它，切到 defaultModel 指向的渠道（没有则标记未配置）
      for (const entry of poolEntries().values()) {
        // 会诊/飞刀候选池同源同步（同上面子代理的道理：内核逐轮重注册，只改磁盘不够）
        if (entry.agent.config?.agent) dropConsultModelsOf(entry.agent.config.agent, name)
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
      return json(res, 200, { ok: true, activeProvider: fallbackName, reverted: reverts, droppedConsult })
    }
    if (p === "/api/config/active" && method === "POST") {
      const body = await readBody(req)
      const name = String(body.name ?? "")
      const model = body.model == null ? null : String(body.model).trim()
      const t = await loadThincoder()
      const cfg = t.config.loadConfig()
      if (!(cfg.providersList ?? []).some((x) => x.name === name)) return json(res, 404, { error: "供应商不存在" })
      setActiveProvider(t, name, model) // model 缺省 = 渠道默认模型；给出 = 同一供应商任意模型（provider:model 复合主线）
      return json(res, 200, { ok: true, activeProvider: name })
    }
    // ---- 思考程度（/think 等价面：读状态+档位枚举 / 设档；桥接层复用内核 applyThink） ----
    if (p === "/api/thinking" && method === "GET") {
      const dir = requireProject(url, runner)
      if (!dir) return json(res, 400, { error: "缺少或未添加的 project" })
      return json(res, 200, await thinkingGet(dir))
    }
    if (p === "/api/thinking" && method === "POST") {
      const body = await readBody(req)
      const dir = normalizePath(body.project)
      const action = String(body.action ?? "")
      const level = body.level == null ? null : String(body.level)
      if (!dir) return json(res, 400, { error: "缺少 project" })
      if (!runner.isKnownProject(dir)) return json(res, 400, { error: "项目未添加" })
      if (runner.isBusy(dir)) return json(res, 409, { error: "运行中，无法切换思考档位" })
      if (!["auto", "off", "effort"].includes(action)) return json(res, 400, { error: "action 需为 auto/off/effort" })
      if (action === "effort" && !level) return json(res, 400, { error: "effort 需带 level" })
      const result = await thinkingSet(dir, action, level)
      return json(res, 200, result)
    }

    if (p === "/api/config/test" && method === "POST") {
      const body = await readBody(req)
      const t = await loadThincoder()
      // 供应商存在性 + model 取值：本端点对外形状一字不改（找不到供应商仍 404；缺 model 仍 400）
      let model = body.model
      if (body.name) {
        const cfg = t.config.loadConfig()
        const found = (cfg.providersList ?? []).find((x) => x.name === body.name)
        if (!found) return json(res, 404, { error: "供应商不存在" })
        model = found.model
      }
      // model 必填是本端点与 /api/config/models 的唯一分工差异（连接测试是给某个具体模型做的）——
      // 先判再探针：缺 model 时绝不先发一次网络请求
      if (!model) return json(res, 400, { error: "缺少 baseURL/apiKey/model" })
      const r = await probeModels(t, body.name ? { name: body.name, apiKey: body.apiKey, model } : { baseURL: body.baseURL, apiKey: body.apiKey, model })
      // baseURL/apiKey 的解析与失败语义全部复用探针（同一实现）；400 文案映射回本端点历史契约的三项并列措辞
      if (r.status === 400) return json(res, 400, { error: "缺少 baseURL/apiKey/model" })
      return json(res, r.status, r.body)
    }
    // ---- 模型清单探针（GET /models）----
    // 与 /api/config/test 的分工：清单探针**不需要 model**——新增渠道在保存前即可拉清单，
    // 用于「有清单就选项、没清单才文本」；test 则是对某个具体模型的连通性验证（model 必填）。
    if (p === "/api/config/models" && method === "POST") {
      const body = await readBody(req)
      const t = await loadThincoder()
      // name 优先（已保存渠道——baseURL/format/headers 用存量，apiKey 传入则覆盖存量）；
      // 否则用传入的 baseURL/apiKey（format 可选——前端当前不传，缺省不传即走 openai 形状）
      const name = body.name ? String(body.name) : ""
      const r = await probeModels(t, { name, baseURL: body.baseURL, apiKey: body.apiKey, format: body.format })
      return json(res, r.status, r.body)
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

    // ---- 子代理模型（探索/编码/审阅三类指定模型，默认「跟随主线」） ----
    if (p === "/api/config/subagent-models" && method === "GET") {
      const t = await loadThincoder()
      const cfg = t.config.loadConfig()
      return json(res, 200, subagentModelsOf(t, cfg))
    }
    if (p === "/api/config/subagent-models" && method === "PUT") {
      const body = await readBody(req)
      const t = await loadThincoder()
      // 校验 + 落盘（单字段补丁：磁盘新鲜读，多端共存安全——与思考程度设置同式）
      const patch = await validateSubagentModelPatch(t, body)
      if (patch.error) return json(res, 400, { error: patch.error })
      if (Object.keys(patch.values).length) await writeSubagentModelPatch(t, patch)
      return json(res, 200, { ok: true, ...subagentModelsOf(t, t.config.loadConfig()) })
    }

    // ---- 会诊模型（多模型并行独立分析同一问题，2-5 个；空 = 未配置） ----
    if (p === "/api/config/consult-models" && method === "GET") {
      const t = await loadThincoder()
      return json(res, 200, consultModelsOf(t, t.config.loadConfig()))
    }
    if (p === "/api/config/consult-models" && method === "PUT") {
      const body = await readBody(req)
      const t = await loadThincoder()
      // 校验 + 落盘（单字段补丁：磁盘新鲜读，多端共存安全——与子代理模型设置同式）
      const patch = validateConsultModelsPatch(t, body)
      if (patch.error) return json(res, 400, { error: patch.error })
      if (Object.keys(patch.values).length) await writeConsultModelsPatch(t, patch)
      return json(res, 200, { ok: true, ...consultModelsOf(t, t.config.loadConfig()) })
    }

    // ---- 停止一次仍在跑的多模型会诊（consult_stop 的 WebUI 等价面） ----
    if (p === "/api/consult/stop" && method === "POST") {
      const body = await readBody(req)
      const dir = normalizePath(body.project)
      if (!runner.isKnownProject(dir)) return json(res, 403, { error: "项目未在白名单中" })
      // **刻意不设 busy 门**（与 /api/command 不同）：会诊子会话与主 run 生命周期独立——
      // 内核 consult_stop 只做 `s.stopped = true` + abort 该会诊自己的 controllers
      // （consult.mjs:462-470），既不碰主 run、不碰 history、不碰会话文件；被停的会话
      // sessionSettled 因 stopped 早退（:153），不产 digest、不入 pending。
      // 而挂起驱动期 busy 恒 true（runner.mjs:46「suspended = 驱动在跑（busy 保持 true）」），
      // 会诊恰在那段窗口里跑 ⇒ 设门等于把「停止」按钮在最需要它的时刻挡掉。
      // 只读池，**不组装**：会诊会话在池内 agent 上，未加载的项目根本没有会话可停
      const entry = poolEntries().get(dir)
      if (!entry?.agent) return json(res, 404, { error: "项目未加载" })
      const t = await loadThincoder()
      if (!t.consult?.stopTool) return json(res, 501, { error: "当前内核不支持会诊停止（缺 agent-tools/consult.mjs）" })
      // 内核返回的 JSON 原样透传（unknown id 也 200——它的 error 字段是正常语义，
      // 前端按 error 提示「会话已结束」，不另造一套错误码）
      const result = await t.consult.stopTool.execute({ id: String(body.id ?? "") }, { agent: entry.agent })
      let parsed = null
      try { parsed = JSON.parse(result) } catch { /* 非 JSON 一律按内核原文透传 */ }
      return json(res, 200, parsed && typeof parsed === "object" ? parsed : { raw: String(result ?? "") })
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
        // body.project = 安装发起项目（前端 MCP 页当前所选项目）：新 server 默认勾选给该项目
        return json(res, 200, { ok: true, ...(await mcp.addServer({ ...body, project: normalizePath(body.project) })) })
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
      // 粘贴 JSON 导入（mcpServers 等格式）；解析级错误 400，单条错误在 failed 里；project = 安装发起项目
      const body = await readBody(req)
      try {
        return json(res, 200, { ok: true, ...(await mcp.importServers(body.json ?? body, normalizePath(body.project))) })
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

    // ---- 技能（内核 skill 系统的 Web 管理面：两层 .thincoder/skills/ 的 列出/读/建/存/改名/删） ----
    // 与 /skills 斜线命令并存互不影响：那条链路只把内核 TUI 的输出打进时间线，不碰文件。
    // 写技能**不设 busy 门**——技能文件不碰 config/session/agent 运行时，内核每轮组装 system prompt
    // 时现读（core/agent/setup.mjs:231-235）⇒ 运行中写也是下一轮生效（对照 /api/command 的 409）。
    if (p === "/api/skills" && method === "GET") {
      const pre = skillsProject(res, url.searchParams.get("project"))
      if (!pre) return
      try {
        return json(res, 200, await skills.listSkills({ projectDir: pre.dir }))
      } catch (err) {
        return skillsFail(res, err)
      }
    }
    if (p === "/api/skills/file" && method === "GET") {
      const layer = url.searchParams.get("layer")
      const pre = skillsProject(res, url.searchParams.get("project"), layer)
      if (!pre) return
      try {
        return json(res, 200, await skills.readSkillFile({
          projectDir: pre.dir, layer, name: url.searchParams.get("name") ?? "",
          format: url.searchParams.get("format"),
        }))
      } catch (err) {
        return skillsFail(res, err)
      }
    }
    if (p === "/api/skills" && method === "POST") {
      const body = await readBody(req)
      const pre = skillsProject(res, body.project, body.layer)
      if (!pre) return
      try {
        return json(res, 200, await skills.createSkill({
          projectDir: pre.dir, layer: body.layer, name: body.name, content: body.content,
        }))
      } catch (err) {
        return skillsFail(res, err)
      }
    }
    if (p === "/api/skills" && method === "PUT") {
      const body = await readBody(req)
      const pre = skillsProject(res, body.project, body.layer)
      if (!pre) return
      try {
        return json(res, 200, await skills.saveSkill({
          projectDir: pre.dir, layer: body.layer, name: body.name, content: body.content, format: body.format,
        }))
      } catch (err) {
        return skillsFail(res, err)
      }
    }
    if (p === "/api/skills/rename" && method === "POST") {
      const body = await readBody(req)
      const pre = skillsProject(res, body.project, body.layer)
      if (!pre) return
      try {
        return json(res, 200, await skills.renameSkill({
          projectDir: pre.dir, layer: body.layer, name: body.name, to: body.to, format: body.format,
        }))
      } catch (err) {
        return skillsFail(res, err)
      }
    }
    if (p === "/api/skills" && method === "DELETE") {
      const body = await readBody(req)
      const pre = skillsProject(res, body.project, body.layer)
      if (!pre) return
      try {
        return json(res, 200, await skills.deleteSkill({ projectDir: pre.dir, layer: body.layer, name: body.name, format: body.format, whole: body.whole === true }))
      } catch (err) {
        return skillsFail(res, err)
      }
    }

    // ---- 技能导入（两段式：plan 只读取到暂存并出候选，apply 才落盘；暂存 10 分钟 TTL 兜底） ----
    // 取源面（skills-import.mjs）**不碰任何技能目录**：看清要装什么再决定装什么；落盘归 skills.applyImport。
    if (p === "/api/skills/import/plan" && method === "POST") {
      const body = await readBody(req)
      const pre = skillsProject(res, body.project, body.layer)
      if (!pre) return
      try {
        return json(res, 200, await skillImport.prepareImport({
          kind: body.kind, path: body.path, url: body.url, subpath: body.subpath, ref: body.ref,
          layer: body.layer, projectDir: pre.dir,
        }))
      } catch (err) {
        return skillsFail(res, err)
      }
    }
    if (p === "/api/skills/import/apply" && method === "POST") {
      const body = await readBody(req)
      const pre = skillsProject(res, body.project, body.layer)
      if (!pre) return
      // 计划过期/已放弃 → 404（暂存目录已被清），文案引导重新扫描；绝不拿一个死计划的路径去写盘
      const plan = await skillImport.getPlan(body.id)
      if (!plan) return json(res, 404, { error: "导入暂存已失效（可能已过期或已放弃），请重新扫描" })
      try {
        return json(res, 200, await skills.applyImport({
          projectDir: pre.dir, layer: body.layer, stagingDir: plan.dir, items: body.items,
        }))
      } catch (err) {
        return skillsFail(res, err)
      }
    }
    if (p.startsWith("/api/skills/import/") && method === "DELETE") {
      const id = decodeURIComponent(p.slice("/api/skills/import/".length))
      if (!(await skillImport.dropPlan(id))) return json(res, 404, { error: "导入暂存不存在（可能已过期）" })
      return json(res, 200, { ok: true })
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

    // WebUI 自身最新版检查（查公开 GitHub 仓 main 分支 package.json；缓存策略同 kernel-update）
    if (p === "/api/webui-update" && method === "GET") {
      const u = await checkWebuiUpdate()
      return json(res, 200, {
        installed: WEBUI_VERSION,
        latest: u.latest,
        source: u.source,
        checkedAt: u.checkedAt,
        error: u.error,
        outdated: !!(WEBUI_VERSION !== "unknown" && u.latest && compareVersions(u.latest, WEBUI_VERSION) > 0),
      })
    }

    // 一键半自动更新：触发编排（拉取→装依赖→构建→换入，进度走 SSE 与 status 接口）
    if (p === "/api/webui-apply-update" && method === "POST") {
      const r = startWebuiUpdate()
      if (!r.started) return json(res, 409, { error: r.message, reason: r.reason })
      return json(res, 202, { ok: true })
    }
    // 当前/最近一次更新任务状态 + 日志尾部（页面刷新或重开页面后恢复进度显示）
    if (p === "/api/webui-update-status" && method === "GET") {
      return json(res, 200, webuiUpdateState())
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
    const abs = resolve(p.startsWith("~") ? join(homedir(), p.slice(1)) : p)
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

/**
 * 技能接口的项目口径（/api/skills*）：
 * - layer 只认 project / user，其余（含缺省）→ 400
 * - 提供了 project 就必须在白名单 → 否则 403（与全部项目域接口同口径）
 * - layer=project 必须有项目 → 否则 403（项目层没有「无项目」这个合法态）
 * 成功返回 { dir }（dir 可为 null = 只看用户层）；已自行回过响应则返回 undefined（调用方 `if (!pre) return`）。
 */
function skillsProject(res, project, layer) {
  if (layer !== undefined && layer !== null && layer !== "project" && layer !== "user") {
    json(res, 400, { error: `层级参数无效（只支持 project 或 user）：${String(layer)}` })
    return undefined
  }
  const raw = typeof project === "string" && project.trim() ? project : null
  const dir = raw ? normalizePath(raw) : null
  if (raw && !runner.isKnownProject(dir)) {
    json(res, 403, { error: "项目未在白名单中" })
    return undefined
  }
  if (layer === "project" && !dir) {
    // 走到这里只可能是没带 project（带了但不在白名单，上面已 403）⇒ 如实说缺参数，别把两类原因说成一个
    // （桥接层 layerDirFor 同一情形也是这条文案）
    json(res, 400, { error: "项目层操作需要 project 参数" })
    return undefined
  }
  return { dir }
}

/** 技能接口的错误收尾：SkillError 自带状态（400/404/409/501）；其余归 400。文案是中文、可直接展示。 */
function skillsFail(res, err) {
  return json(res, err instanceof skills.SkillError ? err.status : 400, { error: err?.message ?? String(err) })
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

/** GET /models 探针专用的占位 model —— 仅为满足内核 createProvider 的必填校验（core.mjs:45 无 model 硬抛
 *  "model is required"）。listModels 全程不读 provider.model（list-models.mjs:96-105 只用
 *  baseURL/apiKey/format/headers/proxyUri），故占位值不进任何请求形状、也不会落盘。 */
const LIST_PROBE_MODEL = "__models_probe__"

/** 清单拉取失败的**人话短句**（界面只显示这个）——上游原始报文只留在 `body.error` 里（API 消费方 / 排查用），
 *  **绝不上界面**：整段 `GET /models failed 401: {"error":…}` 对用户是纯噪声。
 *  分类依据 = 内核 `list-models.mjs` 的实际抛出形态：带 status 的 `…failed <code>: …`（:35 附 `e.status`）、
 *  超时（`AbortSignal.timeout` 的 TimeoutError）、非 JSON（`failed: non-JSON response`）、网络层（fetch failed）。 */
function modelsProbeReason(err, message) {
  const status = Number.isInteger(err?.status) ? err.status : null
  const msg = String(message ?? "")
  if (status === 401 || status === 403) return "无法拉取清单，API key 未识别"
  if (status === 404) return "无法拉取清单，渠道地址不对"
  if (status >= 500) return "无法拉取清单，渠道服务异常"
  if (status) return "无法拉取清单，请求被渠道驳回"
  if (err?.name === "TimeoutError" || err?.name === "AbortError" || /timeout/i.test(msg)) return "无法拉取清单，连接超时"
  if (/non-JSON/i.test(msg)) return "无法拉取清单，渠道返回的不是模型清单"
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|socket|network/i.test(msg)) return "无法拉取清单，网络不通"
  return "无法拉取清单"
}

/** 模型清单探针（GET /models；8s 超时）——「有清单就选项、没清单才文本」的清单来源。
 *  两种入参：
 *   - 已保存渠道 { name, apiKey?, model? }：baseURL/format/headers 取存量（listModels 按 format 分派
 *     anthropic/google，并 spread provider.headers），apiKey 传入则覆盖存量；
 *   - 未保存渠道 { baseURL, apiKey, format?, model? }：直接用。
 *  与 /api/config/test 的分工：清单探针**不需要 model**（新增渠道在保存前即可拉清单）；
 *  model 只在调用方给出（或存量有）时透传给 createProvider，否则用 LIST_PROBE_MODEL 占位。
 *  失败不抛出（与既有 test 端点同语义）：{ status: 200, body: { ok: false, error } }。
 *  返回 { status, body }，调用方直接 json(res, r.status, r.body)。 */
async function probeModels(t, { name, baseURL, apiKey, model, format }) {
  let spec = { baseURL, apiKey, format, model }
  if (name) {
    const cfg = t.config.loadConfig()
    const found = (cfg.providersList ?? []).find((x) => x.name === name)
    if (!found) return { status: 404, body: { error: "供应商不存在" } }
    spec = {
      baseURL: found.baseURL,
      apiKey: apiKey || found.apiKey,
      format: found.format,
      headers: found.headers,
      model: model || found.model,
    }
  }
  if (!spec.baseURL || !spec.apiKey) return { status: 400, body: { error: "缺少 baseURL/apiKey" } }
  try {
    // createProvider 不搬 headers（core.mjs:56 只搬 format 等字段），探针对象上补回取用的那份
    const provider = { ...t.provider.createProvider({ ...spec, model: spec.model || LIST_PROBE_MODEL }), headers: spec.headers }
    const models = await t.provider.listModels(provider, { signal: AbortSignal.timeout(8000) })
    return { status: 200, body: { ok: true, models } }
  } catch (err) {
    const error = err?.message ?? String(err)
    return { status: 200, body: { ok: false, error, reason: modelsProbeReason(err, error) } }
  }
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

/** 切换激活 provider：写内核 config + 热更新实例池当前模型。
 *  model 缺省 = 渠道当前模型（原有行为）；给出 = 同一供应商任意模型 —— defaultModel 复合值
 *  是内核 model-ref 语义（`provider:model`，显式复合一律放行、不校验模型清单）。
 *  **渠道条目的 model 同步跟随**：用户裁定（2026-09-25）——「渠道的模型」就该显示当前用的那个，
 *  不是某个固定出厂值；磁盘 providers[].model 与池内条目一并更新，供应商行 / 顶栏菜单 /
 *  胶囊三处显示自动一致，重启后也一致。原「只改 defaultModel、渠道条目不动」的方案会让
 *  渠道行与顶栏选项停在旧模型（三处显示分叉），已废。 */
export function setActiveProvider(t, name, model = null) {
  const rawConfig = t.config.loadConfig()
  const found = (rawConfig.providers ?? []).find((x) => x.name === name)
  if (!found) throw new Error("供应商不存在")
  const effModel = model || found.model
  if (!effModel) throw new Error(`供应商「${name}」没有可用模型（渠道条目与指定 model 均为空）`)
  if (model) found.model = effModel // 渠道条目跟随当前选择（磁盘唯一事实源，loadConfig 全量落盘）
  rawConfig.defaultModel = `${name}:${effModel}` // 唯一跨重启事实源（activeProvider 已废——内核 loadConfig 读盘即删该字段）
  t.config.saveConfig(rawConfig)
  for (const entry of poolEntries().values()) {
    let pp = entry.agent.providers?.find((x) => x.name === name)
    if (!pp) {
      pp = { ...found }
      entry.agent.providers = [...(entry.agent.providers ?? []), pp]
    }
    pp.model = effModel // 池内渠道条目同步跟随（列表显示 / 顶栏菜单选项的数据源）
    entry.agent.provider = { ...pp }
    entry.agent.activeProvider = name
    entry.agent.activeModel = effModel
  }
}

// ================= 子代理模型（探索 / 编码 / 审阅） =================

/** 子代理**角色槽**（explore/coder）的**有效**引用（"provider:model"）或 null（**真**继承主线）。
 *
 *  内核权威 = `resolveChildProvider`（core/agent-tools/subagent-async.mjs:139-163，本函数逐形态对齐，
 *  不另立规则）：
 *    · 空 / null → 继承父 provider（⇒ null）；
 *    · `"default"`（大小写不敏感，**在渠道查找之前**判）→ 同 null，继承（⇒ null）；
 *    · 含 `:` → `split(":")` 取**前两段**：首段是渠道 ⇒ `渠道:模型段`（模型段空则取渠道默认模型）；
 *      首段**不是渠道 ⇒ 内核此处抛错**（`unknown provider`，派发直接失败）⇒ **原样显示**，
 *      不粉饰成「跟随主线」（界面如实呈现破损配置，用户才看得见要修什么）；
 *    · 裸名 → 是渠道 ⇒ `该渠道:渠道默认模型`（模型为 undefined/null 时回落主线模型——内核 `??`
 *      语义，**空串不回落**）；不是渠道 ⇒ 内核当作**主线渠道上的一个模型名**（照跑不报错）
 *      ⇒ 合成 `主线渠道:裸名`。渠道模型为空 ⇒ 退回裸值显示（内核此处会产出一个空 model 的
 *      provider，等价于请求发不出去；界面不伪造一个形似合法的复合值）。
 *  与审阅（`advisorRefOf`）的语义差异：审阅的 `resolveAdvisorProvider` **不抛错**、一律回落主线；
 *  角色槽的 `p:缺渠道` 会直接派发失败——两套解析器语义不同，别混用同一套判据。 */
function subagentRoleRefOf(cfg, raw) {
  if (!raw) return null // 内核 `if (!modelArg)`：继承父
  const v = String(raw)
  if (v.toLowerCase() === "default") return null // 别名 ≡ 省略（内核 :148，先于渠道查找）
  const list = Array.isArray(cfg.providersList) ? cfg.providersList : []
  const main = cfg.provider ?? {}
  const mainName = typeof main.name === "string" && main.name ? main.name : null
  if (v.includes(":")) {
    const [pname, mname] = v.split(":") // 内核同式（:152）：split(":") 取前两段
    const p = list.find((x) => x && x.name === pname)
    if (!p) return v // 内核 :154 抛错 ⇒ 派发失败；原样显示（不假装"跟随主线"）
    const model = mname || p.model
    return model ? `${pname}:${model}` : v
  }
  const byName = list.find((x) => x && x.name === v)
  if (byName) {
    const model = byName.model ?? main.model // 内核 :161
    return model ? `${v}:${model}` : v
  }
  return mainName ? `${mainName}:${v}` : null // 内核 :162：非渠道裸值 = 主线渠道上的模型名
}

/** 三类子代理的模型引用（"provider:model" 复合）或 null（= 跟随主线）。权威数据源：
 *  explore/coder ← agent.subagentModels（内核 `resolveChildProvider` 解析，见上）；
 *  审阅 ← agent.advisor.provider/model（顶层 advisor 是 loadConfig 的派生副本——
 *  config.mjs promote，只读不落盘；内核 `resolveAdvisorProvider` 解析）。 */
export function subagentModelsOf(t, cfg) {
  const sub = cfg.agent?.subagentModels ?? {}
  return {
    explore: subagentRoleRefOf(cfg, sub.explore),
    coder: subagentRoleRefOf(cfg, sub.coder),
    advisor: advisorRefOf(cfg),
  }
}

/** 审阅档的**有效**引用（"provider:model"）或 null（**真**跟随主线）。
 *
 *  `agent.advisor` 的两段不是「齐全才算配过」——内核 `resolveAdvisorProvider`
 *  （core/advisor/run.mjs:26-56，本函数以它为权威）对**只存在一段**的值照样生效：
 *    · 只有 `model` → 复用主线渠道并把该 model 贴上去（`{...agent.provider}` 之后的 `if (cfg?.model)`）；
 *    · 只有 `provider`（且在渠道清单里）→ 用该渠道，模型取渠道默认（`provider.model ?? agent.provider?.model`）；
 *    · `provider` 不在清单里 → findProvider 抛错后同样回落主线，`model` 若在仍会被贴回主线渠道。
 *  旧判据「两段齐全才算数」会把这种半边配置显示成「跟随主线」——界面显示与内核实跑值不符，
 *  缺陷因此长期隐形（2026-09-26 用户实测的同类症状）。这里按内核口径合成有效值：宁可显示
 *  用户没主动选过的真实组合，也不谎报「跟随主线」；要清掉它，设置页的「跟随主线」一键即可
 *  （清除已改为把 `provider`、`model` 两个键一并删）。
 *  **范围**：本函数只合成 `provider` 与 `model` 两段——内核同一函数的 `thinking` / `reasoningEffort`
 *  透传（core/advisor/run.mjs:39-41 / :52-54）不在本口径内：设置页不展示审阅的思考档位，没有对应
 *  可见面；将来若加该控件，这里要一并扩。 */
function advisorRefOf(cfg) {
  const adv = cfg.advisor ?? {}
  if (!adv.provider && !adv.model) return null // 真未配：跟随主线
  const list = Array.isArray(cfg.providersList) ? cfg.providersList : []
  const named = adv.provider ? list.find((p) => p && p.name === adv.provider) : null
  const main = cfg.provider ?? {}
  const provider = named ? adv.provider : typeof main.name === "string" && main.name ? main.name : null
  // 这里用 `||` 链而**不是** `??`：内核 `resolveAdvisorProvider`（core/advisor/run.mjs:26-56）对
  // `cfg.provider` / `cfg.model` 用的是**真值判断**（:28 `if (cfg?.provider)`、:38 `cfg.model ? …`、
  // :49 `if (cfg?.model)`），`??` 只出现在**渠道自己的**兜底（core/advisor/run.mjs:38
  // `provider.model ?? agent.provider?.model`）。实测（2026-09-26）：`advisor.model = ""` 时内核落在
  // 渠道默认模型，`||` 同落——换成 `??` 反而会把空串当成“有值”而返回 null（谎报跟随主线）；而
  // 「渠道条目 model 为空串」这一形态**不可达**（loadConfig 会把 `providers[].model` 的 `""` 归一化成 null）。
  const model = adv.model || named?.model || main.model || null
  return provider && model ? `${provider}:${model}` : null
}

/** PUT 校验：仅处理 body 中出现的键（部分补丁——前端即选即存，每次只 PUT 一类）；取值 ∈
 *  null | "provider:model"。null/空 = 清除（跟随主线）；复合值首段须是已配置渠道（模型段
 *  不校验——内核 model-ref 语义：显式复合一律放行，模型清单运行期拉取）。 */
export function validateSubagentModelPatch(t, body) {
  const cfg = t.config.loadConfig()
  const known = new Set((cfg.providersList ?? []).map((x) => x.name))
  const out = {}
  for (const kind of ["explore", "coder", "advisor"]) {
    if (!(kind in body)) continue
    let v = body[kind]
    if (v == null || v === "") { out[kind] = null; continue }
    v = String(v).trim()
    const sep = v.indexOf(":")
    if (sep <= 0 || !v.slice(sep + 1)) {
      return { error: `${kind} 的模型引用需为 "provider:model" 复合值（如 deepseek:deepseek-chat）` }
    }
    const providerName = v.slice(0, sep)
    if (!known.has(providerName)) {
      return { error: `${kind} 引用了未配置的供应商「${providerName}」` }
    }
    out[kind] = v
  }
  return { values: out }
}

/** "provider:model" → provider / model 段（首冒号分割，与内核 parseModelRef 同式） */
function modelRefSplit(ref) {
  const sep = ref.indexOf(":")
  return { provider: ref.slice(0, sep), model: ref.slice(sep + 1) }
}

/** 应用三类模型引用：写 agent.subagentModels / agent.advisor（单字段补丁：磁盘新鲜读，
 *  多端共存安全——与思考程度设置同式；顶层 advisor 是派生键不落盘，兼容层会剔除）+
 *  池内热同步（merged config 是活引用，子代理 spawn / advisor 评审即时读取——改完对之后
 *  派发的生效，运行中的不动）。
 *  三态语义（用户实测修，2026-09-25）：键不存在（undefined）= 本次未提交，**绝不动它**；
 *  显式 null = 清除（跟随主线）；字符串 = 写入。此前 else 分支把 undefined 一并当清除，
 *  PUT 单键会误删另外两类的磁盘配置——「设置一类，其他两类变回跟随主线」即此根因。 */
export async function writeSubagentModelPatch(t, { values }) {
  const r = await t.configIo.writeConfigAtomic(t.config.configPath, (raw) => {
    for (const kind of ["explore", "coder"]) {
      if (!(kind in values)) continue // 未提交：不动
      if (values[kind]) {
        raw.agent ??= {}
        raw.agent.subagentModels ??= {}
        raw.agent.subagentModels[kind] = values[kind]
      } else if (raw.agent?.subagentModels) {
        delete raw.agent.subagentModels[kind]
        if (Object.keys(raw.agent.subagentModels).length === 0) delete raw.agent.subagentModels
      }
    }
    if (!("advisor" in values)) {
      // 未提交：不动（下方池同步同口径）
    } else if (values.advisor) {
      const { provider, model } = modelRefSplit(values.advisor)
      raw.agent ??= {}
      raw.agent.advisor = { ...(raw.agent.advisor ?? {}), provider, model }
    } else if (raw.agent?.advisor) {
      // 只清模型覆盖；guard 等其他 advisor 设置保留。provider 与 model **必须成对清除**——内核
      // resolveAdvisorProvider 的回退分支是「无 provider ⇒ 复用主线」，但紧接着还有
      // `if (cfg?.model) provider.model = cfg.model`（core/advisor/run.mjs:48-55）：只删 provider
      // 会把残留的 model 贴回主线渠道，「跟随主线」静默失效（用户实测 2026-09-26）。
      delete raw.agent.advisor.provider
      delete raw.agent.advisor.model
      if (Object.keys(raw.agent.advisor).length === 0) delete raw.agent.advisor
    }
  })
  if (!r?.ok) throw new Error("config changed on disk concurrently — retry")
  syncSubagentModelPatchToPool({ values })
}

/** 把「子代理角色槽 + 审阅档」的单字段补丁同步进**实例池内存**（磁盘写完之后的内存第二步，不落盘）。
 *  为何必须单独有这一步：`entry.agent.config` 是内核 merged 对象的**活引用**，子代理 spawn 与
 *  `resolveAdvisorProvider` 都即时读它——只改磁盘不改内存 ⇒ 那个会话本回合仍按旧值跑。
 *  三态语义与磁盘侧逐条一致（键不存在 = 不动 / 显式 null = 清除 / 字符串 = 写入）；审阅的**派生副本**
 *  `cfg.advisor` 必须同步（内核 `resolveAdvisorProvider` 读的是顶层派生副本，不是 `cfg.agent.advisor`）。
 *  抽成独立函数的原因：**删渠道的级联要与它自己的磁盘写合成一次原子写**，不能再调
 *  `writeSubagentModelPatch`（那会写第二次盘——两次写之间失败会留下「渠道已删、引用还在」的半态），
 *  但它仍需要这份内存同步语义，故两处共用这一份实现（不另写一套）。 */
function syncSubagentModelPatchToPool({ values }) {
  for (const entry of poolEntries().values()) {
    const cfg = entry.agent.config
    if (!cfg) continue
    for (const kind of ["explore", "coder"]) {
      if (!(kind in values)) continue // 未提交：不动
      if (values[kind]) {
        cfg.agent ??= {}
        cfg.agent.subagentModels ??= {}
        cfg.agent.subagentModels[kind] = values[kind]
      } else if (cfg.agent?.subagentModels) {
        delete cfg.agent.subagentModels[kind]
        if (Object.keys(cfg.agent.subagentModels).length === 0) delete cfg.agent.subagentModels
      }
    }
    if (!("advisor" in values)) continue
    const advPatch = values.advisor
      ? modelRefSplit(values.advisor)
      : null
    if (advPatch) {
      cfg.agent ??= {}
      cfg.agent.advisor = { ...(cfg.agent.advisor ?? {}), ...advPatch }
      cfg.advisor = { ...(cfg.advisor ?? {}), ...advPatch } // 派生副本同步（resolveAdvisorProvider 读顶层）
    } else {
      for (const adv of [cfg.agent?.advisor, cfg.advisor]) {
        if (!adv) continue
        delete adv.provider
        delete adv.model // 与磁盘侧同口径：成对清（残留 model 会被内核贴回主线渠道）
        if (Object.keys(adv).length === 0) {
          if (cfg.agent?.advisor === adv) delete cfg.agent.advisor
          if (cfg.advisor === adv) delete cfg.advisor
        }
      }
    }
  }
}

// ================= 会诊模型（多模型会诊，内核 agent.consultModels） =================

/** 会诊模型上限——内核 consult_start 的同值硬闸（超出直接返回 Error，consult.mjs:412）。 */
export const CONSULT_MODELS_MAX = 5

/** 会诊模型清单（内核 `agent.consultModels`，`[{provider, model, effort?}]`）。权威数据源 =
 *  merged config（内核 consult_start 读的就是 `agent.config.agent.consultModels`，池内是活引用、
 *  与盘上同值）。额外带两个**只读派生**字段给设置页：`efforts` = 该模型 spec 的
 *  reasoningEffortEnum（模型特定不可硬编码，经内核 `specForModel` 取）——空数组 = 该模型不接受
 *  effort（内核 clampEffort 会把越界值丢弃，故没有可选档就不该渲染下拉）；`max` = 条数上限。 */
export function consultModelsOf(t, cfg) {
  const list = Array.isArray(cfg.agent?.consultModels) ? cfg.agent.consultModels : []
  return {
    models: list
      .filter((m) => m && typeof m === "object")
      .map((m) => {
        const model = typeof m.model === "string" ? m.model : ""
        return {
          provider: typeof m.provider === "string" ? m.provider : "",
          model,
          effort: typeof m.effort === "string" && m.effort ? m.effort : null,
          efforts: t.config.specForModel(model)?.reasoningEffortEnum ?? [],
        }
      }),
    max: CONSULT_MODELS_MAX,
  }
}

/** PUT 校验（三态部分补丁，与 validateSubagentModelPatch 同式）：键 `models` 不存在 = 本次未
 *  提交，**绝不动它**；显式 null = 清除（= 未配置，内核视作「会诊不可用」）；数组 = 写入。
 *  单条 = `{provider, model, effort?}`：provider 段须是已配置渠道（模型段不校验——内核 model-ref
 *  语义「显式复合一律放行」、模型清单运行期拉取，与子代理模型同强度）。
 *  effort 只在「该模型声明了 reasoningEffortEnum 且所填值不在其中」时拒绝：内核会**静默丢弃**
 *  越界 effort（consult.mjs:260-265 的 clampEffort），收下一个写进去却不生效的值比当场报错难查得多；
 *  判据取内核同一个 specForModel，绝不另写一张档位表。 */
export function validateConsultModelsPatch(t, body) {
  if (!("models" in body)) return { values: {} }
  const v = body.models
  if (v == null) return { values: { models: null } }
  if (!Array.isArray(v)) return { error: "models 需为数组（[{provider, model, effort?}]）或 null（清除）" }
  if (v.length > CONSULT_MODELS_MAX) {
    return { error: `会诊模型最多 ${CONSULT_MODELS_MAX} 个（收到 ${v.length} 个）` }
  }
  const cfg = t.config.loadConfig()
  const known = new Set((cfg.providersList ?? []).map((x) => x.name))
  const out = []
  for (let i = 0; i < v.length; i++) {
    const e = v[i]
    const at = `第 ${i + 1} 条会诊模型`
    if (!e || typeof e !== "object" || Array.isArray(e)) return { error: `${at}需为 {provider, model, effort?} 对象` }
    const provider = String(e.provider ?? "").trim()
    const model = String(e.model ?? "").trim()
    if (!provider) return { error: `${at}缺 provider` }
    if (!model) return { error: `${at}缺 model` }
    if (!known.has(provider)) return { error: `${at}引用了未配置的供应商「${provider}」` }
    const item = { provider, model }
    const effort = e.effort == null ? "" : String(e.effort).trim()
    if (effort) {
      const levels = t.config.specForModel(model)?.reasoningEffortEnum ?? []
      if (levels.length && !levels.includes(effort)) {
        return { error: `${at}的 effort「${effort}」不被模型 ${model} 支持（可用：${levels.join("/")}）` }
      }
      item.effort = effort
    }
    out.push(item)
  }
  return { values: { models: out } }
}

/** ⓐ 档位（effort）跨进程合并。
 *
 *  为什么需要：设置页没有档位控件（用户裁定），但它保存时发的是**整张表**（服务端整段覆盖）。
 *  早先客户端会把「打开页面那一刻」的 effort 快照原样带回来 → 若期间别处改过档位（CLI `/config →
 *  consult/escalate pool menu`、另一个标签页、终端手改 config），整表写入把新值**静默写回旧值**，
 *  而设置页不显示档位 ⇒ 用户丢了也不会知道。
 *  现规则（两端各出一半）：
 *  ・客户端**不再携带** effort（本页没有档位控件——没有控件就没有意图，见 `saveConsult`）；
 *  ・服务端此时用**刚新鲜读到的磁盘值**补齐：同 `provider` + `model` 的条目沿用磁盘档位
 *    （⇒ 同模型重选自然保住档位）、磁盘上没有的条目（新增 / 换了模型）就不带档位
 *    （⇒ 换模型自然丢掉，避开坑 91 的 `clampEffort` 静默丢弃陷阱）。
 *  客户端**明确写了** effort 时一律尊重它——API 面（CLI / 未来档位控件 / 第三方）的写意图不能被
 *  这段合并吃掉，否则等于把「改档位」这个能力从接口上删了。
 *  形状与 `validateConsultModelsPatch` 一致：无档位就**不带 effort 键**（不写空串）。 */
function mergeConsultEffort(diskList, incoming) {
  const disks = Array.isArray(diskList) ? diskList.filter((m) => m && typeof m === "object") : []
  return incoming.map((m) => {
    const own = typeof m.effort === "string" && m.effort ? m.effort : ""
    if (own) return { provider: m.provider, model: m.model, effort: own }
    const hit = disks.find((d) => d.provider === m.provider && d.model === m.model)
    const kept = hit && typeof hit.effort === "string" && hit.effort ? hit.effort : ""
    const next = { provider: m.provider, model: m.model }
    if (kept) next.effort = kept
    return next
  })
}

/** 删渠道级联：把 `holder.consultModels` 里**指向 `name`** 的条目摘掉（`holder` = 配置的 `agent` 段）。
 *  会诊条目**没有「跟随主线」语义**（不像子代理三档可回退），所以只能**移除**，并如实告知用户——
 *  `droppedConsult` 就是为此返回的（本项目「不静默回退」纪律）。摘空则连键一起删，与 consult PUT
 *  的空表口径一致（`writeConsultModelsPatch` 的 else 分支）。
 *  ⚠️ **磁盘侧与池内热同步必须都调**：`agent.consultModels` 是 consult 与 escalate（飞刀）候选池
 *  的共同来源，而内核在**每次 run 的 prepareRun** 里按当时池子重注册这两个工具（`setup.mjs:166` →
 *  `family-tools.mjs`）——只改磁盘不改内存 ⇒ 那个会话本回合仍会把死渠道当候选。 */
export function dropConsultModelsOf(holder, name) {
  const list = Array.isArray(holder?.consultModels) ? holder.consultModels : null
  if (!list) return []
  const mine = (m) => m && typeof m === "object" && m.provider === name
  const dropped = list.filter(mine)
  if (!dropped.length) return []
  const kept = list.filter((m) => !mine(m))
  if (kept.length) holder.consultModels = kept
  else delete holder.consultModels
  return dropped.map((m) => `${m.provider}:${m.model}`)
}

/** 应用会诊模型清单（三态语义见上）。落盘走 `configIo.writeConfigAtomic` **单字段补丁**（磁盘
 *  新鲜读——长跑进程不整写，与终端手改 config / TUI 多端共存安全），并做池内热同步：
 *  `entry.agent.config` 是 merged 对象的活引用，内核 consult_start 即时读它 ⇒ 改完对**之后开始**
 *  的会诊生效，已在跑的不动。缺键（未提交）两条路径都早退不动。
 *  `effort` 先过 `mergeConsultEffort`（磁盘为准）——写盘与池内热同步必须用**同一份合并结果**，
 *  否则磁盘与运行中实例会不一致（`merged` 就是那个单一来源）。 */
export async function writeConsultModelsPatch(t, { values }) {
  if (!("models" in values)) return
  let merged = values.models
  const r = await t.configIo.writeConfigAtomic(t.config.configPath, (raw) => {
    if (values.models) {
      merged = mergeConsultEffort(raw.agent?.consultModels, values.models)
      raw.agent ??= {}
      raw.agent.consultModels = merged
    } else if (raw.agent?.consultModels) {
      delete raw.agent.consultModels
    }
  })
  if (!r?.ok) throw new Error("config changed on disk concurrently — retry")
  for (const entry of poolEntries().values()) {
    const cfg = entry.agent?.config
    if (!cfg) continue
    if (values.models) {
      cfg.agent ??= {}
      // 深拷贝：池内热同步的条目不得与本次请求的 patch 对象共享引用（后续请求改它 = 静默改池）
      cfg.agent.consultModels = merged.map((m) => ({ ...m }))
    } else if (cfg.agent?.consultModels) {
      delete cfg.agent.consultModels
    }
  }
}

/** 当前默认模型名——由 defaultModel 复合值派生（parseModelRef 校验渠道存在，模型段原样返回） */
export function activeModelOf(t, defaultModel, providers) {
  const r = t.config.parseModelRef(defaultModel, providers ?? [])
  return r.ok ? r.model : null
}

function statSyncIsDir(dir) {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** 目录浏览弹窗的「位置」条目：主目录 + 根/盘符。
 *  win32 —— A–Z 探测真实存在的盘符（不存在的盘 statSync 直接 ENOENT，无阻塞）；
 *  darwin —— `/` + `/Volumes` 下的挂载卷；其他 POSIX —— `/`（POSIX 单根树，从 / 可达全盘）。 */
function listFsRoots() {
  const roots = []
  const seen = new Set()
  // 统一收口：归一 → 存在 → 是目录，任一不过就丢弃（列表里不留点进去就报错的假条目）；重复 path 去重
  const push = (name, path, kind) => {
    const abs = normalizePath(path)
    if (!abs || seen.has(abs) || !existsSync(abs) || !statSyncIsDir(abs)) return
    seen.add(abs)
    roots.push({ name, path: abs, kind })
  }
  push("主目录", homedir(), "home")
  if (process.platform === "win32") {
    for (let c = 65; c <= 90; c++) {
      const drive = String.fromCharCode(c) + ":"
      push(drive, drive + "\\", "drive")
    }
  } else {
    push("/", "/", "root")
    if (process.platform === "darwin") {
      try {
        for (const vol of readdirSync("/Volumes")) push(vol, `/Volumes/${vol}`, "volume")
      } catch {
        // /Volumes 不可读时只保留根（枚举失败不该让整个接口失败）
      }
    }
  }
  return roots
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
