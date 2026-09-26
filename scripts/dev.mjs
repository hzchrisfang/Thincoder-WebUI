#!/usr/bin/env node

/**
 * dev.mjs — 开发模式：同时起后端（8181）与 Vite 前端（5173，代理 /api、/login）
 */

import { spawn } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const children = []

function start(name, cmd, cwdArgs) {
  // Windows：npm/npx 是 .cmd 批处理，裸 spawn 无 shell 拉不起（ENOENT）——改走 cmd /c；
  // POSIX 直接数组 argv，不经 shell（与 server 其余子进程先例一致）
  const isWin = process.platform === "win32"
  const child = spawn(
    isWin ? process.env.comspec || "cmd.exe" : cmd.name,
    isWin ? ["/d", "/s", "/c", cmd.name, ...cmd.args] : cmd.args,
    { cwd: cwdArgs.cwd, stdio: "inherit", env: process.env, windowsVerbatimArguments: isWin },
  )
  child.on("exit", (code) => {
    console.log(`\n[dev] ${name} 退出（code=${code}），收尾…`)
    shutdown()
  })
  children.push(child)
}

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  for (const c of children) {
    try {
      // Windows：SIGTERM 几乎不送达控制台进程组，且 cmd /c 包装会留下孤儿孙进程——整树杀
      if (process.platform === "win32" && c.pid) {
        spawn("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" })
      } else {
        c.kill("SIGTERM")
      }
    } catch { /* 已退出 */ }
  }
  setTimeout(() => process.exit(0), 1500).unref()
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

start("server", { name: process.execPath, args: ["server/index.mjs", "--no-open"] }, { cwd: root })
start("vite", { name: "npm", args: ["--prefix", "web", "run", "dev"] }, { cwd: root })

console.log("[dev] 后端 :8181 ｜ 前端 :5173（代理已配置）")
console.log("[dev] 登录链接见上方后端输出（/login?token=…），把域名换成 http://localhost:5173 亦可")
