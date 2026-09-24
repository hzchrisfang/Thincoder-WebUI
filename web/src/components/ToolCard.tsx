import type { ToolCardData } from "../lib/types"
import Tooltip from "./Tooltip"

/** 按工具名生成一行摘要（对齐 bin 的 formatPermission 风格） */
export function argSummary(name: string, args: Record<string, unknown>): string {
  const base = /[\\/]/.test(name) ? name.split(/[\\/]/).pop()! : name
  const s = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "")
  switch (base) {
    case "bash":
      return s("command")
    case "write":
      return `${s("path")}（${s("content").length} 字符）`
    case "edit":
      return s("path")
    case "delete":
      return s("path")
    case "read":
      return s("path")
    case "glob":
      return s("pattern")
    case "grep":
      return s("pattern")
    case "ls":
      return s("path") || "."
    case "fetch":
      return s("url")
    case "subagent":
      return s("task")
    case "memory_put":
      return `[${s("type")}] ${s("title")}`
    default: {
      try {
        const j = JSON.stringify(args)
        return j.length > 120 ? j.slice(0, 120) + "…" : j
      } catch {
        return ""
      }
    }
  }
}

/** 工具卡片：Claude 风格 —— 单行折叠条，展开后才是细节 */
export default function ToolCard({ tool }: { tool: ToolCardData }) {
  const summary = argSummary(tool.name, tool.args)
  const badge =
    tool.state === "running" ? (
      <span className="spinner" />
    ) : tool.state === "ok" ? (
      <span className="text-[13px] leading-none text-emerald-400">✓</span>
    ) : (
      <span className="text-[13px] leading-none text-red-400">✗</span>
    )

  return (
    <details className="rise group ml-9 overflow-hidden rounded-xl border border-line bg-surface2/70 text-xs transition-colors open:bg-surface">
      <summary className="flex cursor-pointer select-none items-center gap-2.5 px-3.5 py-2.5">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">{badge}</span>
        <span className="shrink-0 font-mono text-xs font-medium text-accent">{tool.name}</span>
        <Tooltip label={summary} side="top" className="min-w-0 flex-1">
          <span className="min-w-0 w-full block truncate font-mono text-xs text-t4">{summary}</span>
        </Tooltip>
        {tool.truncated && (
          <span className="shrink-0 rounded-full bg-surface3 px-2 py-0.5 text-xs text-t4">
            已截断 {tool.fullLength?.toLocaleString()}
          </span>
        )}
        <span className="shrink-0 text-xs text-t4 transition-transform group-open:rotate-90">▸</span>
      </summary>

      <div className="flex flex-col gap-3 border-t border-line px-3.5 py-3">
        {Object.keys(tool.args).length > 0 && (
          <div>
            <div className="mb-1.5 text-xs uppercase tracking-wider text-t4">参数</div>
            <pre className="max-h-64 overflow-auto rounded-lg bg-surface3 p-3 font-mono text-xs leading-relaxed text-t3">
              {prettyArgs(tool.args)}
            </pre>
          </div>
        )}
        {tool.output && (
          <div>
            <div className="mb-1.5 text-xs uppercase tracking-wider text-t4">实时输出</div>
            <pre className="max-h-56 overflow-auto rounded-lg bg-surface3 p-3 font-mono text-xs leading-relaxed text-t2">
              {tool.output}
            </pre>
          </div>
        )}
        {tool.preview != null && (
          <div>
            <div className="mb-1.5 text-xs uppercase tracking-wider text-t4">
              {tool.state === "error" ? "错误" : "结果"}
            </div>
            <pre
              className={`max-h-56 overflow-auto rounded-lg bg-surface3 p-3 font-mono text-xs leading-relaxed ${
                tool.state === "error" ? "text-red-300" : "text-t2"
              }`}
            >
              {tool.preview}
            </pre>
          </div>
        )}
      </div>
    </details>
  )
}

function prettyArgs(args: Record<string, unknown>): string {
  const clone = { ...args }
  for (const k of ["content", "old_string", "new_string"]) {
    if (typeof clone[k] === "string" && (clone[k] as string).length > 1200) {
      clone[k] = (clone[k] as string).slice(0, 1200) + `\n…（共 ${(clone[k] as string).length} 字符）`
    }
  }
  try {
    return JSON.stringify(clone, null, 2)
  } catch {
    return String(args)
  }
}
