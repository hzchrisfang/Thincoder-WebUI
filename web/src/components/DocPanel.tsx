import { useEffect, useMemo, useState } from "react"
import { marked } from "marked"
import { api } from "../lib/api"
import Tooltip from "./Tooltip"

marked.setOptions({ gfm: true, breaks: true })

interface Props {
  project: string | null
  /** 从时间线收集到的候选文件（工具调用的 write/edit/read 目标） */
  files: string[]
  onClose: () => void
}

type PreviewKind = "image" | "web" | "md" | "code"

/** 代码类扩展名（纯文本高亮只对 JS/TS 家族做区分标注，其余代码文件同走只读文本预览） */
const CODE_EXTS = [
  "js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts", // JS/TS 家族
  "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cs",
  "php", "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", // 脚本
  "css", "scss", "less", "json", "jsonc", "yml", "yaml", "toml", "ini", "cfg",
  "sql", "xml", "vue", "svelte", "astro", "dart", "lua", "r", "m", "mm",
  "gradle", "properties", "env", "lock",
]

const ext = (p: string) => (p.split(".").pop() ?? "").toLowerCase()
const kindOf = (p: string): PreviewKind | null => {
  const e = ext(p)
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"].includes(e)) return "image"
  if (e === "html" || e === "htm") return "web"
  if (["md", "markdown", "mdx"].includes(e)) return "md"
  if (CODE_EXTS.includes(e)) return "code"
  return null
}
/** 只保留适合预览的文件类型（图片 / 网页 / Markdown / 代码文本） */
export const isPreviewable = (p: string) => kindOf(p) !== null

const KIND_LABEL: Record<PreviewKind, string> = { image: "图片", web: "网页", md: "Markdown", code: "代码" }

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p

/** 右侧面板：文档预览（图片 / 网页沙盒 / Markdown 渲染） */
export default function DocPanel({ project, files, onClose }: Props) {
  const [path, setPath] = useState<string | null>(null)
  const [text, setText] = useState<string>("")
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [showPicker, setShowPicker] = useState(false)

  const uniq = useMemo(() => Array.from(new Set(files.filter(isPreviewable))).slice(-40), [files])

  // 默认选中最新的候选文件
  useEffect(() => {
    if (!path && uniq.length > 0) setPath(uniq[uniq.length - 1])
  }, [uniq, path])

  const kind = path ? kindOf(path) : null

  // Markdown / 代码文本走 JSON 读取；图片与网页由 <img>/<iframe> 引 raw 流，无需手动拉取
  useEffect(() => {
    if (!path || !project || (kind !== "md" && kind !== "code")) {
      setText("")
      return
    }
    setLoading(true)
    setErr(null)
    api
      .readFile(project, path)
      .then((r) => setText(r.text))
      .catch((e) => {
        setErr(e instanceof Error ? e.message : String(e))
        setText("")
      })
      .finally(() => setLoading(false))
  }, [path, kind, project])

  const html = useMemo(() => {
    if (kind !== "md" || !text) return ""
    try {
      return marked.parse(text, { async: false }) as string
    } catch {
      return ""
    }
  }, [kind, text])

  const rawUrl = path && project && (kind === "image" || kind === "web") ? api.fileRawUrl(project, path) : null

  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l border-line bg-surface2">
      {/* 头部 */}
      <div className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-3.5">
        <span className="text-xs font-semibold tracking-[-0.01em] text-t1">文档预览</span>
        {path && kind && <span className="rounded-full bg-surface3 px-2 py-0.5 text-[11px] text-t4">{KIND_LABEL[kind]}</span>}
        <div className="flex-1" />
        <Tooltip label="选择文件" side="left">
          <button
            onClick={() => setShowPicker((v) => !v)}
            disabled={uniq.length === 0}
            className={`flex h-7 w-7 items-center justify-center rounded-lg text-t3 transition-colors hover:bg-hover hover:text-t1 disabled:opacity-40 ${
              showPicker ? "bg-hover text-t1" : ""
            }`}
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 4.5h10M3 8h10M3 11.5h6" />
            </svg>
          </button>
        </Tooltip>
        <Tooltip label="收起面板" side="left">
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-t4 transition-colors hover:bg-hover hover:text-t1"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 4l4 4-4 4" />
            </svg>
          </button>
        </Tooltip>
      </div>

      {/* 文件选择器 */}
      {showPicker && uniq.length > 0 && (
        <div className="max-h-56 shrink-0 overflow-y-auto border-b border-line bg-surface px-2 py-1.5">
          {uniq
            .slice()
            .reverse()
            .map((f) => (
              <Tooltip key={f} label={f} side="bottom" className="w-full">
                <button
                  onClick={() => {
                    setPath(f)
                    setShowPicker(false)
                  }}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-hover ${
                    f === path ? "bg-accent-soft" : ""
                  }`}
                >
                  <span className={`shrink-0 ${f === path ? "text-accent" : "text-t4"}`}>
                    <FileIcon kind={kindOf(f)} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-t2">{baseName(f)}</span>
                    <span className="block truncate text-xs text-t4">{f}</span>
                  </span>
                </button>
              </Tooltip>
            ))}
        </div>
      )}

      {/* 内容 */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {!path && (
          <div className="px-4 py-14 text-center text-xs leading-relaxed text-t4">
            暂无可预览的文档。
            <br />
            agent 产出图片、网页、Markdown 或代码后可在此预览。
          </div>
        )}

        {path && (
          <>
            <div className="shrink-0 border-b border-line bg-surface2/95 px-3.5 py-2">
              <Tooltip label={path} side="bottom">
                <div className="min-w-0 max-w-full truncate font-mono text-xs text-t3">
                  {path}
                </div>
              </Tooltip>
            </div>

            {kind === "md" && loading && <div className="px-4 py-6 text-center text-xs text-t4">加载中…</div>}
            {kind === "md" && err && (
              <div className="m-3 rounded-xl border border-red-900 bg-red-950 px-3.5 py-2.5 text-xs leading-relaxed text-red-300">
                {err}
              </div>
            )}

            {/* Markdown：渲染阅读视图 */}
            {kind === "md" && !loading && !err && (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <div className="md px-4 py-4 text-t-body" dangerouslySetInnerHTML={{ __html: html }} />
              </div>
            )}

            {/* 代码文本：等宽只读视图（浅色底同主题换肤）；超长文件已由服务端截断读取 */}
            {kind === "code" && loading && <div className="px-4 py-6 text-center text-xs text-t4">加载中…</div>}
            {kind === "code" && err && (
              <div className="m-3 rounded-xl border border-red-900 bg-red-950 px-3.5 py-2.5 text-xs leading-relaxed text-red-300">{err}</div>
            )}
            {kind === "code" && !loading && !err && (
              <pre className="min-h-0 flex-1 overflow-auto bg-surface3 p-3.5 font-mono text-xs leading-5 text-t2 whitespace-pre">
                {text || "（空文件）"}
              </pre>
            )}

            {/* 图片：居中缩放，深浅底都能衬出透明图 */}
            {kind === "image" && rawUrl && (
              <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-surface3 p-4">
                <img
                  src={rawUrl}
                  alt={baseName(path)}
                  className="max-h-full max-w-full rounded-lg object-contain shadow-sm"
                  onError={(e) => {
                    const el = e.currentTarget
                    el.style.display = "none"
                    const next = el.nextElementSibling as HTMLElement | null
                    if (next) next.classList.remove("hidden")
                  }}
                />
                <div className="hidden px-4 py-6 text-center text-xs leading-relaxed text-t4">
                  图片加载失败。
                  <br />
                  可能文件过大或已被移动。
                </div>
              </div>
            )}

            {/* 网页：沙盒 iframe（服务端 CSP sandbox + 前端 sandbox 双保险，脚本禁用） */}
            {kind === "web" && rawUrl && (
              <>
                <div className="shrink-0 px-3.5 pt-2 text-[11px] text-t4">静态预览 —— 脚本与跳转已禁用</div>
                <iframe
                  src={rawUrl}
                  title={baseName(path)}
                  sandbox=""
                  className="mt-2 min-h-0 w-full flex-1 border-0 bg-white"
                />
              </>
            )}
          </>
        )}
      </div>
    </aside>
  )
}

function FileIcon({ kind }: { kind: PreviewKind | null }) {
  if (kind === "image") {
    return (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="3" width="12" height="10" rx="1.5" />
        <circle cx="5.6" cy="6.4" r="1" />
        <path d="M2.5 11.5l3-3 2.5 2.5 2-2 3.5 3" />
      </svg>
    )
  }
  if (kind === "web") {
    return (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
        <path d="M2 5.5h12" />
        <circle cx="4.2" cy="4" r="0.4" fill="currentColor" stroke="none" />
        <circle cx="5.8" cy="4" r="0.4" fill="currentColor" stroke="none" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 2h5l3 3v9H4z" />
      <path d="M9 2v3h3" />
      <path d="M6 9.5h4M6 11.5h3" />
    </svg>
  )
}
