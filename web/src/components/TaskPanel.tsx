interface Props {
  tasks: { title: string; status: string }[]
  onClose: () => void
}

const MARK: Record<string, { icon: string; cls: string }> = {
  done: { icon: "✓", cls: "text-emerald-400" },
  in_progress: { icon: "▶", cls: "text-accent" },
  pending: { icon: "○", cls: "text-t4" },
}

/** 任务面板（右侧检查器）——由内核 task 工具驱动 */
export default function TaskPanel({ tasks, onClose }: Props) {
  const done = tasks.filter((t) => t.status === "done").length
  const pct = tasks.length ? (done / tasks.length) * 100 : 0

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-line bg-surface2">
      <div className="flex items-center justify-between px-4 py-3.5">
        <div className="text-xs font-medium tracking-wide text-t2">
          任务
          {tasks.length > 0 && (
            <span className="ml-1.5 tabular-nums text-t4">
              {done}/{tasks.length}
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded-lg text-t4 transition-colors hover:bg-hover hover:text-t1"
        >
          ✕
        </button>
      </div>

      {/* 进度条 */}
      {tasks.length > 0 && (
        <div className="mx-4 mb-3 h-1 overflow-hidden rounded-full bg-surface3">
          <div className="h-1 rounded-full bg-accent transition-all duration-300" style={{ width: `${pct}%` }} />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
        {tasks.length === 0 ? (
          <div className="px-2 py-10 text-center text-xs leading-relaxed text-t4">
            暂无任务。
            <br />
            多步工作时，agent 会用 task 工具
            <br />
            拆解并在这里实时展示进度。
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {tasks.map((t, i) => {
              const m = MARK[t.status] ?? MARK.pending
              return (
                <li key={i} className="flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-xs transition-colors hover:bg-hover">
                  <span className={`mt-px w-3.5 shrink-0 text-center text-xs ${m.cls}`}>{m.icon}</span>
                  <span className={t.status === "done" ? "text-t4 line-through decoration-line2" : "text-t2"}>
                    {t.title}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </aside>
  )
}
