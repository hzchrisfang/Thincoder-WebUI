import { useMemo, useState } from "react"
import type { DiffInfo } from "../lib/types"

// ---------- unified diff 解析 ----------

interface DLine {
  t: "ctx" | "add" | "del"
  text: string
  oldNo?: number
  newNo?: number
}

interface Hunk {
  header: string
  lines: DLine[]
  /** 所属文件在 labels 中的序号（多文件批量 diff 分段渲染用） */
  file?: number
}

interface Parsed {
  hunks: Hunk[]
  oldLabel: string
  newLabel: string
  overflow: boolean
  /** 多文件 diff（批量编辑）——各文件的展示名，hunk.file 按序索引 */
  labels: string[]
}

const MAX_RENDER_LINES = 1500

function parseUnified(text: string): Parsed {
  const lines = text.split("\n")
  let oldLabel = ""
  let newLabel = ""
  const hunks: Hunk[] = []
  const labels: string[] = [] // 第 n 段 ---/+++ 出现的顺序 = 文件序
  let cur: Hunk | null = null
  let oldNo = 0
  let newNo = 0
  let total = 0
  let overflow = false

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    if (ln === "" && i === lines.length - 1) continue // 文末空行
    if (ln.startsWith("--- ")) {
      oldLabel = ln.slice(4).replace(/^a\//, "")
      if (labels[labels.length - 1] !== oldLabel || hunks.length === 0) labels.push(oldLabel)
      continue
    }
    if (ln.startsWith("+++ ")) {
      newLabel = ln.slice(4).replace(/^b\//, "")
      continue
    }
    if (ln.startsWith("@@")) {
      const m = ln.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      oldNo = m ? Number(m[1]) : 1
      newNo = m ? Number(m[2]) : 1
      cur = { header: ln, lines: [] }
      cur.file = labels.length > 0 ? labels.length - 1 : 0
      hunks.push(cur)
      continue
    }
    if (!cur) continue
    if (++total > MAX_RENDER_LINES) {
      overflow = true
      break
    }
    if (ln.startsWith("+")) cur.lines.push({ t: "add", text: ln.slice(1), newNo: newNo++ })
    else if (ln.startsWith("-")) cur.lines.push({ t: "del", text: ln.slice(1), oldNo: oldNo++ })
    else if (ln.startsWith(" ") || ln === "") cur.lines.push({ t: "ctx", text: ln.startsWith(" ") ? ln.slice(1) : "", oldNo: oldNo++, newNo: newNo++ })
    // 其他行（如 "\ No newline at end of file"）跳过
  }
  return { hunks, oldLabel, newLabel, overflow, labels }
}

// ---------- split 视图行配对 ----------

interface SplitRow {
  left?: DLine
  right?: DLine
}

function toSplit(hunk: Hunk): SplitRow[] {
  const rows: SplitRow[] = []
  let dels: DLine[] = []
  let adds: DLine[] = []
  const flush = () => {
    const n = Math.max(dels.length, adds.length)
    for (let i = 0; i < n; i++) rows.push({ left: dels[i], right: adds[i] })
    dels = []
    adds = []
  }
  for (const l of hunk.lines) {
    if (l.t === "del") dels.push(l)
    else if (l.t === "add") adds.push(l)
    else {
      flush()
      rows.push({ left: l, right: l })
    }
  }
  flush()
  return rows
}

// ---------- 样式 ----------

const lineClass = (t?: "ctx" | "add" | "del") =>
  t === "add"
    ? "bg-emerald-950 text-emerald-200"
    : t === "del"
      ? "bg-red-950 text-red-200"
      : "text-t3"

const numClass = "w-9 shrink-0 select-none pr-1.5 text-right font-mono text-xs leading-5 text-t4"

// ---------- 组件 ----------

export default function DiffViewer({ diff }: { diff: DiffInfo }) {
  const [mode, setMode] = useState<"unified" | "split">("unified")
  const parsed = useMemo(() => parseUnified(diff.text), [diff.text])

  if (diff.tooLarge || !diff.text) {
    return (
      <div className="rounded-xl border border-line bg-surface3 px-3.5 py-2.5 text-xs text-t3">
        {diff.note ?? "未生成 diff"}
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border border-line">
      {/* 头部：文件 + 统计 + 视图切换 */}
      <div className="flex items-center gap-2 border-b border-line bg-surface2 px-3.5 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-t1" title={diff.label}>
          {diff.label}
        </span>
        <span className="shrink-0 font-mono text-xs tabular-nums text-emerald-400">+{diff.added}</span>
        <span className="shrink-0 font-mono text-xs tabular-nums text-red-400">−{diff.removed}</span>
        <div className="seg ml-1 shrink-0">
          <button data-on={mode === "unified"} onClick={() => setMode("unified")}>
            统一
          </button>
          <button data-on={mode === "split"} onClick={() => setMode("split")}>
            并排
          </button>
        </div>
      </div>

      {diff.note && (
        <div className="border-b border-amber-900 bg-amber-950 px-3.5 py-2 text-xs text-amber-300">{diff.note}</div>
      )}

      {/* diff 主体（多文件批量：每个文件一段，段前插文件名分隔条） */}
      <div className="max-h-[42vh] overflow-auto bg-surface3 font-mono text-xs leading-5">
        {parsed.hunks.map((hunk, hi) => {
          const fileChanged = hi === 0 || parsed.hunks[hi - 1].file !== hunk.file
          const fileLabel = hunk.file != null ? parsed.labels[hunk.file] : null
          return (
            <div key={hi}>
              {fileChanged && fileLabel && parsed.labels.length > 1 && (
                <div className="border-y border-line bg-surface2 px-3.5 py-1 font-mono text-xs text-t2" title={fileLabel}>
                  {fileLabel}
                </div>
              )}
              {hi > 0 && !fileChanged && (
                <div className="bg-surface2 px-3.5 py-1 text-center text-xs text-t4">⋯ 未变更区域已折叠 ⋯</div>
              )}
              {mode === "unified" ? <UnifiedHunk hunk={hunk} /> : <SplitHunk hunk={hunk} />}
            </div>
          )
        })}
        {parsed.overflow && (
          <div className="px-3.5 py-1.5 text-xs text-t4">… diff 过长，仅渲染前 {MAX_RENDER_LINES} 行</div>
        )}
        {parsed.hunks.length === 0 && <div className="px-3.5 py-2 text-t4">（无行级差异）</div>}
      </div>
    </div>
  )
}

function UnifiedHunk({ hunk }: { hunk: Hunk }) {
  return (
    <div>
      {hunk.lines.map((l, i) => (
        <div key={i} className={`flex ${lineClass(l.t)}`}>
          <span className={numClass}>{l.oldNo ?? ""}</span>
          <span className={numClass}>{l.newNo ?? ""}</span>
          <span className="w-4 shrink-0 select-none text-center opacity-70">
            {l.t === "add" ? "+" : l.t === "del" ? "−" : ""}
          </span>
          <span className="whitespace-pre pr-3">{l.text || " "}</span>
        </div>
      ))}
    </div>
  )
}

function SplitHunk({ hunk }: { hunk: Hunk }) {
  const rows = useMemo(() => toSplit(hunk), [hunk])
  return (
    <div>
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-2 divide-x divide-line">
          <div className={`flex min-w-0 ${lineClass(r.left?.t === "ctx" ? "ctx" : r.left?.t)}`}>
            <span className={numClass}>{r.left?.oldNo ?? ""}</span>
            <span className="whitespace-pre pr-2">{r.left?.text ?? ""}</span>
          </div>
          <div className={`flex min-w-0 ${lineClass(r.right?.t === "ctx" ? "ctx" : r.right?.t)}`}>
            <span className={numClass}>{r.right?.newNo ?? ""}</span>
            <span className="whitespace-pre pr-2">{r.right?.text ?? ""}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
