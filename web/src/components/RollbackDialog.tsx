import { useEffect, useState } from "react"
import { api, ApiError } from "../lib/api"
import type { RewindFile, RewindPreview, RewindSummary } from "../lib/types"
import Tooltip from "./Tooltip"

interface Props {
  project: string
  rewindId: string
  text: string
  /** 当前待发队列条数：回退会把它们一起作废，需要如实告知 */
  queued: number
  onClose: () => void
  onDone: (summary: RewindSummary, restoreToInput: boolean) => void
}

const GROUPS: { status: RewindFile["status"]; label: string; tone: string }[] = [
  { status: "M", label: "内容将被还原", tone: "text-sky-600" },
  { status: "D", label: "将被恢复", tone: "text-emerald-600" },
  { status: "A", label: "将被删除", tone: "text-red-500" },
]

const UNRECOVERABLE = [
  "被 .gitignore 忽略的文件（如 node_modules、构建产物）",
  "内核记忆库 memory.db（追加写入）",
  "数据库迁移、远端服务、已启动的进程",
]

export default function RollbackDialog({ project, rewindId, text, queued, onClose, onDone }: Props) {
  const [preview, setPreview] = useState<RewindPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [restoreToInput, setRestoreToInput] = useState(true)

  useEffect(() => {
    let alive = true
    api
      .rewindPreview(project, rewindId)
      .then((r) => { if (alive) setPreview(r) })
      .catch((e) => { if (alive) setError(e instanceof ApiError ? e.message : String(e)) })
    return () => { alive = false }
  }, [project, rewindId])

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api.rewind(project, rewindId)
      onDone(r.summary, restoreToInput)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const total = preview?.files.length ?? 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4 backdrop-blur-sm">
      <div className="rise flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-lg">
        <div className="flex items-center gap-2.5 border-b border-line px-5 py-4">
          <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
          <div className="text-sm font-medium text-t1">回退到这条消息之前</div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="rounded-xl border border-line bg-surface2 px-3.5 py-2.5 text-xs leading-relaxed text-t3">
            {text.length > 240 ? text.slice(0, 240) + "…" : text}
          </div>

          <div className="mt-3.5 text-sm leading-relaxed text-t2">
            这条消息及其之后的所有对话会从会话中移除，agent 在此期间做的文件改动会被撤销。
            <span className="text-t4">回退前的状态已自动存档，可在回退后用「撤销回退」还原。</span>
          </div>

          {queued > 0 && (
            <div className="mt-3 rounded-xl border border-amber-900 bg-amber-950 px-3.5 py-2 text-xs leading-relaxed text-amber-300">
              待发队列里的 {queued} 条消息会一并作废（它们基于回退后的状态已不成立）。
            </div>
          )}

          {error && (
            <div className="mt-3 rounded-xl border border-red-900 bg-red-950 px-3.5 py-2 text-xs leading-relaxed text-red-300">
              {error}
            </div>
          )}

          <div className="mt-4">
            <div className="mb-2 text-xs font-medium text-t3">
              {preview ? `将影响的文件（${total}${preview.truncated ? "+" : ""}）` : "正在读取受影响的文件…"}
            </div>
            {preview && total === 0 && (
              <div className="text-xs text-t4">工作区没有需要改动的文件。</div>
            )}
            {preview && total > 0 && (
              <div className="flex flex-col gap-3">
                {GROUPS.map((g) => {
                  const files = preview.files.filter((f) => f.status === g.status)
                  if (files.length === 0) return null
                  return (
                    <div key={g.status}>
                      <div className={`mb-1 text-xs font-medium ${g.tone}`}>
                        {g.label} · {files.length}
                      </div>
                      <div className="max-h-40 overflow-y-auto rounded-xl border border-line bg-surface2 p-2 font-mono text-xs leading-relaxed text-t2">
                        {files.map((f) => (
                          <Tooltip key={f.path} label={f.path} side="top" className="min-w-0 w-full">
                            <div className="min-w-0 w-full truncate">{f.path}</div>
                          </Tooltip>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            {preview?.degraded && (
              <div className="mt-2 text-xs text-amber-500">文件回退不可用：{preview.degraded}（仅对话会回退）</div>
            )}
          </div>

          <div className="mt-4 rounded-xl border border-line px-3.5 py-3">
            <div className="mb-1.5 text-xs font-medium text-t3">此项回退不到</div>
            <ul className="flex flex-col gap-1 text-xs leading-relaxed text-t4">
              {UNRECOVERABLE.map((u) => (
                <li key={u}>· {u}</li>
              ))}
            </ul>
          </div>
        </div>

        <div className="flex items-center gap-3 border-t border-line bg-surface2 px-5 py-3.5">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-t3">
            <input
              type="checkbox"
              checked={restoreToInput}
              onChange={(e) => setRestoreToInput(e.target.checked)}
              className="accent-accent"
            />
            把这条消息放回输入框
          </label>
          <div className="flex-1" />
          <button onClick={onClose} disabled={busy} className="btn-ghost px-4 py-2 text-sm">
            取消
          </button>
          <button onClick={confirm} disabled={busy || !preview} className="btn-primary px-5 py-2 text-sm">
            {busy ? "回退中…" : "确认回退"}
          </button>
        </div>
      </div>
    </div>
  )
}
