import { useEffect, useState } from "react"
import { api, ApiError } from "../lib/api"
import Tooltip from "./Tooltip"

interface Props {
  /** dir = 选项目目录（添加项目）；file = 选文件（输入框插入绝对路径）。缺省 dir，兼容旧用法 */
  mode?: "dir" | "file"
  onClose: () => void
  /** 选中：dir 模式返回目录路径，file 模式返回文件路径（均为绝对路径） */
  onPick: (path: string) => void
}

interface FsEntry {
  name: string
  isDir?: boolean
}

/** base + 子目录名 → 绝对路径（兼容根目录 "/" 的尾斜杠） */
const joinPath = (base: string, name: string) => (base.endsWith("/") ? base + name : `${base}/${name}`)

function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0 text-t4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3l1.5 1.5H13a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 13 12.5H3A1.5 1.5 0 0 1 1.5 11z" />
    </svg>
  )
}

function FileIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0 text-t4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 1.5h5L13 5.5v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1z" />
      <path d="M9 1.5V6h4" />
    </svg>
  )
}

/** 目录浏览弹窗：逐级进入子目录——dir 模式选中当前目录作为项目路径；file 模式点击文件即选中该文件 */
export default function DirPicker({ mode = "dir", onClose, onPick }: Props) {
  const [dir, setDir] = useState<string | null>(null)
  const [parent, setParent] = useState<string | null>(null)
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const isFile = mode === "file"

  const open = (target?: string) => {
    setLoading(true)
    setError(null)
    api
      .fsList(target, isFile)
      .then((r) => {
        setDir(r.dir)
        setParent(r.parent)
        setEntries(r.entries)
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : String(e)))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    open()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const clickEntry = (e: FsEntry) => {
    if (loading || !dir) return
    const path = joinPath(dir, e.name)
    // 文件条目直接选中（仅 file 模式会出现）；目录条目进入下一级
    if (e.isDir === false) onPick(path)
    else open(path)
  }

  const title = isFile ? "选择文件" : "选择项目目录"

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="rise flex max-h-[80vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-line px-5 py-4">
          <span className="inline-block h-2 w-2 rounded-full bg-accent" />
          <div className="text-sm font-medium text-t1">{title}</div>
        </div>

        {/* 当前路径 + 上一级 */}
        <div className="flex items-center gap-2 border-b border-line px-5 py-2.5">
          <Tooltip label="上一级" side="bottom">
            <button
              onClick={() => parent && open(parent)}
              disabled={!parent || loading}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-t3 transition-colors hover:bg-hover hover:text-t1 disabled:opacity-30"
            >
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 4 6 8l4 4" />
              </svg>
            </button>
          </Tooltip>
          <Tooltip label={dir ?? undefined} side="bottom" className="min-w-0 flex-1">
            <div className="min-w-0 w-full truncate font-mono text-xs text-t2">
              {dir ?? "…"}
            </div>
          </Tooltip>
        </div>

        {/* 目录 / 文件列表 */}
        <div className="min-h-40 flex-1 overflow-y-auto px-2.5 py-2">
          {error && (
            <div className="mx-2.5 my-1.5 rounded-xl border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-300">{error}</div>
          )}
          {loading && !error && <div className="px-2.5 py-2 text-xs text-t4">加载中…</div>}
          {!loading && !error && entries.length === 0 && (
            <div className="px-2.5 py-2 text-xs text-t4">{isFile ? "（空目录）" : "（没有子目录）"}</div>
          )}
          {!error &&
            entries.map((e) => (
              <button
                key={e.name}
                onClick={() => clickEntry(e)}
                disabled={loading}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-hover disabled:opacity-50"
              >
                {e.isDir === false ? <FileIcon /> : <FolderIcon />}
                <span className={`truncate text-xs ${e.isDir === false ? "text-t1" : "text-t2"}`}>{e.name}</span>
              </button>
            ))}
        </div>

        <div className="flex items-center gap-3 border-t border-line bg-surface2 px-5 py-3.5">
          <div className="min-w-0 flex-1 text-xs text-t4">
            {isFile ? "点击列表中的文件即插入其绝对路径；目录逐级进入" : "选中当前所在目录作为项目路径"}
          </div>
          <button onClick={onClose} className="btn-ghost px-4 py-2 text-sm">
            取消
          </button>
          {!isFile && (
            <button onClick={() => dir && onPick(dir)} disabled={!dir || loading} className="btn-primary px-5 py-2 text-sm">
              添加此目录
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
