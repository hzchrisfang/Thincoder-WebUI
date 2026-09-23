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
  const child = spawn(cmd.name, cmd.args, { cwd: cwdArgs.cwd, stdio: "inherit", env: process.env })
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
    try { c.kill("SIGTERM") } catch { /* 已退出 */ }
  }
  setTimeout(() => process.exit(0), 1500).unref()
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

start("server", { name: process.execPath, args: ["server/index.mjs", "--no-open"] }, { cwd: root })
start("vite", { name: "npm", args: ["--prefix", "web", "run", "dev"] }, { cwd: root })

console.log("[dev] 后端 :8181 ｜ 前端 :5173（代理已配置）")
console.log("[dev] 登录链接见上方后端输出（/login?token=…），把域名换成 http://localhost:5173 亦可")
