/**
 * bridge/rewind.mjs — 会话级快照与回退（"复制 / 回退" 功能的后端）
 *
 * 为什么不用内核 checkpoint.rewind（见 docs/rewind-copy-feasibility.md）：
 * 内核快照是"相对 HEAD 的补丁"，用户中途 commit 就 apply 失败，--3way 还会把冲突标记写进文件。
 *
 * 本模块机制：
 * - 快照 = 用临时索引把工作区当前内容写成 git tree 对象，再用 refs/tcw/snap/<id> 固定。
 *   天然不受 HEAD 漂移影响；未跟踪文件与二进制一并覆盖；对象存项目自己的 .git（自动去重压缩）；
 *   全程不碰 HEAD、不碰暂存区、不碰工作区（只读工作区 + 写对象库）。
 * - 回退 = 还原会话文件副本（对话）+ 用 tree 还原工作区（内容回写 + 删掉此后新建的文件）。
 * - 首次打点时若项目目录自身还不是 git 仓库根，自动在项目目录内 git init（写默认忽略清单 + 首次提交），
 *   使 git 机制对所有项目生效。仓库永远是项目目录内的独立仓库，不依赖、不落入任何上层仓库。
 * - 可撤销：回退前先把当前状态存成一条"回退前记录"，撤销时连同记录表一起还原。
 *
 * 数据布局：
 *   ~/.thincoder-webui/rewind-ignore.txt            默认忽略清单（每次 git add 用 -c core.excludesFile 传入）
 *   ~/.thincoder-webui/rewinds/<sha1(cwd)12>/index.json   记录表（快照点 + 撤销栈 + 降级状态）
 *   ~/.thincoder-webui/rewinds/<sha1(cwd)12>/<id>/session.json  会话文件副本
 */

import { execFileSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, sep } from "node:path"
import { dataDir } from "../lib/auth.mjs"
import { loadThincoder, poolEntries } from "./thincoder.mjs"
import * as subagents from "./subagents.mjs"

const SNAP_REF_PREFIX = "refs/tcw/snap/"
const KEEP_RECORDS = 60 // 每项目保留的会话回退点
const UNDO_STACK_MAX = 5 // 可撤销的回退次数
const MAX_FILES = 30_000 // 纳入快照的文件数上限（超过则本项目降级为"仅对话回退"）
const MAX_UNTRACKED_BYTES = 256 * 1024 * 1024 // 未跟踪文件总字节上限（新 blob 的主要来源）
const GIT_TIMEOUT_MS = 60_000
const PREVIEW_LIMIT = 300 // 受影响文件清单最多展示条数

/** 默认忽略清单：非 git 项目初始化时写入 .git/info/exclude，同时每次 add 都以此作为 core.excludesFile */
const DEFAULT_IGNORES = [
  "node_modules/",
  "dist/",
  "build/",
  "out/",
  ".next/",
  ".nuxt/",
  ".output/",
  ".turbo/",
  ".parcel-cache/",
  ".cache/",
  "coverage/",
  "target/",
  "__pycache__/",
  "*.pyc",
  ".venv/",
  "venv/",
  ".DS_Store",
  "*.log",
]

const rewindRoot = join(dataDir, "rewinds")
const ignoreFile = join(dataDir, "rewind-ignore.txt")

// ================= git 调用 =================

let ignoreReady = false
function ensureIgnoreFile() {
  if (ignoreReady) return
  try {
    mkdirSync(dataDir, { recursive: true })
    if (!existsSync(ignoreFile)) writeFileSync(ignoreFile, DEFAULT_IGNORES.map((l) => l + "\n").join(""), "utf8")
  } catch {
    /* 写不了就退化为不额外忽略 */
  }
  ignoreReady = true
}

/**
 * 统一 git 调用。默认带 core.excludesFile（只影响本次命令，不写进仓库配置），
 * GIT_TERMINAL_PROMPT=0 防止任何交互挂住服务。
 */
function git(cwd, args, { allowFail = false, indexFile = null, useIgnore = true, timeout = GIT_TIMEOUT_MS } = {}) {
  const exec = []
  if (useIgnore) exec.push("-c", `core.excludesFile=${ignoreFile}`)
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  if (indexFile) env.GIT_INDEX_FILE = indexFile
  try {
    return execFileSync("git", [...exec, ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    })
  } catch (err) {
    if (allowFail) return null
    const detail = String(err.stderr ?? err.message).trim().split("\n")[0]
    throw new Error(`git ${args.join(" ")} 失败：${detail}`)
  }
}

function lines(out) {
  return String(out ?? "").split("\n").map((s) => s.trim()).filter(Boolean)
}

function hasHead(cwd) {
  return git(cwd, ["rev-parse", "--verify", "-q", "HEAD"], { allowFail: true }) !== null
}

/** cwd 相对仓库根的前缀（仓库根为空串，子目录形如 "sub/"） */
function repoPrefix(cwd) {
  return String(git(cwd, ["rev-parse", "--show-prefix"], { allowFail: true }) ?? "").trim()
}

// ================= 记录表 =================

function projectKey(cwd) {
  return createHash("sha1").update(cwd).digest("hex").slice(0, 12)
}

function projectDir(cwd) {
  return join(rewindRoot, projectKey(cwd))
}

function indexPath(cwd) {
  return join(projectDir(cwd), "index.json")
}

function emptyIndex(cwd) {
  return { version: 1, project: cwd, managed: false, degraded: null, records: [], undoStack: [] }
}

function loadIndex(cwd) {
  try {
    const raw = JSON.parse(readFileSync(indexPath(cwd), "utf8"))
    return {
      version: 1,
      project: cwd,
      managed: Boolean(raw.managed),
      degraded: typeof raw.degraded === "string" ? raw.degraded : null,
      records: Array.isArray(raw.records) ? raw.records : [],
      undoStack: Array.isArray(raw.undoStack) ? raw.undoStack : [],
    }
  } catch {
    return emptyIndex(cwd)
  }
}

function saveIndex(cwd, data) {
  const p = indexPath(cwd)
  mkdirSync(projectDir(cwd), { recursive: true, mode: 0o700 })
  const tmp = p + ".tmp"
  writeFileSync(tmp, JSON.stringify(data), "utf8")
  try { unlinkSync(p) } catch { /* 不存在就算了 */ }
  renameSync(tmp, p)
}

function newId(prefix) {
  return prefix + Date.now().toString(36) + randomBytes(3).toString("hex")
}

function hashText(text) {
  return createHash("sha1").update(String(text)).digest("hex")
}

// ================= git 托管 =================

/**
 * 项目目录自身是否已是独立仓库根（.git 就在项目目录里）。
 * 仅"位于某个上层仓库内"不算——那种情况必须在本目录 init 独立仓库，
 * 否则快照对象与 refs 会写进上层仓库，回退也会牵动上层目录。
 */
function isOwnRepo(cwd) {
  const root = String(git(cwd, ["rev-parse", "--show-toplevel"], { allowFail: true }) ?? "").trim()
  if (!root) return false
  try {
    return realpathSync(root) === realpathSync(cwd)
  } catch {
    return root === cwd
  }
}

/**
 * 保证项目处于 git 管理下，且仓库根就是项目目录本身（独立仓库，不跟踪也不依赖上层目录）：
 * 非 git 项目、以及仅被某个更大仓库覆盖的项目，都会在项目目录内自动 init + 默认忽略清单 + 首次提交
 * （嵌套后 git 取最内层 .git，上层仓库自然不再跟踪本目录内文件）。
 * 项目目录自身已是仓库根则什么都不做，绝不改动其配置。
 */
export async function ensureGitManaged(cwd) {
  if (isOwnRepo(cwd)) return { initialized: false }
  git(cwd, ["init", "-q"], { allowFail: true })
  if (!isOwnRepo(cwd)) throw new Error("git init 失败，无法启用会话回退")
  // 默认忽略清单写进 .git/info/exclude（不改项目文件；用户自己的 git status 也会因此干净）
  const exclude = join(cwd, ".git", "info", "exclude")
  try {
    mkdirSync(dirname(exclude), { recursive: true })
    const existed = existsSync(exclude) ? readFileSync(exclude, "utf8") : ""
    const missing = DEFAULT_IGNORES.filter((l) => !existed.includes(l))
    if (missing.length) writeFileSync(exclude, existed + (existed.endsWith("\n") || !existed ? "" : "\n") + missing.map((l) => l + "\n").join(""), "utf8")
  } catch { /* 忽略清单写不了不影响快照本身 */ }
  git(cwd, ["add", "-A", "--", "."], { allowFail: true })
  git(
    cwd,
    ["-c", "user.name=thincoder-webui", "-c", "user.email=thincoder-webui@localhost", "commit", "-qm", "chore: 初始化 git（thincoder-webui 会话回退）"],
    { allowFail: true }
  )
  return { initialized: true }
}

// ================= 快照 =================

/** 规模守卫：文件数 / 未跟踪字节数超限则返回降级原因 */
function sizeGuard(cwd) {
  const all = lines(git(cwd, ["ls-files", "-co", "--exclude-standard", "--", "."], { allowFail: true }) ?? "")
  if (all.length > MAX_FILES) return `项目文件数超过 ${MAX_FILES}，已跳过文件快照`
  let bytes = 0
  for (const rel of lines(git(cwd, ["ls-files", "-o", "--exclude-standard", "--", "."], { allowFail: true }) ?? "")) {
    try { bytes += statSync(join(cwd, rel)).size } catch { /* 读不到就跳过 */ }
    if (bytes > MAX_UNTRACKED_BYTES) return `未跟踪文件总量超过 ${Math.round(MAX_UNTRACKED_BYTES / 1024 / 1024)}MB，已跳过文件快照`
  }
  return null
}

/**
 * 把工作区当前内容写成一个 tree 对象（不落引用、不动 HEAD / 索引 / 工作区）。
 * 先 read-tree HEAD 再 add -A：让 git 只对"有变化的文件"重新计算对象，
 * 已跟踪文件也不因 .gitignore 而被漏掉。
 */
function buildWorktreeTree(cwd, indexFile) {
  const tmpIndex = indexFile ?? join(dataDir, `tmp-index-${randomBytes(4).toString("hex")}`)
  try {
    if (hasHead(cwd)) git(cwd, ["read-tree", "HEAD"], { indexFile: tmpIndex })
    git(cwd, ["add", "-A", "--", "."], { indexFile: tmpIndex })
    return git(cwd, ["write-tree"], { indexFile: tmpIndex }).trim()
  } finally {
    if (!indexFile) { try { unlinkSync(tmpIndex) } catch { /* 临时索引清不掉无碍 */ } }
  }
}

/** 把工作区当前内容写成 tree 对象并固定到 refs/tcw/snap/<id> */
function makeTreeSnapshot(cwd, id) {
  const tree = buildWorktreeTree(cwd)
  const commit = git(
    cwd,
    ["-c", "user.name=thincoder-webui", "-c", "user.email=thincoder-webui@localhost", "commit-tree", tree, "-m", `thincoder-webui 会话快照 ${id}`]
  ).trim()
  git(cwd, ["update-ref", SNAP_REF_PREFIX + id, commit])
  return { tree, commit, ref: SNAP_REF_PREFIX + id }
}

async function sessionPathOf(cwd) {
  const t = await loadThincoder()
  return t.session.currentSessionFile(cwd) // 槽位模型：当前会话 = 活动槽文件；无活动槽返回 null（调用侧当空会话）
}

/**
 * 打点：为"这条消息发出之前"的状态建立一条记录（工作区树快照 + 会话文件副本）。
 * 返回 { id } 或 { skipped, reason }。
 */
export async function capture(cwd, { msgId, text }) {
  const idx = loadIndex(cwd)
  const warnings = []

  let initialized = false
  if (!idx.degraded) {
    try {
      const r = await ensureGitManaged(cwd)
      initialized = r.initialized
    } catch (err) {
      idx.degraded = `无法启用 git 管理：${err.message}`
    }
  }

  if (!idx.degraded) {
    const reason = sizeGuard(cwd)
    if (reason) idx.degraded = reason
  }

  const id = newId("r")
  const dir = join(projectDir(cwd), id)
  let files = 0
  let ref = null

  if (!idx.degraded) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const snap = makeTreeSnapshot(cwd, id)
      ref = snap.ref
      files = treeFileCount(cwd, ref)
    } catch (err) {
      idx.degraded = `快照失败：${err.message}`
      ref = null
    }
  }

  // 会话文件副本（对话回退的权威来源；文件不存在也算正常，回退时清空会话）
  const sessionFile = join(dir, "session.json")
  let hasSession = false
  try {
    const sp = await sessionPathOf(cwd)
    if (existsSync(sp)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      copyFileSync(sp, sessionFile)
      hasSession = true
    }
  } catch { /* 会话文件读不到就当空会话 */ }

  // 记录只从尾部保留；撤销栈随新消息作废（回退后已继续前进，不能再撤销回去）
  const record = {
    id,
    msgId: msgId ?? null,
    ts: Date.now(),
    textHash: hashText(text ?? ""),
    preview: String(text ?? "").slice(0, 120),
    ref,
    hasSession,
    files,
  }
  const records = [...idx.records, record].slice(-KEEP_RECORDS)
  const dropped = idx.records.length + 1 - records.length
  if (dropped > 0) for (const r of idx.records.slice(0, dropped)) dropRecordArtifacts(cwd, r)

  saveIndex(cwd, { ...idx, managed: idx.managed || initialized, records, undoStack: [] })
  if (initialized) warnings.push("该项目原本没有自己的 git 仓库（或仅被上层仓库覆盖），已在项目目录内初始化独立 git 仓库（含默认忽略清单与首次提交）以支持回退")
  if (idx.degraded) warnings.push(`文件回退已降级：${idx.degraded}（对话仍可回退）`)
  return { id, degraded: idx.degraded, warnings }
}

function treeFileCount(cwd, ref) {
  const prefix = repoPrefix(cwd)
  return lines(git(cwd, ["ls-tree", "-r", "--name-only", ref], { allowFail: true }) ?? "")
    .filter((p) => !prefix || p.startsWith(prefix)).length
}

function dropRecordArtifacts(cwd, record) {
  try { if (record?.ref) git(cwd, ["update-ref", "-d", record.ref], { allowFail: true }) } catch { /* 引用已失效 */ }
  try { if (record?.id) rmSync(join(projectDir(cwd), record.id), { recursive: true, force: true }) } catch { /* 目录清理失败无碍 */ }
}

/** 清空某项目的全部回退点（新建 / 切换会话后，旧记录的会话副本已不对应当前会话） */
export function resetProject(cwd) {
  const idx = loadIndex(cwd)
  for (const r of idx.records) dropRecordArtifacts(cwd, r)
  for (const u of idx.undoStack) dropRecordArtifacts(cwd, u)
  saveIndex(cwd, { ...emptyIndex(cwd), managed: idx.managed })
}

// ================= 回退 =================

/** 回退前给"当前状态"也存一条（供撤销用） */
async function snapshotCurrentForUndo(cwd, reason) {
  const id = newId("u")
  const dir = join(projectDir(cwd), id)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const snap = makeTreeSnapshot(cwd, id)
  const sessionFile = join(dir, "session.json")
  let hasSession = false
  try {
    const sp = await sessionPathOf(cwd)
    if (existsSync(sp)) {
      copyFileSync(sp, sessionFile)
      hasSession = true
    }
  } catch { /* 同 capture：拿不到就当空会话 */ }
  return { id, ref: snap.ref, sessionFile, hasSession, ts: Date.now(), reason }
}

/** 用 tree 还原工作区：回写快照内文件内容，删除快照之后新建的文件 */
function restoreWorktree(cwd, ref) {
  const prefix = repoPrefix(cwd)
  const treeFiles = lines(git(cwd, ["ls-tree", "-r", "--name-only", ref]))
    .filter((p) => !prefix || p.startsWith(prefix))
    .map((p) => (prefix ? p.slice(prefix.length) : p))
  const keep = new Set(treeFiles)

  git(cwd, ["restore", "--source", ref, "--worktree", "--", "."])

  let removed = 0
  const nowFiles = lines(git(cwd, ["ls-files", "-co", "--exclude-standard", "--", "."], { allowFail: true }) ?? "")
  for (const rel of nowFiles) {
    if (keep.has(rel)) continue
    const abs = join(cwd, rel)
    try {
      rmSync(abs, { force: true })
      removed++
      pruneEmptyDirs(cwd, dirname(abs))
    } catch { /* 单个删不掉不阻断整体 */ }
  }
  return { restored: treeFiles.length, removed }
}

/** 删除文件后顺带清掉被腾空的目录（只删到项目根为止，且只删空目录） */
function pruneEmptyDirs(root, startDir) {
  let cur = startDir
  while (cur !== root && cur.startsWith(root + sep)) {
    try {
      if (readdirSync(cur).length > 0) return
      rmSync(cur, { recursive: false, force: true })
    } catch {
      return
    }
    cur = dirname(cur)
  }
}

/** 会话回退：写回会话文件副本，并让内存中的 agent 重新加载 */
async function restoreSession(cwd, record) {
  const t = await loadThincoder()
  const src = join(projectDir(cwd), record.id, "session.json")
  // 该记录当时还没有会话文件 = 回退到「会话开始之前」→ 清空会话（而不是原样留着）
  if (!record.hasSession || !existsSync(src)) return clearSessionToEmpty(t, cwd)

  // 槽位模型：写回活动槽文件（无活动槽则落 1 号槽——内核下次保存会懒恢复清单元数据）
  const sp = t.session.currentSessionFile(cwd) ?? t.session.slotPath(cwd, 1)
  copyFileSync(src, sp)
  const data = await t.session.loadSession(cwd)
  const entry = poolEntries().get(cwd)
  if (entry && data) {
    t.session.applySession(entry.agent, data)
    // 压缩基准与轮次计数随旧历史一起失效（否则下次运行会按旧上下文判断是否需要压缩）
    entry.agent._lastPromptTokens = null
    entry.agent._usageAtLen = null
    entry.agent._turnsSinceTaskUpdate = 0
    entry.agent._turnsInPlanMode = 0
  }
  const history = Array.isArray(data?.history) ? data.history : []
  return {
    restored: true,
    messages: history.filter((m) => m.role === "user" && !m.transient).length,
    tasks: Array.isArray(data?.tasks) ? data.tasks : [],
    planMode: Boolean(data?.planMode),
  }
}

/**
 * 把会话彻底清空：直接把活动槽文件覆写为空会话（不新开槽位、不归档），
 * 同时重置内存中的 agent，使对话真正回到「一条消息都没有」的状态。
 */
function clearSessionToEmpty(t, cwd) {
  const sp = t.session.currentSessionFile(cwd) ?? t.session.slotPath(cwd, 1)
  // 空会话数据面 = 内核 newSession 的空槽形态（session-lifecycle）
  const empty = {
    version: 2, cwd, title: "", updatedAt: Date.now(), history: [], contextHistory: [],
    tasks: [], planMode: false, goal: null, autoApprove: false, advisor: null,
    pendingReminders: [], sessionStart: null,
  }
  try {
    mkdirSync(dirname(sp), { recursive: true })
    const tmp = `${sp}.tmp`
    writeFileSync(tmp, JSON.stringify(empty), "utf8")
    try { unlinkSync(sp) } catch { /* 旧文件不存在就算了 */ }
    renameSync(tmp, sp)
  } catch { /* 写不动就只清内存，下次保存会覆盖文件 */ }

  const entry = poolEntries().get(cwd)
  if (entry) {
    t.session.resetSessionState(entry.agent)
    entry.agent.autoApprove = false
    entry.agent._lastPromptTokens = null
    entry.agent._usageAtLen = null
    entry.agent._turnsSinceTaskUpdate = 0
    entry.agent._turnsInPlanMode = 0
    entry.restored = null
  }
  return { restored: true, messages: 0, tasks: [], planMode: false }
}

/**
 * 受影响文件清单：目标快照的树 vs 当前工作区的树（树对树比较，未跟踪文件也算得准）。
 * A = 快照之后新建 → 回退时会被删除；D = 快照里有、现在没有 → 会被恢复；M = 内容会被还原。
 */
export function previewRollback(cwd, id) {
  const idx = loadIndex(cwd)
  const rec = idx.records.find((r) => r.id === id)
  if (!rec) throw new Error("回退点不存在（可能已被新消息淘汰或会话已重置）")
  if (!rec.ref) return { files: [], truncated: false, degraded: idx.degraded }
  const curTree = buildWorktreeTree(cwd)
  const raw = lines(git(cwd, ["diff", "--name-status", rec.ref, curTree, "--", "."], { allowFail: true }) ?? "")
  const files = []
  for (const line of raw) {
    const parts = line.split("\t")
    const status = parts[0]?.[0]
    const p = parts.slice(1).join("\t").trim()
    if (!p || !status) continue
    files.push({ path: p, status })
  }
  return { files: files.slice(0, PREVIEW_LIMIT), truncated: files.length > PREVIEW_LIMIT, degraded: idx.degraded }
}

/**
 * 回退到"某条消息发送之前"：还原会话 + 工作区，并把该消息及其后的回退点从记录表中截掉。
 * 回退前会先存一份当前状态，故可撤销。调用方需保证项目非运行中。
 */
export async function rollback(cwd, id) {
  const idx = loadIndex(cwd)
  const at = idx.records.findIndex((r) => r.id === id)
  if (at < 0) throw new Error("回退点不存在（可能已被新消息淘汰或会话已重置）")
  const target = idx.records[at]

  const undoEntry = await snapshotCurrentForUndo(cwd, `回退到 ${target.preview.slice(0, 40)}`)
  undoEntry.recordsBefore = idx.records

  let work = { restored: 0, removed: 0 }
  let session = { restored: false, messages: 0 }
  if (target.ref) work = restoreWorktree(cwd, target.ref)
  session = await restoreSession(cwd, target)

  const records = idx.records.slice(0, at)
  const droppedRecords = idx.records.slice(at)
  for (const r of droppedRecords) dropRecordArtifacts(cwd, r)

  const undoStack = [...idx.undoStack, undoEntry].slice(-UNDO_STACK_MAX)
  const overflow = idx.undoStack.length + 1 - undoStack.length
  if (overflow > 0) for (const u of idx.undoStack.slice(0, overflow)) dropRecordArtifacts(cwd, u)

  saveIndex(cwd, { ...idx, records, undoStack })

  // 回退生效：会话已回到旧点，子代理面板的进度行不再对应于当前会话——清空
  subagents.clear(cwd)

  return {
    messages: droppedRecords.length,
    files: work.restored,
    removed: work.removed,
    sessionRestored: session.restored,
    tasks: session.tasks,
    planMode: session.planMode,
    degraded: idx.degraded,
    undo: { available: true, id: undoEntry.id, at: undoEntry.ts },
  }
}

/** 撤销上一次回退（还原工作区 + 会话 + 记录表） */
export async function undoRollback(cwd) {
  const idx = loadIndex(cwd)
  const entry = idx.undoStack[idx.undoStack.length - 1]
  if (!entry) throw new Error("没有可撤销的回退")

  const work = entry.ref ? restoreWorktree(cwd, entry.ref) : { restored: 0, removed: 0 }
  let tasks = []
  let planMode = false
  if (entry.hasSession && existsSync(entry.sessionFile)) {
    const t = await loadThincoder()
    copyFileSync(entry.sessionFile, t.session.sessionPath(cwd))
    const data = t.session.loadSession(cwd)
    const pool = poolEntries().get(cwd)
    if (pool && data) {
      t.session.applySession(pool.agent, data)
      pool.agent._lastPromptTokens = null
      pool.agent._usageAtLen = null
      pool.agent._turnsSinceTaskUpdate = 0
      pool.agent._turnsInPlanMode = 0
    }
    tasks = Array.isArray(data?.tasks) ? data.tasks : []
    planMode = Boolean(data?.planMode)
  }

  const records = Array.isArray(entry.recordsBefore) ? entry.recordsBefore : idx.records
  dropRecordArtifacts(cwd, entry)
  saveIndex(cwd, { ...idx, records, undoStack: idx.undoStack.slice(0, -1) })
  // 会话又跳了一次（回到回退前）——面板行只对当前会话的进度有意义，与 rollback 同口径清空
  subagents.clear(cwd)
  return { files: work.restored, removed: work.removed, restoredRecords: records.length, tasks, planMode }
}

/** 供 GET /api/rewind/points：回退点列表 + 撤销可用性 */
export function listPoints(cwd) {
  const idx = loadIndex(cwd)
  return {
    supported: !idx.degraded,
    managed: idx.managed,
    degraded: idx.degraded,
    points: idx.records.map((r) => ({ id: r.id, msgId: r.msgId, ts: r.ts, preview: r.preview, files: r.files })),
    canUndo: idx.undoStack.length > 0,
  }
}

/**
 * 把内核 history 里的真实 user 消息与回退记录对齐（贪心前缀匹配 + 文本哈希校验）。
 * 找不到对应记录的（TUI 发的、已被压缩掉的、已超出保留窗口的）返回 null → 前端置灰。
 * 命中的返回 { id, ts }（ts 为消息提交时刻，供时间线显示）。
 */
export function alignHistory(cwd, userTexts) {
  const idx = loadIndex(cwd)
  const out = []
  let ptr = 0
  for (const text of userTexts) {
    const h = hashText(text)
    let found = null
    for (let i = ptr; i < idx.records.length; i++) {
      if (idx.records[i].textHash === h) {
        found = idx.records[i]
        ptr = i + 1
        break
      }
    }
    out.push(found ? { id: found.id, ts: found.ts } : null)
  }
  return out
}
