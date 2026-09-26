#!/usr/bin/env node

/**
 * thincoder-webui — 服务入口
 *   node server/index.mjs [--port 8181] [--host 0.0.0.0] [--no-open]
 *
 * 默认 0.0.0.0 + 持久 token（局域网可用）；登录链接带 token，启动时打印。
 */

import http from "node:http"
import { spawn } from "node:child_process"
import { handleRequest } from "./routes.mjs"
import { getToken } from "./lib/auth.mjs"
import { getHost } from "./lib/state.mjs"
import { setServerReg } from "./lib/server-reg.mjs"
import { startScheduler, stopScheduler } from "./bridge/scheduler.mjs"
import { syncGlobalRules } from "./bridge/sync-rules.mjs"

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : null
}
const PORT = Number(flag("port") ?? process.env.PORT ?? 8181)
// host 优先级：命令行 > 环境变量 > 设置页持久化偏好（M3 仅本机开关）
const HOST = flag("host") ?? process.env.HOST ?? getHost()
const NO_OPEN = args.includes("--no-open")

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    try {
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: err?.message ?? String(err) }))
    } catch { /* 连接已断就算了 */ }
  })
})

// 注册给路由层，供"仅本机/局域网"热切换（M3）
setServerReg(server, { port: PORT })

// 启动时把仓库内 AGENTS.md 全局规则同步到内核全局层（~/.thincoder/AGENTS.md），
// 使 WebUI 运行期间所有 agent 自动读到；失败不影响服务本身。
syncGlobalRules()
  .then((changed) => { if (changed) console.log("[rules] 已同步 AGENTS.md 到 ~/.thincoder/AGENTS.md") })
  .catch((err) => console.error("[rules] 同步 AGENTS.md 失败:", err?.message ?? err))

server.listen(PORT, HOST, () => {
  const token = getToken()
  const local = `http://127.0.0.1:${PORT}`
  const login = `${local}/login?token=${token}`
  console.log(`
  thincoder-webui 已启动
  ────────────────────────────────────────────
  监听      ${HOST}:${PORT}${HOST === "0.0.0.0" ? "（局域网可访问）" : ""}
  登录链接  ${login}
  本机访问  ${local}（首次请走上面的登录链接）
  ────────────────────────────────────────────
  安全提示：持有 token 的设备可完全操作本服务。
  token 文件：~/.thincoder-webui/token
`)
  // M4：启动定时任务调度（持久化任务；停机期间到点的会在首个 tick 补跑）
  startScheduler()
  if (!NO_OPEN) {
    try {
      // 自动开登录页：darwin `open`；win32 `start` 是 cmd 内建（"" 是窗口标题占位参数）
      const child =
        process.platform === "darwin"
          ? spawn("open", [login], { stdio: "ignore", detached: true })
          : process.platform === "win32"
            ? spawn(process.env.comspec || "cmd.exe", ["/d", "/s", "/c", "start", "", login], { stdio: "ignore", detached: true, windowsVerbatimArguments: true })
            : null
      if (child) {
        child.on("error", () => { /* 打不开浏览器就算了 */ })
        child.unref()
      }
    } catch { /* 同上 */ }
  }
})

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[error] 端口 ${PORT} 已被占用：换一个端口（--port ${PORT + 1}）或先停掉占用进程`)
    process.exit(1)
  }
  throw err
})

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`\n收到 ${sig}，正在退出…`)
    stopScheduler()
    // 先断开所有连接（含 SSE 长连接，否则 server.close 永远等不完）
    try { server.closeAllConnections?.() } catch { /* 忽略 */ }
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  })
}
