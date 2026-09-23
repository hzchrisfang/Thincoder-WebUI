import { useEffect, useState } from "react"
import { api } from "../lib/api"
import type { SessionListInfo } from "../lib/types"

interface Props {
  project: string
  running: boolean
  onClose: () => void
  onNew: () => void
  onSwitch: (slot: number) => void
  onArchive: () => void
}

/** 会话管理面板 —— 当前会话 + 5 个归档槽位（内核按项目目录隔离） */
export default function SessionPanel({ project, running, onClose, onNew, onSwitch, onArchive }: Props) {
  const [info, setInfo] = useState<SessionListInfo | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api
      .sessions(project)
      .then(setInfo)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [project])

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-scrim p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="rise w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-surface shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="text-sm font-medium text-t1">会话管理</div>
          <button
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded-lg text-t4 transition-colors hover:bg-hover hover:text-t1"
          >
            ✕
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-5 py-4">
          {err && <div className="mb-3 rounded-xl border border-red-900 bg-red-950 px-3.5 py-2.5 text-xs text-red-300">{err}</div>}
          {!info && !err && <div className="py-8 text-center text-xs text-t4">加载中…</div>}

          {info && (
            <>
              {/* 当前会话 */}
              <div className="mb-5">
                <Label>当前会话</Label>
                <div className="flex items-center gap-3 rounded-xl border border-amber-900 bg-amber-950 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-t1">{info.current.preview || "（空会话）"}</div>
                    <div className="mt-0.5 text-xs text-t4">
                      {info.current.msgs} 条消息
                      {info.current.updatedAt ? ` · ${new Date(info.current.updatedAt).toLocaleString()}` : ""}
                    </div>
                  </div>
                  <button
                    onClick={onArchive}
                    disabled={running || info.current.msgs === 0}
                    title="把当前会话复制一份到归档槽位（保留现场）"
                    className="btn-ghost shrink-0 px-3 py-1.5 text-xs"
                  >
                    存档
                  </button>
                </div>
              </div>

              {/* 归档槽位 */}
              <div className="mb-5">
                <Label>归档（{info.slots.length}/5，切换会自动先归档当前会话）</Label>
                {info.slots.length === 0 ? (
                  <div className="rounded-xl border border-line px-4 py-3.5 text-xs text-t4">暂无归档会话</div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {info.slots.map((s) => (
                      <div key={s.slot} className="flex items-center gap-3 rounded-xl border border-line bg-surface2 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm text-t2">{s.preview || "（空会话）"}</div>
                          <div className="mt-0.5 text-xs text-t4">
                            #{s.slot} · {s.msgs} 条消息 · {s.date}
                          </div>
                        </div>
                        <button onClick={() => onSwitch(s.slot)} disabled={running} className="btn-ghost shrink-0 px-3 py-1.5 text-xs">
                          恢复
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 新建 */}
              <button onClick={onNew} disabled={running} className="btn-primary w-full py-2.5 text-sm">
                新建会话（当前会话自动归档）
              </button>
              {running && <div className="mt-2 text-center text-xs text-t4">运行中：会话操作被锁定</div>}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 text-xs font-medium uppercase tracking-wider text-t4">{children}</div>
}
