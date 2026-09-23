import { useCallback, useEffect, useState } from "react"
import { api } from "../lib/api"
import type { JobInfo, JobRun } from "../lib/types"

interface Props {
  projects: string[]
  refreshTick: number // App 收到 job 事件时 +1，驱动刷新
}

type ScheduleKind = "every" | "daily" | "weekly"

interface JobForm {
  id?: string
  name: string
  project: string
  prompt: string
  kind: ScheduleKind
  everyMin: number
  time: string
  weekday: number
  maxTurns: number
  enabled: boolean
}

const emptyForm = (project: string): JobForm => ({
  name: "",
  project,
  prompt: "",
  kind: "daily",
  everyMin: 30,
  time: "09:00",
  weekday: 1,
  maxTurns: 30,
  enabled: true,
})

function toForm(job: JobInfo): JobForm {
  const s = job.schedule
  return {
    id: job.id,
    name: job.name,
    project: job.project,
    prompt: job.prompt,
    kind: s.kind as ScheduleKind,
    everyMin: s.kind === "every" ? Math.round((s.everyMs ?? 60000) / 60000) : 30,
    time: s.kind !== "every" ? s.time ?? "09:00" : "09:00",
    weekday: s.kind === "weekly" ? s.weekday ?? 1 : 1,
    maxTurns: job.maxTurns,
    enabled: job.enabled,
  }
}

function toPayload(f: JobForm) {
  const schedule =
    f.kind === "every"
      ? { kind: "every", everyMs: Math.max(1, f.everyMin) * 60000 }
      : f.kind === "daily"
        ? { kind: "daily", time: f.time }
        : { kind: "weekly", weekday: f.weekday, time: f.time }
  return {
    id: f.id,
    name: f.name.trim(),
    project: f.project,
    prompt: f.prompt.trim(),
    schedule,
    maxTurns: f.maxTurns,
    enabled: f.enabled,
  }
}

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  ok: { text: "成功", cls: "text-emerald-400" },
  error: { text: "失败", cls: "text-red-400" },
  paused: { text: "轮数用尽", cls: "text-accent" },
  retried: { text: "重试中", cls: "text-sky-400" },
}

const fmtNext = (ts: number | null) => (ts ? new Date(ts).toLocaleString() : "—")

export default function JobsPage({ projects, refreshTick }: Props) {
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [form, setForm] = useState<JobForm | null>(null)
  const [runsFor, setRunsFor] = useState<JobInfo | null>(null)

  const load = useCallback(() => {
    api
      .jobs()
      .then((r) => setJobs(r.jobs))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [])

  useEffect(load, [load])
  useEffect(() => {
    if (refreshTick > 0) load()
  }, [refreshTick, load])

  const submitForm = async () => {
    if (!form) return
    setErr(null)
    try {
      const payload = toPayload(form)
      if (form.id) await api.updateJob(payload as never)
      else await api.createJob(payload as never)
      setForm(null)
      load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const remove = async (job: JobInfo) => {
    if (!window.confirm(`删除定时任务「${job.name}」？`)) return
    try {
      await api.deleteJob(job.id)
      load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const toggle = async (job: JobInfo) => {
    try {
      await api.updateJob({ id: job.id, name: job.name, project: job.project, prompt: job.prompt, schedule: job.schedule, maxTurns: job.maxTurns, enabled: !job.enabled } as never)
      load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const runNow = async (job: JobInfo) => {
    setErr(null)
    try {
      await api.runJobNow(job.id)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const short = (d: string) => {
    const parts = d.split(/[\\/]/)
    return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : d
  }

  return (
    <div className="mx-auto h-full max-w-4xl overflow-y-auto px-8 py-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-[-0.01em] text-t1">定时任务</h1>
          <p className="mt-1.5 max-w-xl text-xs leading-relaxed text-t4">
            无人值守执行，固定 Full Auto + 轮数上限；瞬态错误（超时/429/5xx）30s 后自动重试一次。隔离运行，不影响交互会话。
          </p>
        </div>
        <button
          onClick={() => setForm(emptyForm(projects[0] ?? ""))}
          disabled={projects.length === 0}
          className="btn-primary shrink-0 px-4 py-2 text-sm"
        >
          ＋ 新建任务
        </button>
      </div>

      {err && (
        <div className="mb-4 rounded-xl border border-red-900 bg-red-950 px-3.5 py-2.5 text-xs text-red-300">
          {err}
          <button className="ml-2 underline" onClick={() => setErr(null)}>
            关闭
          </button>
        </div>
      )}

      {jobs.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-line2 px-4 py-12 text-center">
          <div className="mb-2 text-xl text-accent/60">◷</div>
          <div className="text-sm text-t3">暂无定时任务</div>
          <div className="mt-1 text-xs text-t4">例如可以配置「每天 09:00 运行测试并汇报」</div>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {jobs.map((job) => {
            const st = job.lastStatus ? STATUS_LABEL[job.lastStatus] : null
            return (
              <div key={job.id} className="rounded-2xl border border-line bg-surface px-4 py-3.5 shadow-xs">
                <div className="flex items-center gap-3.5">
                  <button
                    onClick={() => toggle(job)}
                    title={job.enabled ? "点击停用" : "点击启用"}
                    className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${job.enabled ? "bg-accent" : "bg-line2"}`}
                  >
                    <span
                      className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-xs transition-all ${
                        job.enabled ? "left-[18px]" : "left-0.5"
                      }`}
                    />
                  </button>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2.5">
                      <span className="truncate text-sm font-medium text-t1">{job.name}</span>
                      {st && <span className={`shrink-0 text-xs ${st.cls}`}>上次：{st.text}</span>}
                    </div>
                    <div className="mt-1 truncate text-xs text-t4" title={job.prompt}>
                      {job.scheduleText} · {short(job.project)} · 上限 {job.maxTurns} 轮 · {job.prompt}
                    </div>
                  </div>

                  <div className="shrink-0 text-right text-xs text-t4">
                    <div>下次</div>
                    <div className="font-mono tabular-nums text-t3">{job.enabled ? fmtNext(job.nextRunAt) : "已停用"}</div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    <IconBtn title="立即运行" onClick={() => runNow(job)}>
                      ▶
                    </IconBtn>
                    <IconBtn title="运行日志" onClick={() => setRunsFor(job)}>
                      ≣
                    </IconBtn>
                    <IconBtn title="编辑" onClick={() => setForm(toForm(job))}>
                      ✎
                    </IconBtn>
                    <IconBtn title="删除" danger onClick={() => remove(job)}>
                      ✕
                    </IconBtn>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 新建 / 编辑表单 */}
      {form && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-scrim p-4 backdrop-blur-sm" onClick={() => setForm(null)}>
          <div
            className="rise w-full max-w-lg overflow-hidden rounded-2xl border border-line bg-surface shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-line px-5 py-4 text-sm font-medium text-t1">
              {form.id ? "编辑定时任务" : "新建定时任务"}
            </div>
            <div className="flex max-h-[62vh] flex-col gap-3.5 overflow-y-auto px-5 py-4">
              <Field label="名称">
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如：每日回归测试" className={inputCls} />
              </Field>
              <Field label="项目">
                <select value={form.project} onChange={(e) => setForm({ ...form, project: e.target.value })} className={inputCls}>
                  {projects.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="提示词（任务内容）">
                <textarea
                  value={form.prompt}
                  onChange={(e) => setForm({ ...form, prompt: e.target.value })}
                  rows={3}
                  placeholder="如：运行测试套件，总结失败原因写入 REPORT.md"
                  className={`${inputCls} resize-y`}
                />
              </Field>
              <Field label="排期">
                <div className="flex flex-wrap items-center gap-2">
                  <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as ScheduleKind })} className={`${inputCls} w-28`}>
                    <option value="every">每 N 分钟</option>
                    <option value="daily">每天</option>
                    <option value="weekly">每周</option>
                  </select>
                  {form.kind === "every" && (
                    <div className="flex items-center gap-1.5 text-xs text-t3">
                      每
                      <input
                        type="number"
                        min={1}
                        value={form.everyMin}
                        onChange={(e) => setForm({ ...form, everyMin: Number(e.target.value) || 1 })}
                        className={`${inputCls} w-20`}
                      />
                      分钟（最少 1）
                    </div>
                  )}
                  {form.kind === "weekly" && (
                    <select value={form.weekday} onChange={(e) => setForm({ ...form, weekday: Number(e.target.value) })} className={`${inputCls} w-24`}>
                      {"日一二三四五六".split("").map((w, i) => (
                        <option key={i} value={i}>
                          周{w}
                        </option>
                      ))}
                    </select>
                  )}
                  {form.kind !== "every" && (
                    <input type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} className={`${inputCls} w-32`} />
                  )}
                </div>
              </Field>
              <Field label="轮数上限（maxTurns，1-100）">
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={form.maxTurns}
                  onChange={(e) => setForm({ ...form, maxTurns: Number(e.target.value) || 30 })}
                  className={`${inputCls} w-28`}
                />
              </Field>
            </div>
            <div className="flex justify-end gap-2 border-t border-line bg-surface2 px-5 py-3.5">
              <button onClick={() => setForm(null)} className="btn-ghost px-4 py-2 text-sm">
                取消
              </button>
              <button onClick={submitForm} className="btn-primary px-5 py-2 text-sm">
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 运行日志 */}
      {runsFor && <RunsModal job={runsFor} onClose={() => setRunsFor(null)} />}
    </div>
  )
}

const inputCls = "field px-3 py-2 text-sm"

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-xs text-t3">{label}</div>
      {children}
    </div>
  )
}

function IconBtn({ title, onClick, danger, children }: { title: string; onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex h-7 w-7 items-center justify-center rounded-lg border text-xs transition-colors ${
        danger
          ? "border-red-900 text-red-300 hover:bg-red-950"
          : "border-line2 text-t3 hover:bg-hover hover:text-t1"
      }`}
    >
      {children}
    </button>
  )
}

function RunsModal({ job, onClose }: { job: JobInfo; onClose: () => void }) {
  const [runs, setRuns] = useState<JobRun[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api
      .jobRuns(job.id)
      .then((r) => setRuns(r.runs))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [job.id])

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-scrim p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="rise flex max-h-[75vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <div className="text-sm font-medium text-t1">运行日志 · {job.name}</div>
          <button
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded-lg text-t4 transition-colors hover:bg-hover hover:text-t1"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {err && <div className="rounded-xl border border-red-900 bg-red-950 px-3.5 py-2.5 text-xs text-red-300">{err}</div>}
          {!runs && !err && <div className="py-8 text-center text-xs text-t4">加载中…</div>}
          {runs && runs.length === 0 && <div className="py-8 text-center text-xs text-t4">还没有运行记录</div>}
          {runs && runs.length > 0 && (
            <div className="flex flex-col gap-2.5">
              {runs.map((r) => {
                const st = STATUS_LABEL[r.status] ?? { text: r.status, cls: "text-t3" }
                return (
                  <div key={r.id} className="rounded-xl border border-line bg-surface2 px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span className={`text-xs font-medium ${st.cls}`}>{st.text}</span>
                      <span className="text-xs text-t4">{new Date(r.ts).toLocaleString()}</span>
                      <span className="text-xs tabular-nums text-t4">耗时 {(r.durationMs / 1000).toFixed(1)}s</span>
                      <span className="ml-auto text-xs tabular-nums text-t4">
                        {r.promptTokens + r.completionTokens > 0 ? `${r.promptTokens}+${r.completionTokens} tok` : ""}
                      </span>
                    </div>
                    {r.error && <div className="mt-1.5 break-all text-xs text-red-300">{r.error}</div>}
                    {r.resultPreview && (
                      <div className="mt-1.5 line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed text-t3">{r.resultPreview}</div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
