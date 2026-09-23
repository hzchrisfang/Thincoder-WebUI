#!/usr/bin/env node
/**
 * verify-windows.mjs — Windows 兼容性真机自检（零依赖，仅 node: 内置模块）
 *
 * 目的：在真实 Windows 机器上实跑验证一批平台相关修复的行为（静态审计在 macOS 上
 * 只能等价推断，这里给一条命令的机器判定）：
 *   1. node:sqlite 可用（用量/任务页依赖，Node 22.0-22.4 无此模块）
 *   2. 服务在临时 HOME 下正常启动 + token 鉴权链可用
 *   3. POST /api/projects 接受 Windows 反斜杠真实路径形态
 *   4. `~/` 展开随 os.homedir()（不再读 HOME 环境变量——Windows 无 HOME）
 *   5. /api/file 防路径穿越守卫：项目内 200；`..\`、绝对路径、混合分隔符、
 *      编码斜杠全 403（relative 判定对反斜杠分隔符成立）
 *   6. （仅 win32）`cmd /d /s /c npm --version` 能拉起——.cmd 批处理经 cmd 包装
 *      spawn 是 dev.mjs / 自更新编排的同一修复语义
 *
 * 用法：node scripts/verify-windows.mjs
 * 输出：逐项 PASS / FAIL / SKIP（win32 专属项在 POSIX 上 SKIP）+ 末尾汇总；
 *       有 FAIL 时 exit code = 1。跑完临时目录自动清理，不触碰真实用户数据
 *       （服务进程的 HOME / USERPROFILE 均重定向到临时目录）。
 */
import { spawn } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const IS_WIN = process.platform === "win32"
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// 预检：被测服务需要内核依赖（脚本自身零依赖）。缺了就提前给出可操作提示，
// 不让下面变成一团模块解析报错。
if (!existsSync(join(ROOT, "node_modules", "thincoder"))) {
  console.log("WARN  本地未装依赖（node_modules/thincoder 不存在）——若下面启动失败，请先在本仓库运行 `npm install`。")
}

/** ---------------- 结果登记 ---------------- */
const results = []
const record = (ok, name, detail) => {
  results.push({ ok, name })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`)
}
const skip = (name, detail) => {
  results.push({ ok: null, name })
  console.log(`SKIP  ${name}${detail ? "  -- " + detail : ""}`)
}

/** ---------------- 0. 前置：Node 版本与 node:sqlite ---------------- */
{
  const [major, minor] = process.versions.node.split(".").map(Number)
  const ok = major > 22 || (major === 22 && minor >= 5)
  record(ok, "node-version", `running ${process.versions.node}, need >=22.5 (node:sqlite)`)
}
{
  let ok = false
  try { await import("node:sqlite"); ok = true } catch { /* 22.0-22.4 或更老 */ }
  record(ok, "node-sqlite", "import node:sqlite (usage/jobs pages need it)")
}

/** ---------------- 1. 临时环境：假 HOME + 项目夹具 ---------------- */
const tmp = mkdtempSync(join(tmpdir(), "tcw-verify-"))
const fakeHome = join(tmp, "home")
mkdirSync(join(fakeHome, ".thincoder-webui"), { recursive: true })
const proj = join(tmp, "proj") // win32 上 join 产出真实反斜杠形态——正是要喂给服务的
mkdirSync(join(proj, "sub"), { recursive: true })
writeFileSync(join(proj, "a.txt"), "hello")
writeFileSync(join(proj, "sub", "b.txt"), "deep")
writeFileSync(join(proj, "..config"), "dotdot-legit") // 合法文件名（以 .. 开头）防误杀夹具
writeFileSync(join(tmp, "secret.txt"), "secret")

/** ---------------- 2. 起真实服务（临时 HOME 重定向，不碰真实用户数据） ---------------- */
const PORT = 18000 + Math.floor(Math.random() * 2000)
let bootLog = ""
const server = spawn(
  process.execPath,
  [join(ROOT, "server", "index.mjs"), "--port", String(PORT), "--host", "127.0.0.1", "--no-open"],
  {
    cwd: ROOT,
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, THINCODER_HOME: join(fakeHome, ".thincoder") },
    stdio: ["ignore", "pipe", "pipe"],
  },
)
server.stdout.on("data", (d) => { bootLog += d })
server.stderr.on("data", (d) => { bootLog += d })

let up = false
for (let i = 0; i < 60; i++) {
  if (existsToken()) { up = true; break }
  await wait(250)
}
if (!up) {
  console.log(`FAIL  server-boot -- token never appeared; server output tail:\n${bootLog.slice(-1200)}`)
  console.log("HINT  刚 clone 的仓库先运行 `npm install`（脚本零依赖，但被测服务需要内核依赖）。")
  await finish()
} else {
  await runChecks()
  await finish()
}

function existsToken() {
  try { return readFileSync(join(fakeHome, ".thincoder-webui", "token"), "utf8").trim().length > 0 } catch { return false }
}

async function runChecks() {
  const token = readFileSync(join(fakeHome, ".thincoder-webui", "token"), "utf8").trim()
  const B = `http://127.0.0.1:${PORT}`
  const api = async (path, opts = {}) => {
    // 注意：headers 必须最后合并——opts.headers 直接覆盖会丢掉鉴权 cookie
    const res = await fetch(B + path, { ...opts, headers: { cookie: `tcw=${token}`, ...(opts.headers ?? {}) } })
    const text = await res.text()
    return { status: res.status, body: text.slice(0, 150) }
  }

  // 等端口真正可连（token 先落盘，listen 在其后）
  let reachable = false
  for (let i = 0; i < 40; i++) {
    try { await fetch(B + "/", { signal: AbortSignal.timeout(1000) }); reachable = true; break } catch { await wait(250) }
  }
  record(reachable, "server-boot", reachable ? `127.0.0.1:${PORT}` : `no HTTP; tail: ${bootLog.slice(-400)}`)
  if (!reachable) return

  // 鉴权链：无 cookie 应 401
  {
    const res = await fetch(B + "/api/projects")
    record(res.status === 401, "auth-no-cookie", `GET /api/projects without token -> ${res.status} (want 401)`)
  }

  // 加项目：Windows 反斜杠真实形态（join 产物）
  const enc = encodeURIComponent
  {
    const r = await api("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: proj }),
    })
    record(r.status === 200, "project-add-backslash", `dir=${JSON.stringify(proj)} -> ${r.status} ${r.status === 200 ? "" : r.body}`)
  }

  // `~/` 展开随 os.homedir()（假 HOME 下的目录应能通过 ~ 形态添加）
  {
    const homeProj = join(fakeHome, "proj-in-home")
    mkdirSync(homeProj, { recursive: true })
    writeFileSync(join(homeProj, "x.txt"), "hi")
    const r = await api("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dir: "~/proj-in-home" }),
    })
    record(r.status === 200, "homedir-tilde", `~/proj-in-home -> ${r.status} ${r.status === 200 ? "" : r.body}`)
  }

  // /api/file 守卫：win 与 posix 对反斜杠用例的期望不同
  // （反斜杠在 POSIX 不是分隔符 → 字面文件名不存在 → 404「读取失败」也属正确行为）
  const q = enc(proj)
  // 第 4 项 raw=true 表示 rel 已含 URL 编码，不再二次编码（测反代/浏览器真实编码形态）
  const guards = [
    ["file-in-project", "a.txt", { win: 200, posix: 200 }],
    ["file-in-subdir", "sub/b.txt", { win: 200, posix: 200 }],
    ["legit-dotdot-name", "..config", { win: 200, posix: 200 }], // 合法文件名以 .. 开头——防守卫过宽误杀
    ["traversal-dotdot", "../secret.txt", { win: 403, posix: 403 }],
    ["traversal-dotdot-backslash", "..\\secret.txt", { win: 403, posix: 404 }], // 反斜杠仅 win 是分隔符；POSIX 为字面名→404
    ["traversal-mixed", "a.txt/../../secret.txt", { win: 403, posix: 403 }],
    ["absolute-path", join(tmp, "secret.txt"), { win: 403, posix: 403 }],
    ["encoded-slash", "..%2fsecret.txt", { win: 403, posix: 403 }, true], // 服务端解出 ../secret.txt → 真穿越
    ["double-encoded", "..%252fsecret.txt", { win: 404, posix: 404 }, true], // 解出字面 ..%2fsecret.txt → 非穿越（不存在）
    ["empty-path", "", { win: 403, posix: 403 }],
  ]
  for (const [name, rel, want, raw] of guards) {
    const expect = IS_WIN ? want.win : want.posix
    const r = await api(`/api/file?project=${q}&path=${raw ? rel : enc(rel)}`)
    // 403 还须是「路径越界」而非「项目未在白名单」/其它拒绝（防假通过）
    const ok = r.status === expect && (expect !== 403 || r.body.includes("路径越界"))
    record(ok, `file-guard/${name}`, `path=${JSON.stringify(rel)} -> ${r.status} (want ${expect})${ok ? "" : " " + JSON.stringify(r.body.slice(0, 80))}`)
  }
  // 读到的内容必须与文件真实内容一致（防「只过状态码、内容串了」）
  {
    const r = await api(`/api/file?project=${q}&path=a.txt`)
    record(r.status === 200 && r.body.includes("hello"), "file-content", `a.txt -> ${r.status} body=${JSON.stringify(r.body.slice(0, 40))}`)
  }

  // （仅 win32）cmd /d /s /c 拉 .cmd 批处理——dev.mjs / 自更新编排的同一修复语义
  if (IS_WIN) {
    await new Promise((resolve) => {
      const child = spawn(process.env.comspec || "cmd.exe", ["/d", "/s", "/c", "npm", "--version"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsVerbatimArguments: true,
      })
      let out = ""
      child.stdout.on("data", (d) => { out += d })
      const killer = setTimeout(() => { try { child.kill() } catch { /* */ } }, 60000)
      child.on("exit", (code) => {
        clearTimeout(killer)
        const ver = out.trim().split("\n")[0]?.trim() ?? ""
        record(code === 0 && /^\d+\.\d+\.\d+/.test(ver), "npm-cmd", `cmd /d /s /c npm --version -> exit=${code} out=${JSON.stringify(ver.slice(0, 20))}`)
        resolve()
      })
      child.on("error", (e) => { clearTimeout(killer); record(false, "npm-cmd", String(e)); resolve() })
    })
  } else {
    skip("npm-cmd", "win32-only check — run this script on Windows")
  }
}

async function finish() {
  // 先让服务真退出（Windows 上进程未退会使临时目录 rm 失败——文件占用）
  try {
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise((r) => server.once("exit", r))
      server.kill()
      await Promise.race([exited, wait(3000)])
    }
  } catch { /* already gone */ }
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }) } catch { /* best-effort */ }
  const failed = results.filter((r) => r.ok === false)
  const passed = results.filter((r) => r.ok === true).length
  const skipped = results.filter((r) => r.ok === null).length
  console.log(`\n=== SUMMARY: ${passed} pass, ${failed.length} fail, ${skipped} skip  (node ${process.versions.node}, ${process.platform} ${process.arch}) ===`)
  if (!IS_WIN && failed.length === 0) {
    console.log("NOTE: this is a POSIX run — win32-specific assertions were skipped. Run `node scripts/verify-windows.mjs` on a Windows machine (Node >= 22.5) for the real verdict.")
  }
  process.exitCode = failed.length ? 1 : 0
}
