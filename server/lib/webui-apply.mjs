/**
 * webui-apply.mjs — WebUI 一键半自动更新编排器（零依赖）
 *
 * 用户在关于页点「一键更新」后，服务端串行编排：预检 → fetch 公开仓 → ff-only 快进 →
 * npm install（postinstall 会重打内核补丁，设计依赖）→ vite build 落 staging → 换入 server/static。
 * 任一步失败即停在失败步：失败步之前已生效的动作保留（如 install 已完成、HEAD 已前进），
 * 失败步本身的半成品（staging 残留）清掉——现网 server/static 与服务进程不受影响。
 *
 * 安全边界（策划定稿）：
 * - 更新源固定公开仓 hzchrisfang/Thincoder-WebUI main（与版本检查同源常量，来自 webui-update.mjs）；
 * - 脏工作树一律拒绝（列文件条数），绝不 stash；
 * - merge-base 四态判定（无共同祖先 / 落后 / 领先 / 分叉 / 一致）——只有「落后」允许
 *   `git merge --ff-only FETCH_HEAD`，绝不 merge/rebase/reset --hard；
 * - 无任何项目 agent 运行（runner.isBusy）才允许执行；
 * - 服务进程内单飞锁：运行中重复 POST → 409（routes 层判 startWebuiUpdate 返回值）；
 * - 构建先落 server/.static-staging，成功后先卸旧 server/static 再 rename 换入
 *   （Windows rename 不能覆盖已存在目录——仓内 state.mjs saveState 同款先卸旧先例）；
 * - 绝不自重启：成功只推绿色横幅文案，重启手动。
 *
 * Windows 适配：git 裸 spawn + GIT_TERMINAL_PROMPT=0（rewind.mjs git() 先例）；
 * npm 走 cmd /d /s /c（dev.mjs 同款）；构建直接 spawn(process.execPath, [vite.js, build …])
 * 绕开 .cmd 与参数次序问题（dev.mjs process.execPath 先例）。
 */

import { spawn, execFileSync } from "node:child_process"
import { existsSync, mkdirSync, renameSync, rmSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as bus from "./bus.mjs"
import { listProjects } from "./state.mjs"
import { isBusy } from "../bridge/runner.mjs"
import { REPO, REPO_BRANCH } from "./webui-update.mjs"

// ================= 常量 =================

/** 公开仓 clone URL（与版本检查同源；检查与拉取永远同一处字面量） */
const REPO_URL = `https://github.com/${REPO}.git`
/** 远端分支（公开仓主分支，常量来自 webui-update.mjs） */
const REMOTE_BRANCH = REPO_BRANCH
/** 服务根（routes.mjs 的 WEBUI_VERSION 同款推导：lib/ 上一级） */
const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
/** vite 构建输出 staging（服务根同卷——rename 才是原子的） */
const STAGING_DIR = join(ROOT_DIR, "server", ".static-staging")
/** 现网前端目录 */
const STATIC_DIR = join(ROOT_DIR, "server", "static")
/** 日志环形缓冲上限（行）——status 接口只回尾部 */
const LOG_MAX = 400
/** 子进程硬超时：git/network 3 分钟、npm install 15 分钟、构建 15 分钟 */
const GIT_TIMEOUT_MS = 3 * 60 * 1000
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000
const BUILD_TIMEOUT_MS = 15 * 60 * 1000

// ================= 单飞锁 + 任务状态（进程内存，重启即清——重启后 status 回 idle） =================

/** @type {"idle"|"running"|"ok"|"failed"} */
let state = "idle"
/** @type {null|{step:string,status:string,line?:string}} 当前步骤（运行中有值） */
let current = null
/** @type {null|{version:string, at:number, skip?:boolean, message?:string}} 成功结果 */
let result = null
/** @type {null|{step:string, message:string}} 失败结果 */
let failure = null
/** @type {string[]} 日志环形缓冲（含 stderr） */
let logBuf = []
let startedAt = null
let finishedAt = null

/** 当前/最近一次任务状态 + 日志尾部（GET /api/webui-update-status） */
export function webuiUpdateState() {
  return {
    state,
    current,
    result,
    failure,
    logTail: logBuf.slice(-40),
    logTotal: logBuf.length,
    startedAt,
    finishedAt,
  }
}

/** SSE 事件推送（统一走 bus.emit → 前端 /api/events；事件名 webui_update） */
function pushEvent(phase, step, status, line = undefined) {
  current = { step, status, line }
  bus.emit({ type: "webui_update", phase, step, status, line })
}

/** 日志环形缓冲：超上限丢最老的 */
function appendLog(line) {
  if (!line) return
  logBuf.push(line)
  if (logBuf.length > LOG_MAX) logBuf.splice(0, logBuf.length - LOG_MAX)
}

/** 自定义错误：携带 guard 标记（预检拒绝）与步骤名，编排层据此上报 */
class UpdateError extends Error {
  constructor(step, message) {
    super(message)
    this.step = step
  }
}

/**
 * 数组 argv 裸 spawn 一个进程，stdout+stderr 按行合流入日志与 SSE。
 * 返回 { code, output }。env 全量继承（git 需要证书助手/代理变量）。
 */
function runCapture(bin, args, { cwd, timeout }) {
  return new Promise((resolveP) => {
    const child = spawn(bin, args, { cwd, env: process.env, windowsHide: true })
    let out = ""
    let timer = null
    if (timeout) {
      timer = setTimeout(() => {
        appendLog(`（超过 ${Math.round(timeout / 1000)}s 未结束，已终止）`)
        try {
          // win32：杀 cmd 包装进程不会带走 npm 子进程（规则 F 同款语义），必须整树杀
          if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" })
          else child.kill()
        } catch { /* 已退出 */ }
      }, timeout)
    }
    const onLine = (chunk) => {
      for (const ln of String(chunk).split("\n")) {
        const line = ln.replace(/\r$/, "")
        if (!line.trim()) continue
        out += line + "\n"
        if (out.length > 512 * 1024) out = out.slice(-256 * 1024)
        appendLog(line)
        pushEvent("run", current?.step ?? "run", "log", line)
      }
    }
    child.stdout.on("data", onLine)
    child.stderr.on("data", onLine)
    child.on("error", (err) => {
      if (timer) clearTimeout(timer)
      resolveP({ code: -1, output: out + `spawn 失败：${err.message}\n` })
    })
    child.on("close", (code) => {
      if (timer) clearTimeout(timer)
      resolveP({ code: code ?? -1, output: out })
    })
  })
}

/** sync git 调用（预检/判定用；失败抛错，allowFail 时返回 null） */
function gitSync(cwd, args, { allowFail = false } = {}) {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })
    return String(out).trim()
  } catch (err) {
    if (allowFail) return null
    const detail = String(err.stderr ?? err.message).trim().split("\n")[0]
    throw new Error(`git ${args[0]} 失败：${detail}`)
  }
}

/**
 * fetch 公开仓 main 到 FETCH_HEAD，然后 merge-base 四态判定：
 * - 无共同祖先 → 拒绝（非公开仓克隆）
 * - merge-base == HEAD（且 FETCH_HEAD 更前）→ 本地落后 → 可快进
 * - merge-base == FETCH_HEAD → 本地领先 → 拒绝，人工处理
 * - HEAD == FETCH_HEAD → 已与远端一致（skip：不 install 不 build）
 * - 有共同祖先但互不包含 → 分叉 → 拒绝
 */
function classifyAgainstUpstream(webDir) {
  gitSync(webDir, ["fetch", REPO_URL, REMOTE_BRANCH])
  const fetchHead = gitSync(webDir, ["rev-parse", "FETCH_HEAD"])
  const head = gitSync(webDir, ["rev-parse", "HEAD"])
  const base = gitSync(webDir, ["merge-base", "HEAD", "FETCH_HEAD"], { allowFail: true })
  if (!base) {
    return { ok: false, reason: "当前部署不适用一键更新（非公开仓克隆）：与公开仓无共同祖先提交" }
  }
  if (head === fetchHead) return { ok: true, skip: true }
  if (base === head) return { ok: true, fastForward: true }
  if (base === fetchHead) {
    return { ok: false, reason: "本地领先公开仓（fork 或改过代码），无法安全快进，请人工处理" }
  }
  return { ok: false, reason: "本地与公开仓历史分叉，无法安全快进，请人工处理" }
}

/** 清掉 staging 残留（构建前清、失败后清——防中途崩溃残留被提交/误换入） */
function rmStaging() {
  try {
    if (existsSync(STAGING_DIR)) rmSync(STAGING_DIR, { recursive: true, force: true })
  } catch { /* 清不掉不阻塞主流程（下轮构建前还会再清） */ }
}

/** 更新后目标版本号：合并后根 package.json 的 version（编排器读取并上报给前端显示） */
function targetVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT_DIR, "package.json"), "utf8")).version ?? "unknown"
  } catch {
    return "unknown"
  }
}

// ================= 编排主流程 =================

async function runUpdate() {
  const webDir = ROOT_DIR

  /** 步骤包装：SSE 事件 + 日志 + 失败即抛（停在失败步） */
  const step = async (name, fn) => {
    pushEvent("run", name, "start")
    appendLog(`── ${name} ──`)
    try {
      const r = await fn()
      appendLog(`── ${name} 完成 ──`)
      return r
    } catch (err) {
      throw err instanceof UpdateError ? err : new UpdateError(name, err?.message ?? String(err))
    }
  }

  try {
    state = "running"
    startedAt = Date.now()
    finishedAt = null
    result = null
    failure = null
    logBuf = []
    current = null

    // ---------- ① 预检（守卫，任一不满足即拒；单飞锁已在 startWebuiUpdate 保证） ----------
    await step("预检", () => {
      if (!existsSync(join(webDir, ".git"))) {
        throw new UpdateError("预检", "当前目录不是 git 仓库，无法一键更新")
      }
      const dirty = gitSync(webDir, ["status", "--porcelain"])
      if (dirty) {
        const n = dirty.split("\n").filter(Boolean).length
        throw new UpdateError(
          "预检",
          `工作树不干净（${n} 个文件有变更），为避免覆盖本地修改已拒绝——请先提交或人工处理（不会自动 stash）`
        )
      }
      const busyProjects = listProjects()
        .map((p) => p.dir)
        .filter((d) => {
          try { return isBusy(d) } catch { return false }
        })
      if (busyProjects.length > 0) {
        const names = busyProjects.map((d) => d.split(/[\\/]/).filter(Boolean).pop() ?? d).join("、")
        throw new UpdateError("预检", `有项目任务运行中（${names}），请等待运行结束再更新`)
      }
      rmStaging() // 清旧 staging 残留放预检末尾：前面任一守卫拒绝都不会白动文件系统
    })

    // ---------- ② fetch + 四态判定 ----------（skip=true 在下方早退收工；ok=false 抛错停步）
    const verdict = await step("拉取公开仓", () => classifyAgainstUpstream(webDir))
    if (verdict.skip) {
      // ---------- 已与远端一致：直接收工（不 install 不 build；必须早退——若落入「完成」通用收尾，
      // result.skip 会被覆盖、文案变成误导性的「已更新到 vX，重启服务后生效」） ----------
      finishedAt = Date.now()
      result = { version: targetVersion(), at: finishedAt, skip: true, message: "已与远端一致" }
      state = "ok"
      pushEvent("done", "已与远端一致", "ok", `已与远端一致（v${result.version}），无需安装与构建`)
      appendLog(`── 已与远端一致（v${result.version}），无需更新 ──`)
      return
    }
    if (!verdict.ok) throw new UpdateError("拉取公开仓", verdict.reason)
    // ---------- ③ ff-only 快进（绝不 merge/rebase/reset --hard） ----------
    await step("快进", async () => {
      const r = await runCapture("git", ["merge", "--ff-only", "FETCH_HEAD"], { cwd: webDir, timeout: GIT_TIMEOUT_MS })
      if (r.code !== 0) throw new UpdateError("快进", `git merge --ff-only 失败（exit ${r.code}），请人工处理`)
      appendLog("HEAD 已前进到公开仓 main 最新提交")
    })

    // ---------- ④ npm install（根目录；postinstall 重打内核补丁 + 装前端依赖——设计依赖） ----------
    await step("安装依赖", async () => {
      const isWin = process.platform === "win32"
      const bin = isWin ? process.env.comspec || "cmd.exe" : "npm"
      const args = isWin ? ["/d", "/s", "/c", "npm install"] : ["install"]
      const r = await runCapture(bin, args, { cwd: webDir, timeout: INSTALL_TIMEOUT_MS })
      if (r.code !== 0) throw new UpdateError("安装依赖", `npm install 失败（exit ${r.code}）`)
    })

    // ---------- ⑤ vite build → staging ----------
    await step("构建", async () => {
      const viteJs = join(webDir, "web", "node_modules", "vite", "bin", "vite.js")
      if (!existsSync(viteJs)) {
        throw new UpdateError("构建", "未找到 vite（web/node_modules 缺失），请先在根目录 npm install")
      }
      // cwd=web（vite/vite.config.ts 以此解析），outDir 用绝对路径指向 staging，--emptyOutDir 清空后写入
      const r = await runCapture(
        process.execPath,
        [viteJs, "build", "--outDir", STAGING_DIR, "--emptyOutDir"],
        { cwd: join(webDir, "web"), timeout: BUILD_TIMEOUT_MS }
      )
      if (r.code !== 0) throw new UpdateError("构建", `构建失败（vite exit ${r.code}）`)
      if (!existsSync(join(STAGING_DIR, "index.html"))) {
        throw new UpdateError("构建", "构建产物缺 index.html，拒绝换入")
      }
    })

    // ---------- ⑥ staging 换入 server/static（Windows 先卸旧再 rename——rename 不能覆盖已存在目录） ----------
    await step("换入", () => {
      if (existsSync(STATIC_DIR)) rmSync(STATIC_DIR, { recursive: true, force: true })
      renameSync(STAGING_DIR, STATIC_DIR)
    })

    // ---------- ⑦ 完成 ----------
    const version = targetVersion()
    state = "ok"
    finishedAt = Date.now()
    result = { version, at: finishedAt, message: `已更新到 v${version}，重启服务后生效` }
    pushEvent("done", "完成", "ok", result.message)
    appendLog(`── 更新完成：v${version}（重启服务后生效） ──`)
  } catch (err) {
    // 停在失败步：半成品 staging 清掉；失败步之前已生效的动作保留（HEAD/install）
    const stepName = err instanceof UpdateError ? err.step : (current?.step ?? "预检")
    const message = err?.message ?? String(err)
    rmStaging()
    state = "failed"
    failure = { step: stepName, message }
    finishedAt = Date.now()
    pushEvent("fail", stepName, "error", message)
    appendLog(`── 失败于「${stepName}」：${message} ──`)
  }
}

/**
 * 触发更新（单飞锁入口）：运行中重复调用返回 { started:false }（routes 层映射 409）；
 * 空闲则启动异步编排并立即返回——进度走 SSE 与 status 接口，HTTP 请求不挂等。
 */
export function startWebuiUpdate() {
  if (state === "running") {
    return { started: false, reason: "busy", message: "已有更新任务在运行中，请稍候（可在下方日志区查看进度）" }
  }
  runUpdate().catch((err) => {
    // runUpdate 内部已全量 catch；此处只兜真正意外的异常（理论上不可达）
    state = "failed"
    failure = { step: current?.step ?? "未知", message: err?.message ?? String(err) }
    finishedAt = Date.now()
    rmStaging()
  })
  return { started: true }
}
