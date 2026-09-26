/**
 * bridge/git.mjs — Git 浏览与检查点（M3，只读优先）
 *
 * 边界与内核一致：全部走系统 git；检查点走内核 checkpoint.mjs
 *（listCheckpoints / createCheckpoint / rewind，回滚前自动打快照故可逆）。
 * 不做 stage/commit 等写操作（P2）。
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs"
import { rm, cp, mkdir } from "node:fs/promises"
import { join, dirname } from "node:path"
import { createHash } from "node:crypto"
import { loadThincoder } from "./thincoder.mjs"

const DIFF_LIMIT = 200 * 1024

function git(cwd, args, { allowFail = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (error) {
    if (allowFail) return null
    throw new Error(`git ${args.join(" ")} failed: ${error.stderr?.toString().trim() || error.message}`)
  }
}

export function isRepo(cwd) {
  try {
    return git(cwd, ["rev-parse", "--is-inside-work-tree"]).trim() === "true"
  } catch {
    return false
  }
}

/**
 * git status 解析：branch / ahead / behind / 分组文件清单
 * porcelain XY：X=暂存区状态，Y=工作区状态；"?"=未跟踪
 */
export function gitStatus(cwd) {
  const raw = git(cwd, ["status", "--porcelain=v1", "-b", "--untracked-files=normal"])
  const lines = raw.split("\n").filter(Boolean)

  let branch = ""
  let ahead = 0
  let behind = 0
  const staged = []
  const unstaged = []
  const untracked = []

  for (const line of lines) {
    if (line.startsWith("## ")) {
      // ## main...origin/main [ahead 1, behind 2]
      const head = line.slice(3)
      const m = head.match(/^([^.\s[]+)(?:\.\.(\S+?))?(?:\s+\[(.+)\])?$/)
      branch = m?.[1] ?? head
      const ab = m?.[3] ?? ""
      ahead = Number(ab.match(/ahead (\d+)/)?.[1] ?? 0)
      behind = Number(ab.match(/behind (\d+)/)?.[1] ?? 0)
      continue
    }
    const x = line[0]
    const y = line[1]
    let path = line.slice(3)
    const arrow = path.indexOf(" -> ")
    if (arrow >= 0) path = path.slice(arrow + 4) // rename：显示新名
    if (x === "?") untracked.push(path)
    else {
      if (x !== " " && x !== "?") staged.push({ path, code: x })
      if (y !== " " && y !== "?") unstaged.push({ path, code: y })
    }
  }
  return { repo: true, branch, ahead, behind, staged, unstaged, untracked }
}

/** 提交历史（新→旧） */
export function gitLog(cwd, n = 30) {
  const raw = git(cwd, ["log", "--pretty=format:%H%x1f%an%x1f%aI%x1f%s", "-n", String(Number(n) || 30)])
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, author, date, subject] = line.split("\x1f")
      return { hash, short: hash.slice(0, 7), author, date, subject }
    })
}

/** 单文件 diff（未跟踪文件无 git diff 可给，返回 note） */
export function gitFileDiff(cwd, path, { staged = false } = {}) {
  const args = ["diff", "--no-color"]
  if (staged) args.push("--cached")
  args.push("--", path)
  const out = git(cwd, args)
  if (!out.trim()) return { text: "", truncated: false, note: "无差异（或文件未跟踪/不在该状态）" }
  if (out.length > DIFF_LIMIT) return { text: out.slice(0, DIFF_LIMIT), truncated: true }
  return { text: out, truncated: false }
}

// ---------- 检查点（内核能力透出） ----------

export async function listCheckpoints(cwd) {
  const t = await loadThincoder()
  if (!t.checkpoint.isGitRepo(cwd)) return []
  return t.checkpoint.listCheckpoints(cwd)
}

export async function createCheckpoint(cwd) {
  const t = await loadThincoder()
  const cp = await t.checkpoint.createCheckpoint(cwd)
  if (!cp) throw new Error("当前项目不是 git 仓库，无法创建检查点")
  return cp
}

/**
 * 回滚到检查点（桥接层实现，不修改内核）。
 *
 * 为什么不用内核的 rewind：
 * 1) 内核 git() 帮助函数 .trim() 会剪掉补丁尾部换行，非空补丁在部分 git 版本上
 *    `git apply` 必然报 "corrupt patch"（thincoder 0.5.0 已实测）；
 * 2) 内核先 `checkout -- .` 再 apply，补丁里的"新建文件"若仍在工作区（如当时已暂存）
 *    会报 "already exists"。
 * 此处复用内核的快照目录格式与 createCheckpoint（回滚前自动存档，操作可逆）。
 */
export async function rewindCheckpoint(cwd, id) {
  const t = await loadThincoder()
  const root = join(
    t.config.configDir,
    "checkpoints",
    createHash("sha1").update(cwd).digest("hex").slice(0, 12)
  )
  const dir = join(root, String(id))
  if (!existsSync(join(dir, "meta.json"))) throw new Error(`检查点 ${id} 不存在`)
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"))

  // 1) 回滚可逆：先给当前状态打快照（内核创建快照无上述问题）
  await t.checkpoint.createCheckpoint(cwd)

  // 2) 工作区归零：取消全部暂存 → 跟踪文件回 HEAD
  git(cwd, ["reset", "-q"])
  git(cwd, ["checkout", "-q", "--", "."])

  // 3) 应用快照补丁（补回被内核 .trim() 剪掉的尾部换行）
  let patch = readFileSync(join(dir, "patch.diff"), "utf8")
  let patchApplied = false
  if (patch.trim()) {
    if (!patch.endsWith("\n")) patch += "\n"
    // 补丁中"新建文件"若已存在于工作区，先移除——补丁携带其完整内容，不丢数据
    for (const nf of newFilesInPatch(patch)) {
      try { unlinkSync(join(cwd, nf)) } catch { /* 不存在就算了 */ }
    }
    const tmpPatch = join(dir, "apply.tmp.diff")
    writeFileSync(tmpPatch, patch, "utf8")
    try {
      git(cwd, ["apply", "--whitespace=nowarn", tmpPatch])
      patchApplied = true
    } finally {
      try { unlinkSync(tmpPatch) } catch { /* 清理失败无碍 */ }
    }
  }

  // 4) 未跟踪文件同步（与内核语义一致）
  const nowUntracked = (git(cwd, ["ls-files", "--others", "--exclude-standard"], { allowFail: true }) ?? "")
    .split("\n")
    .filter(Boolean)
  const checkpointSet = new Set(meta.untracked ?? [])
  let deleted = 0
  for (const rel of nowUntracked) {
    if (!checkpointSet.has(rel)) {
      await rm(join(cwd, rel), { force: true })
      deleted++
    }
  }
  let restored = 0
  for (const rel of meta.untracked ?? []) {
    const src = join(dir, "untracked", rel)
    if (existsSync(src)) {
      await mkdir(dirname(join(cwd, rel)), { recursive: true })
      await cp(src, join(cwd, rel), { force: true })
      restored++
    }
  }

  return { deleted, restored, patchApplied }
}

/** 从补丁中提取"新建文件"路径（diff --git 后紧跟 new file mode 的条目） */
function newFilesInPatch(patch) {
  const out = []
  let current = null
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/)
      current = m ? m[2] : null
    } else if (line.startsWith("new file mode") && current) {
      out.push(current)
      current = null
    }
  }
  return out
}
