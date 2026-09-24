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

/** 可切换的位置（盘符 / 挂载卷 / 根），服务端 GET /api/fs/roots */
interface FsRoot {
  name: string
  path: string
  kind: string
}

/** 这条路径是不是 Windows 形态（盘符或 UNC 前缀）——全文件唯一判据 */
const isWinPath = (p: string) => /^[a-zA-Z]:/.test(p) || p.startsWith("\\\\")

/** base + 子目录名 → 绝对路径：分隔符按 base 的形态选
 *  （win32 下服务端回的是反斜杠 realpath，含 `C:\` 这样的盘根；只认 `/` 会拼出混合分隔符）
 *  判据用 isWinPath 而**不是**「里面有反斜杠」：POSIX 目录名里可以字面含 `\`（如 /tmp/a\bar），
 *  按「有反斜杠就当分隔符」会把这种名字下的子路径拼错（服务端 400「目录不存在」） */
const joinPath = (base: string, name: string) => {
  const sep = isWinPath(base) ? "\\" : "/"
  return base.endsWith(sep) ? base + name : base + sep + name
}

/** 路径归一（分隔符 / 大小写无关）：win32 下 `C:\` 与 `c:/` 是同一位置；POSIX 保持大小写敏感 */
const normPath = (p: string) => {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "")
  const out = s === "" ? "/" : s
  return isWinPath(p) ? out.toLowerCase() : out
}

/** 同一位置判定（当前目录是否就是该位置——下拉里的 ✓ 与高亮） */
const samePath = (a: string, b: string) => normPath(a) === normPath(b)

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
  const [roots, setRoots] = useState<FsRoot[]>([])
  const [menuOpen, setMenuOpen] = useState(false)
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
    // 位置清单：老服务端（无此接口）或请求失败时静默降级为空——「位置」按钮不渲染，弹窗行为与从前一致
    api
      .fsRoots()
      .then((r) => setRoots(Array.isArray(r.roots) ? r.roots : []))
      .catch(() => setRoots([]))
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
        className="rise flex max-h-[80vh] w-full max-w-xl flex-col rounded-2xl border border-line bg-surface shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 rounded-t-2xl border-b border-line px-5 py-4">
          <span className="inline-block h-2 w-2 rounded-full bg-accent" />
          <div className="text-sm font-medium text-t1">{title}</div>
        </div>

        {/* 当前路径 + 上一级 + 位置切换（win32 上 C:\ 即到顶，没有它能切到别的盘） */}
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
          {roots.length > 0 && (
            <div className="relative shrink-0">
              <Tooltip label="切换到其他磁盘 / 根目录" side="bottom">
                <button
                  onClick={() => setMenuOpen((v) => !v)}
                  className="flex h-6 items-center gap-1 rounded px-2 text-xs text-t3 transition-colors hover:bg-hover hover:text-t1"
                >
                  位置
                  <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 6l4 4 4-4" />
                  </svg>
                </button>
              </Tooltip>
              {menuOpen && (
                <>
                  {/* 点击捕手：只关本菜单（冒泡到卡片那层的 stopPropagation，不会误关弹窗） */}
                  <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                  <div className="absolute right-0 top-full z-50 mt-1.5 w-64 overflow-hidden rounded-xl border border-line bg-surface shadow-lg">
                    <div className="border-b border-line px-3.5 py-2 text-xs text-t4">切换位置</div>
                    {/* 盘符多时在内部滚动；高度上限同时受视口约束——菜单自路径栏下沿起挂，
                        取 min(16rem,40vh) 能保证「菜单下沿 ≤ 视口底部」（视口高 ≥ ~200px 时成立），
                        否则矮窗口下末尾条目会掉到窗口外且滚不到（卡片已不设 overflow-hidden，
                        能越出卡片下沿，但越不出窗口） */}
                    <div className="max-h-[min(16rem,40vh)] overflow-y-auto">
                      {roots.map((r) => {
                        const active = dir !== null && samePath(dir, r.path)
                        return (
                          <button
                            key={r.path}
                            onClick={() => {
                              setMenuOpen(false)
                              open(r.path)
                            }}
                            className={`flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs transition-colors hover:bg-hover ${
                              active ? "text-accent" : "text-t2"
                            }`}
                          >
                            <span className={`w-3.5 shrink-0 ${active ? "" : "invisible"}`}>✓</span>
                            <span className="shrink-0 font-medium">{r.name}</span>
                            <span className="min-w-0 truncate font-mono text-t4">{r.path}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
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

        <div className="flex items-center gap-3 rounded-b-2xl border-t border-line bg-surface2 px-5 py-3.5">
          <div className="min-w-0 flex-1 text-xs text-t4">
            {isFile ? "点击列表中的文件即插入其绝对路径；目录逐级进入" : "选中当前所在目录作为项目路径（「位置」可切换磁盘）"}
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
