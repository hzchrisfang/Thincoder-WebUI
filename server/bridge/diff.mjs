/**
 * bridge/diff.mjs — 审批前置 Diff 引擎（策划书 4.5，M1；edit 三形态 2026-09-22）
 *
 * write / edit / delete 执行前，在服务端预生成 unified diff 随审批事件下发：
 * - 首选系统 `git diff --no-index`（临时文件对，高质量逐行 diff）
 * - git 不可用/失败时回退内置行 diff（公共前后缀剥离，单 hunk）
 * - 超大文件不 diff（tooLarge），审批仍可继续（降级为参数预览）
 *
 * edit 三形态（与内核 edit 工具的参数形态一一对应）：
 * - 内容形态 {path, old_string, new_string}
 * - 行号形态 {path, line | startLine+endLine, new_string?}（省略 new_string = 删行）
 * - 批量形态 {path?, edits: [{path?, old_string|line|startLine+endLine, new_string}]}
 *   （同文件条目串行累积、跨文件并行、任一条失败全不写——原子）
 * 预览复用内核 computeEditEntry（注入缝 attachCoreEditHelpers——thincoder.mjs 加载内核后注入）：
 * 判定/应用与实际执行同一内核，语义零漂移（模糊匹配、串行累积、原子校验全部继承）；
 * 预览失败 ⇔ 执行必失败（同一函数同一文件状态）——note 据此如实断言。
 * 内核模块缺失（旧版）→ 注入为空：内容形态走内置保守预览，行号/批量形态返回 null
 * （审批照常，前端兜底渲染负责可读展示）。
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, relative, isAbsolute } from "node:path"

const MAX_FILE_BYTES = 512 * 1024 // 原文件或新内容超过此大小不 diff
const MAX_OUTPUT_LINES = 3000     // diff 输出行数保护
const CONTEXT = 3
const MAX_BATCH_NOTE_FILES = 5    // 多文件批量 note 里的文件清单上限

// ================= 内核注入缝（唯一适配面在 thincoder.mjs——本模块不解析内核路径） =================

/** 内核 edit 判定/应用纯函数集合：{ computeEditEntry, normalizeEOL }（thincoder.mjs 注入） */
let coreEdit = null

export function attachCoreEditHelpers(fns) {
  if (fns && typeof fns.computeEditEntry === "function" && typeof fns.normalizeEOL === "function") {
    coreEdit = fns
  }
}

/** LF 域归一（内核注入优先；注入缺失时本地等价实现——预览用途，CRLF→LF 已足够） */
function normLf(text) {
  return coreEdit ? coreEdit.normalizeEOL(text) : text.replace(/\r\n/g, "\n")
}

/**
 * 为工具调用生成 diff 载荷。非 write/edit/delete 返回 null。
 * 返回 {
 *   format: "unified",
 *   label,            // 展示用文件路径（相对项目目录）；多文件批量 = 「批量编辑 · N 个文件」
 *   text,             // unified diff 文本（---/+++/@@ 头 + hunk；多文件 = 各文件段拼接）
 *   added, removed,   // 增/删行数
 *   tooLarge,         // 过大未生成
 *   note?,            // 提示（如 edit 未命中 / 批量第 N 条会失败）
 *   engine            // "git" | "fallback" | "none"
 * }
 */
export function diffForTool(toolBase, args, cwd) {
  try {
    if (toolBase === "write") return diffWrite(args, cwd)
    if (toolBase === "edit") return diffEdit(args, cwd)
    if (toolBase === "delete") return diffDelete(args, cwd)
  } catch {
    return null // diff 是增强，任何异常都不阻塞审批
  }
  return null
}

function absPath(path, cwd) {
  return isAbsolute(path) ? path : resolve(cwd, path)
}

function label(path, cwd) {
  const abs = absPath(path, cwd)
  const rel = relative(cwd, abs)
  return rel.startsWith("..") ? abs : rel
}

function readBefore(abs) {
  try {
    if (!existsSync(abs)) return null
    const buf = readFileSync(abs)
    return buf.toString("utf8")
  } catch {
    return null // 目录（EISDIR）/权限等不可读情形——调用方以 existsSync 区分提示
  }
}

// ================= 提示载荷（engine "none"——前端显示 note 横幅） =================

function emptyDiff(lbl) {
  return { format: "unified", label: lbl, text: "", added: 0, removed: 0, tooLarge: false, engine: "none" }
}

function failedPreview(lbl, reason) {
  return { ...emptyDiff(lbl), note: `此编辑按当前文件内容执行会失败：${reason || "参数或内容校验未通过"}` }
}

/** 内核报错 → 一行精简原因（去批量原子前缀、截断） */
function reasonOf(err) {
  const first = String(err?.message ?? err).split("\n")[0].trim()
  return first.replace(/^edit aborted[^:]*:\s*/, "").slice(0, 200)
}

function missingTarget(lbl, abs) {
  return { ...emptyDiff(lbl), note: existsSync(abs) ? "目标不可读（可能是目录），执行时会报错" : "目标文件不存在，edit 执行时会报错" }
}

function tooLargeResult(lbl, isNewFile = false) {
  return {
    format: "unified", label: lbl, text: "", added: 0, removed: 0,
    tooLarge: true, engine: "none",
    note: isNewFile ? "新文件过大，未生成预览" : "文件过大，未生成 diff（审批不受影响）",
  }
}

// ================= 三种工具 =================

function diffWrite(args, cwd) {
  const pathStr = String(args.path ?? "")
  const abs = absPath(pathStr, cwd)
  const after = String(args.content ?? "")
  const before = readBefore(abs) ?? ""
  if (before === "" && existsSync(abs)) return failedPreview(label(pathStr, cwd), "目标不可读（可能是目录）")
  if (after.length > MAX_FILE_BYTES || before.length > MAX_FILE_BYTES) {
    return tooLargeResult(label(pathStr, cwd), before.length === 0 && after.length > 0)
  }
  return unified(before, after, label(pathStr, cwd))
}

function diffEdit(args, cwd) {
  if (Array.isArray(args.edits)) return diffEditBatch(args, cwd)
  return diffEditSingle(args, cwd)
}

/** 单形态（内容 or 行号——行号判定/删行同样由内核 computeEditEntry 处理） */
function diffEditSingle(args, cwd) {
  const pathStr = String(args.path ?? "")
  const abs = absPath(pathStr, cwd)
  const before = readBefore(abs)
  if (before == null) return missingTarget(label(pathStr, cwd), abs)
  if (before.length > MAX_FILE_BYTES) return tooLargeResult(label(pathStr, cwd))
  const beforeLf = normLf(before)
  if (coreEdit) {
    try {
      const out = coreEdit.computeEditEntry(beforeLf, args, { path: pathStr })
      return unified(beforeLf, out.updated, label(pathStr, cwd))
    } catch (err) {
      return failedPreview(label(pathStr, cwd), reasonOf(err))
    }
  }
  // 无内核注入（旧内核）——保守内容形态预览（行号形态旧内核不存在，不实现）
  const oldString = String(args.old_string ?? "")
  const newString = String(args.new_string ?? "")
  if (oldString === "" || !beforeLf.includes(oldString)) {
    return { ...emptyDiff(label(pathStr, cwd)), note: "old_string 未在文件中命中，edit 执行时会报错" }
  }
  const matches = beforeLf.split(oldString).length - 1
  const after = beforeLf.replace(oldString, newString)
  const result = unified(beforeLf, after, label(pathStr, cwd))
  if (matches > 1) result.note = `old_string 共命中 ${matches} 处，此处按第一处预览`
  return result
}

/** 批量形态：按文件分组 → 同文件串行累积（内核语义）→ 逐文件 unified → 单文件正常/多文件拼接 */
function diffEditBatch(args, cwd) {
  if (!coreEdit) return null // 无内核注入不猜批量语义（审批照常，前端兜底渲染）
  const groups = new Map() // abs → { path, beforeLf, content }
  const entries = args.edits
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] ?? {}
    const p = e.path || args.path // 条目自带 path 优先，顶层 path 为缺省（内核 2026-09-05 裁定语义）
    if (!p) return failedPreview("批量编辑", `第 ${i + 1} 条缺 path（每条需自带 path，或传顶层 path 作为缺省）`)
    const abs = absPath(String(p), cwd)
    let g = groups.get(abs)
    if (!g) {
      const before = readBefore(abs)
      if (before == null) return failedPreview(label(String(p), cwd), existsSync(abs) ? "目标不可读（可能是目录）" : "目标文件不存在，edit 执行时会报错")
      if (before.length > MAX_FILE_BYTES) return tooLargeResult(label(String(p), cwd))
      g = { path: String(p), beforeLf: normLf(before), content: normLf(before) }
      groups.set(abs, g)
    }
    try {
      const out = coreEdit.computeEditEntry(g.content, e, { path: g.path })
      g.content = out.updated // 串行累积：下一条基于本条应用后的内容（同内核 edit-batch）
    } catch (err) {
      return failedPreview(
        label(g.path, cwd),
        `第 ${i + 1} 条会失败：${reasonOf(err)}（批量原子——所有条目都不写入）`,
      )
    }
  }
  // 全部条目可应用——逐文件生成 diff（串行累积后的内容 vs 原文）
  const parts = []
  let added = 0
  let removed = 0
  const labels = []
  for (const g of groups.values()) {
    const lbl = label(g.path, cwd)
    labels.push(lbl)
    const u = unified(g.beforeLf, g.content, lbl)
    added += u.added
    removed += u.removed
    parts.push(u.text)
  }
  if (groups.size === 1) {
    const only = parts[0]
    return { format: "unified", label: labels[0], text: only, added, removed, tooLarge: false, engine: "git" }
  }
  const listed = labels.slice(0, MAX_BATCH_NOTE_FILES).join("、")
  const more = labels.length > MAX_BATCH_NOTE_FILES ? ` 等 ${labels.length} 个文件` : ""
  return {
    format: "unified", label: `批量编辑 · ${groups.size} 个文件`,
    text: parts.join("\n"), added, removed, tooLarge: false, engine: "git",
    note: `批量编辑 ${groups.size} 个文件：${listed}${more}`,
  }
}

function diffDelete(args, cwd) {
  const pathStr = String(args.path ?? "")
  const abs = absPath(pathStr, cwd)
  const before = readBefore(abs)
  if (before == null) {
    return { ...emptyDiff(label(pathStr, cwd)), note: existsSync(abs) ? "目标不可读（可能是目录）" : "目标文件不存在" }
  }
  if (before.length > MAX_FILE_BYTES) return tooLargeResult(label(pathStr, cwd))
  return unified(before, "", label(pathStr, cwd))
}

// ================= diff 生成 =================

/** 统一入口：优先 git，失败回退 */
function unified(beforeText, afterText, lbl) {
  const viaGit = gitUnified(beforeText, afterText, lbl)
  const result = viaGit ?? fallbackUnified(beforeText, afterText, lbl)
  // 行数保护
  const lines = result.text.split("\n")
  if (lines.length > MAX_OUTPUT_LINES) {
    result.text = lines.slice(0, MAX_OUTPUT_LINES).join("\n")
    result.note = `${result.note ? result.note + "；" : ""}diff 过长，仅展示前 ${MAX_OUTPUT_LINES} 行`
  }
  return result
}

function gitUnified(beforeText, afterText, lbl) {
  let dir = null
  try {
    dir = mkdtempSync(join(tmpdir(), "tcw-diff-"))
    const beforeFile = join(dir, "before")
    const afterFile = join(dir, "after")
    writeFileSync(beforeFile, beforeText, "utf8")
    writeFileSync(afterFile, afterText, "utf8")

    let raw = ""
    try {
      raw = execFileSync("git", ["diff", "--no-index", "--no-color", `-U${CONTEXT}`, "--", beforeFile, afterFile], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        cwd: dir,
      })
      // exit 0 = 无差异
    } catch (err) {
      if (err?.status === 1 && typeof err.stdout === "string") raw = err.stdout // exit 1 = 有差异
      else return null // git 不可用或其他错误 → 回退
    }

    // 规范化头部：临时路径 → 展示路径；去掉 diff --git / index / no-newline 标记
    const out = []
    let added = 0
    let removed = 0
    for (const line of raw.split("\n")) {
      if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("\\ ")) continue
      if (line.startsWith("--- ")) { out.push(`--- a/${lbl}`); continue }
      if (line.startsWith("+++ ")) { out.push(`+++ b/${lbl}`); continue }
      if (line.startsWith("+") && !line.startsWith("+++")) added++
      if (line.startsWith("-") && !line.startsWith("---")) removed++
      out.push(line)
    }
    return { format: "unified", label: lbl, text: out.join("\n").replace(/\n+$/, ""), added, removed, tooLarge: false, engine: "git" }
  } catch {
    return null
  } finally {
    if (dir) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录清理失败无碍 */ }
    }
  }
}

/** 回退：公共前后缀剥离 + 单 hunk（git 不可用时保底） */
function fallbackUnified(beforeText, afterText, lbl) {
  const a = beforeText === "" ? [] : beforeText.split("\n")
  const b = afterText === "" ? [] : afterText.split("\n")

  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++

  const oldMid = a.slice(p, a.length - s)
  const newMid = b.slice(p, b.length - s)
  if (oldMid.length === 0 && newMid.length === 0) {
    return { format: "unified", label: lbl, text: "", added: 0, removed: 0, tooLarge: false, engine: "fallback" }
  }

  const ctxBefore = a.slice(Math.max(0, p - CONTEXT), p)
  const ctxAfter = a.slice(a.length - s, a.length - s + Math.min(s, CONTEXT))
  const oldStart = Math.max(0, p - CONTEXT) + 1
  const newStart = Math.max(0, p - CONTEXT) + 1
  const oldCount = ctxBefore.length + oldMid.length + ctxAfter.length
  const newCount = ctxBefore.length + newMid.length + ctxAfter.length

  const lines = [
    `--- a/${lbl}`,
    `+++ b/${lbl}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...ctxBefore.map((l) => ` ${l}`),
    ...oldMid.map((l) => `-${l}`),
    ...newMid.map((l) => `+${l}`),
    ...ctxAfter.map((l) => ` ${l}`),
  ]
  return { format: "unified", label: lbl, text: lines.join("\n"), added: newMid.length, removed: oldMid.length, tooLarge: false, engine: "fallback" }
}
