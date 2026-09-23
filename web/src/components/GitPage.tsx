import { useCallback, useEffect, useState } from "react"
import { api } from "../lib/api"
import type { CheckpointInfo, CommitInfo, DiffInfo, GitStatus } from "../lib/types"
import DiffViewer from "./DiffViewer"

/** Git 浏览 + 检查点时光机（只读优先，写操作仅检查点回滚） */
export default function GitPage({ project }: { project: string | null }) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [commits, setCommits] = useState<CommitInfo[]>([])
  const [cps, setCps] = useState<CheckpointInfo[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [diffView, setDiffView] = useState<{ path: string; staged: boolean } | null>(null)

  const load = useCallback(() => {
    if (!project) return
    setErr(null)
    Promise.all([api.gitStatus(project), api.gitLog(project), api.checkpoints(project)])
      .then(([s, l, c]) => {
        setStatus(s)
        setCommits(l.commits ?? [])
        setCps(c.checkpoints ?? [])
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [project])

  useEffect(load, [load])

  const createCp = async () => {
    if (!project) return
    setBusy(true)
    try {
      await api.createCheckpoint(project)
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const rewind = async (id: string) => {
    if (!project) return
    if (!window.confirm(`回滚到检查点 ${id}？\n\n回滚会恢复当时的文件状态；回滚前会自动存一个新快照，所以操作可逆。`)) return
    setBusy(true)
    try {
      const r = await api.rewindCheckpoint(project, id)
      window.alert(`回滚完成：恢复未跟踪文件 ${r.summary.restored} 个，删除新增未跟踪文件 ${r.summary.deleted} 个，补丁${r.summary.patchApplied ? "已" : "未"}应用。`)
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!project) return <Center text="请先选择项目" />
  if (status && !status.repo) return <Center text="当前项目不是 git 仓库" />

  const total = (status?.staged?.length ?? 0) + (status?.unstaged?.length ?? 0) + (status?.untracked?.length ?? 0)

  return (
    <div className="mx-auto h-full max-w-4xl overflow-y-auto px-8 py-8">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="flex items-center gap-3 text-xl font-semibold tracking-[-0.01em] text-t1">
            Git
            {status?.repo && (
              <span className="rounded-full bg-surface2 px-2.5 py-1 font-sans text-xs font-normal text-t3">
                ⎇ {status.branch}
                {(status.ahead ?? 0) > 0 && <span className="ml-1 text-emerald-400">↑{status.ahead}</span>}
                {(status.behind ?? 0) > 0 && <span className="ml-1 text-red-400">↓{status.behind}</span>}
              </span>
            )}
          </h1>
          <p className="mt-1 text-xs text-t4">工作区状态 · 检查点时光机 · 提交历史</p>
        </div>
        <button onClick={load} className="btn-ghost px-3.5 py-1.5 text-xs">
          刷新
        </button>
      </div>

      {err && <div className="mb-4 rounded-xl border border-red-900 bg-red-950 px-3.5 py-2.5 text-xs text-red-300">{err}</div>}
      {!status && !err && <div className="py-12 text-center text-sm text-t4">加载中…</div>}

      {status?.repo && (
        <>
          {/* 工作区状态 */}
          <SectionTitle>工作区（{total} 个变更）</SectionTitle>
          {total === 0 ? (
            <EmptyBox text="工作区干净" />
          ) : (
            <div className="mb-7 overflow-hidden rounded-xl border border-line">
              <FileGroup label="已暂存" files={status.staged ?? []} onOpen={(path) => setDiffView({ path, staged: true })} tone="emerald" />
              <FileGroup label="未暂存" files={status.unstaged ?? []} onOpen={(path) => setDiffView({ path, staged: false })} tone="amber" />
              <FileGroup
                label="未跟踪"
                files={(status.untracked ?? []).map((p) => ({ path: p }))}
                onOpen={() => window.alert("未跟踪文件没有 git 差异可展示（尚未纳入版本管理）")}
                tone="zinc"
              />
            </div>
          )}

          {/* 检查点 */}
          <div className="mb-2.5 flex items-end justify-between">
            <SectionTitle className="mb-0">检查点（时光机）</SectionTitle>
            <button onClick={createCp} disabled={busy} className="btn-primary px-3.5 py-1.5 text-xs">
              {busy ? "处理中…" : "＋ 打快照"}
            </button>
          </div>
          {cps.length === 0 ? (
            <EmptyBox text="暂无快照。agent 改动文件前会自动打快照；也可以手动打一个。" />
          ) : (
            <div className="mb-7 flex flex-col gap-2">
              {cps.map((cp) => (
                <div key={cp.id} className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <span className="font-mono text-xs text-t1">{cp.id}</span>
                    <span className="ml-2.5 text-xs text-t4">
                      {new Date(cp.time).toLocaleString()} · 未跟踪 {cp.untracked}
                    </span>
                  </div>
                  <button
                    onClick={() => rewind(cp.id)}
                    disabled={busy}
                    className="shrink-0 rounded-lg border border-red-900 px-3 py-1 text-xs text-red-300 transition-colors hover:bg-red-950 disabled:opacity-40"
                  >
                    回滚
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* 提交历史 */}
          <SectionTitle>提交历史</SectionTitle>
          {commits.length === 0 ? (
            <EmptyBox text="暂无提交" />
          ) : (
            <div className="overflow-hidden rounded-xl border border-line">
              {commits.map((c) => (
                <div
                  key={c.hash}
                  className="flex items-center gap-3 border-t border-line px-4 py-2.5 transition-colors first:border-t-0 hover:bg-hover/60"
                >
                  <span className="shrink-0 font-mono text-xs text-accent">{c.short}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-t2" title={c.subject}>
                    {c.subject}
                  </span>
                  <span className="shrink-0 text-xs text-t4">{c.author}</span>
                  <span className="shrink-0 text-xs tabular-nums text-t4">
                    {c.date.slice(0, 16).replace("T", " ")}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {diffView && project && <DiffModal project={project} path={diffView.path} staged={diffView.staged} onClose={() => setDiffView(null)} />}
    </div>
  )
}

function SectionTitle({ children, className = "mb-2.5" }: { children: React.ReactNode; className?: string }) {
  return <h2 className={`text-xs font-medium uppercase tracking-wider text-t3 ${className}`}>{children}</h2>
}

function EmptyBox({ text }: { text: string }) {
  return <div className="mb-7 rounded-xl border border-line px-3.5 py-4 text-center text-xs text-t4">{text}</div>
}

function FileGroup({
  label,
  files,
  onOpen,
  tone,
}: {
  label: string
  files: { path: string; code?: string }[]
  onOpen: (path: string) => void
  tone: "emerald" | "amber" | "zinc"
}) {
  if (files.length === 0) return null
  const toneCls = tone === "emerald" ? "text-emerald-400" : tone === "amber" ? "text-accent" : "text-t4"
  return (
    <div className="border-t border-line first:border-t-0">
      <div className={`bg-surface2 px-4 py-1.5 text-xs font-medium uppercase tracking-wider ${toneCls}`}>
        {label}（{files.length}）
      </div>
      {files.map((f) => (
        <button
          key={`${label}:${f.path}`}
          onClick={() => onOpen(f.path)}
          className="flex w-full items-center gap-2.5 px-4 py-2 text-left font-mono text-xs text-t2 transition-colors hover:bg-hover/60"
          title="查看 diff"
        >
          {f.code && <span className={`w-4 shrink-0 text-center ${toneCls}`}>{f.code}</span>}
          <span className="truncate">{f.path}</span>
        </button>
      ))}
    </div>
  )
}

function DiffModal({ project, path, staged, onClose }: { project: string; path: string; staged: boolean; onClose: () => void }) {
  const [diff, setDiff] = useState<DiffInfo | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    api
      .gitDiff(project, path, staged)
      .then((r) => {
        if (r.note || !r.text) {
          setNote(r.note ?? "无差异")
          return
        }
        // 统计增删行（跳过 ---/+++ 头）
        let added = 0
        let removed = 0
        for (const ln of r.text.split("\n")) {
          if (ln.startsWith("+") && !ln.startsWith("+++")) added++
          else if (ln.startsWith("-") && !ln.startsWith("---")) removed++
        }
        setDiff({ format: "unified", label: path, text: r.text, added, removed, tooLarge: false, engine: "git" })
      })
      .catch((e) => setNote(e instanceof Error ? e.message : String(e)))
  }, [project, path, staged])

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-scrim p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="rise w-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2.5 flex items-center justify-between rounded-xl border border-line bg-surface px-4 py-3 shadow-sm">
          <div className="min-w-0 truncate font-mono text-sm text-t1">
            {staged ? "暂存区 · " : ""}
            {path}
          </div>
          <button
            onClick={onClose}
            className="ml-3 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-t4 transition-colors hover:bg-hover hover:text-t1"
          >
            ✕
          </button>
        </div>
        {note && <div className="rounded-xl border border-line bg-surface px-4 py-3 text-xs text-t3">{note}</div>}
        {diff && <DiffViewer diff={diff} />}
      </div>
    </div>
  )
}

function Center({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center text-sm text-t4">{text}</div>
}
