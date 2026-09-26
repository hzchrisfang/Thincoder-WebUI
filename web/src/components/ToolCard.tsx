import { useState } from "react"
import { api } from "../lib/api"
import type { ToolCardData } from "../lib/types"

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
    case "consult_start":
      return s("problem")
    case "consult_stop":
      return `#${s("id")}`
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

/** consult_start 的 ack（内核返回的就是一段 JSON 文本：`{"id":"1","models":["provider:model",…]}`）。
 *  解析不出/形态不符（如未配置时返回的 `Consultation is not configured — …` 错误文本）→ null：
 *  卡片照旧只显示结果文本，不造假的模型 chip、也不出「停止」按钮。 */
function consultAck(preview?: string | null): { id: string; models: string[] } | null {
  const text = (preview ?? "").trim()
  if (!text.startsWith("{")) return null
  try {
    const o = JSON.parse(text) as { id?: unknown; models?: unknown }
    if (!o || typeof o !== "object") return null
    const id = o.id == null ? "" : String(o.id)
    if (!id) return null
    return { id, models: Array.isArray(o.models) ? o.models.map(String) : [] }
  } catch {
    return null
  }
}

/** 工具卡片：Claude 风格 —— 单行折叠条，展开后才是细节 */
export default function ToolCard({ tool, project = null }: { tool: ToolCardData; project?: string | null }) {
  const summary = argSummary(tool.name, tool.args)
  // 多模型会诊：consult_start 的结果 ack 给出会诊 id 与参与模型 —— 据此呈现模型 chip 与「停止」。
  // 判据求简：只有「结果是一份带 id 的 ack」才多出这两样东西，不引入状态机。
  const ack = tool.name === "consult_start" ? consultAck(tool.preview) : null
  const [stop, setStop] = useState<{ state: "idle" | "busy" | "done"; note: string }>({ state: "idle", note: "" })
  const badge =
    tool.state === "running" ? (
      <span className="spinner" />
    ) : tool.state === "ok" ? (
      <span className="text-[13px] leading-none text-emerald-400">✓</span>
    ) : (
      <span className="text-[13px] leading-none text-red-400">✗</span>
    )

  /** 停止这次会诊（内核 consult_stop 的 WebUI 等价面）。已结束/未知的 id 也回 200，只是响应体带
   *  `error: "unknown consult id"` —— 按它提示「会话已结束」并置灰，不造新错误码语义。 */
  const stopConsult = async () => {
    if (!project || !ack || stop.state === "busy") return
    setStop({ state: "busy", note: "" })
    try {
      const r = await api.consultStop(project, ack.id)
      if (r.error) setStop({ state: "done", note: "会话已结束" })
      // 停止的后果必须可见：内核 `stopped` ⇒ **不产 digest**（consult.mjs:153），且工具描述明写
      // 「已收到的部分答复一并丢弃」——用户按了停止会以为「后面会冒出一个 0/N 的裁定块」，
      // 不说明就是误导（顾问会诊指出的可见性缺口）。
      else setStop({ state: "done", note: `已停止（${r.abandoned ?? 0} 个在跑）：本次不产出裁定` })
    } catch (e) {
      // 失败不置灰：409（运行中）/网络错误都可能重试
      setStop({ state: "idle", note: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <details className="rise group ml-9 overflow-hidden rounded-xl border border-line bg-surface2/70 text-xs transition-colors open:bg-surface">
      <summary className="flex cursor-pointer select-none items-center gap-2.5 px-3.5 py-2.5">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">{badge}</span>
        <span className="shrink-0 font-mono text-xs font-medium text-accent">{tool.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-t4">{summary}</span>
        {ack && ack.models.length > 0 && (
          <span className="shrink-0 rounded-full bg-surface3 px-2 py-0.5 text-xs text-t3">
            {ack.models.length} 个模型
          </span>
        )}
        {ack && project && (
          <button
            onClick={(e) => {
              e.preventDefault() // 折叠条的 summary：不阻止会把点击当成展开/收起
              void stopConsult()
            }}
            disabled={stop.state !== "idle"}
            className="shrink-0 rounded-lg border border-line px-2 py-0.5 text-xs text-t2 transition-colors hover:bg-hover hover:text-t1 disabled:cursor-default disabled:opacity-50"
          >
            {stop.state === "busy" ? "停止中…" : "停止会诊"}
          </button>
        )}
        {stop.state === "done" && (
          <span className="shrink-0 text-xs text-t4" title="内核语义：被停止的会诊不产出裁定，已收到的部分答复一并丢弃">
            {stop.note}
          </span>
        )}
        {stop.state === "idle" && stop.note && <span className="shrink-0 text-xs text-red-300">{stop.note}</span>}
        {tool.truncated && (
          <span className="shrink-0 rounded-full bg-surface3 px-2 py-0.5 text-xs text-t4">
            已截断 {tool.fullLength?.toLocaleString()}
          </span>
        )}
        <span className="shrink-0 text-xs text-t4 transition-transform group-open:rotate-90">▸</span>
      </summary>

      <div className="flex flex-col gap-3 border-t border-line px-3.5 py-3">
        {ack && ack.models.length > 0 && (
          <div>
            <div className="mb-1.5 text-xs uppercase tracking-wider text-t4">参与模型会诊 #{ack.id}</div>
            <div className="flex flex-wrap gap-1.5">
              {ack.models.map((m) => (
                <span key={m} className="rounded-full bg-surface3 px-2.5 py-1 font-mono text-xs text-t2">
                  {m}
                </span>
              ))}
            </div>
          </div>
        )}
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
