import { useCallback, useEffect, useState } from "react"
import { api } from "../lib/api"
import type { UsageStats } from "../lib/types"
import { FloatingTooltip } from "./Tooltip"

const fmt = (n: number) => n.toLocaleString()

/** 仅显示最后一个子目录名；完整路径由悬停提示给出。双分隔符：Windows 反斜杠路径同样正确 */
const short = (dir: string) => {
  const parts = dir.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : dir
}

/** 用量看板（当天 / 近 N 天：总量 / 按日 / 按项目 / 按模型） */
export default function UsagePage() {
  const [days, setDays] = useState(7)
  const [stats, setStats] = useState<UsageStats | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    api
      .usage(days)
      .then(setStats)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [days])

  useEffect(load, [load])

  const maxDayCalls = Math.max(1, ...(stats?.byDay.map((d) => d.calls) ?? [1]))
  const cacheRate = (hit: number, miss: number) => {
    const total = hit + miss
    return total > 0 ? `${Math.round((hit / total) * 100)}%` : "—"
  }

  return (
    <div className="mx-auto h-full max-w-4xl overflow-y-auto px-8 py-8">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-[-0.01em] text-t1">模型用量</h1>
          <p className="mt-1 text-xs text-t4">每次 LLM 调用记一行（内核 onUsage）</p>
        </div>
        <div className="seg">
          {[0, 7, 30].map((d) => (
            <button key={d} data-on={days === d} onClick={() => setDays(d)}>
              {d === 0 ? "当天" : `近 ${d} 天`}
            </button>
          ))}
        </div>
      </div>

      {err && <div className="mb-4 rounded-xl border border-red-900 bg-red-950 px-3.5 py-2.5 text-xs text-red-300">{err}</div>}
      {!stats && !err && <div className="py-12 text-center text-sm text-t4">加载中…</div>}

      {stats && (
        <>
          {/* 总量卡片 */}
          <div className="mb-7 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Card label="LLM 调用" value={fmt(stats.totals.calls)} />
            <Card label="Prompt tokens" value={fmt(stats.totals.prompt)} />
            <Card label="Completion tokens" value={fmt(stats.totals.completion)} />
            <Card label="缓存命中率" value={cacheRate(stats.totals.hit, stats.totals.miss)} />
          </div>

          {/* 按日 */}
          <SectionTitle>按日</SectionTitle>
          {stats.byDay.length === 0 ? (
            <Empty text="暂无用量记录" />
          ) : (
            <div className="mb-7 overflow-hidden rounded-xl border border-line">
              <table className="w-full text-xs">
                <thead className="bg-surface2 text-t4">
                  <tr>
                    <Th>日期</Th>
                    <Th>分布</Th>
                    <Th right>调用</Th>
                    <Th right>Prompt</Th>
                    <Th right>Completion</Th>
                    <Th right>缓存</Th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byDay.map((d) => (
                    <tr key={d.day} className="border-t border-line transition-colors hover:bg-hover/60">
                      <td className="px-3.5 py-2 font-mono text-t2">{d.day}</td>
                      <td className="px-3.5 py-2">
                        <div className="h-1.5 w-full max-w-40 overflow-hidden rounded-full bg-surface3">
                          <div className="h-1.5 rounded-full bg-accent" style={{ width: `${(d.calls / maxDayCalls) * 100}%` }} />
                        </div>
                      </td>
                      <td className="px-3.5 py-2 text-right tabular-nums text-t2">{fmt(d.calls)}</td>
                      <td className="px-3.5 py-2 text-right tabular-nums text-t3">{fmt(d.prompt)}</td>
                      <td className="px-3.5 py-2 text-right tabular-nums text-t3">{fmt(d.completion)}</td>
                      <td className="px-3.5 py-2 text-right tabular-nums text-t3">{cacheRate(d.hit, d.miss)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* 按项目：与「按日」同一时间窗；栏内只放末级目录名，全路径走悬停提示（表格单元格属可滚动容器，用 FloatingTooltip）。
              提示用 always：末级名同名、父目录不同的两个项目（如两处 Temp）在栏内完全同形，全路径是唯一区分信息，
              若走「被截断才弹」的门槛，短名那类就永远无法区分——短名多弹一次只是冗余，不弹就是信息缺失 */}
          <SectionTitle>按项目</SectionTitle>
          {stats.byProject.length === 0 ? (
            <Empty text="暂无用量记录" />
          ) : (
            <div className="mb-7 overflow-hidden rounded-xl border border-line">
              <table className="w-full text-xs" data-usage-by-project>
                <thead className="bg-surface2 text-t4">
                  <tr>
                    <Th>项目</Th>
                    <Th right>调用</Th>
                    <Th right>Prompt</Th>
                    <Th right>Completion</Th>
                    <Th right>缓存</Th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byProject.map((p) => {
                    // 空 project（列默认值 / 未带项目落库的行）如实占一格，不混入别的项目
                    const name = p.project ? short(p.project) : "（未标注项目）"
                    return (
                      <tr key={p.project} data-project={p.project} className="border-t border-line transition-colors hover:bg-hover/60">
                        <td className="px-3.5 py-2 text-t2">
                          <FloatingTooltip label={p.project || "（未标注项目）"} always>
                            <span className="block max-w-56 truncate">{name}</span>
                          </FloatingTooltip>
                        </td>
                        <td className="px-3.5 py-2 text-right tabular-nums text-t2">{fmt(p.calls)}</td>
                        <td className="px-3.5 py-2 text-right tabular-nums text-t3">{fmt(p.prompt)}</td>
                        <td className="px-3.5 py-2 text-right tabular-nums text-t3">{fmt(p.completion)}</td>
                        <td className="px-3.5 py-2 text-right tabular-nums text-t3">{cacheRate(p.hit, p.miss)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* 按模型 */}
          <SectionTitle>按供应商 / 模型</SectionTitle>
          {stats.byModel.length === 0 ? (
            <Empty text="暂无用量记录" />
          ) : (
            <div className="overflow-hidden rounded-xl border border-line">
              <table className="w-full text-xs">
                <thead className="bg-surface2 text-t4">
                  <tr>
                    <Th>供应商</Th>
                    <Th>模型</Th>
                    <Th right>调用</Th>
                    <Th right>Prompt</Th>
                    <Th right>Completion</Th>
                    <Th right>缓存</Th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byModel.map((m) => (
                    <tr key={`${m.provider}/${m.model}`} className="border-t border-line transition-colors hover:bg-hover/60">
                      <td className="px-3.5 py-2 text-t2">{m.provider || "—"}</td>
                      <td className="px-3.5 py-2 font-mono text-accent">{m.model || "—"}</td>
                      <td className="px-3.5 py-2 text-right tabular-nums text-t2">{fmt(m.calls)}</td>
                      <td className="px-3.5 py-2 text-right tabular-nums text-t3">{fmt(m.prompt)}</td>
                      <td className="px-3.5 py-2 text-right tabular-nums text-t3">{fmt(m.completion)}</td>
                      <td className="px-3.5 py-2 text-right tabular-nums text-t3">{cacheRate(m.hit, m.miss)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="mt-5 text-xs leading-relaxed text-t4">
            口径：每次 LLM 调用记一行（内核 onUsage），缓存命中率 = cache_hit / (cache_hit + cache_miss)，无缓存数据的端点显示 —。
            三个分组各自独立、窗口一致（同一次调用同时计入按日 / 按项目 / 按供应商·模型）；「按项目」栏内只显示项目目录末级名，悬停看完整路径。
          </p>
        </>
      )}
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-2.5 text-xs font-medium uppercase tracking-wider text-t3">{children}</h2>
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={`px-3.5 py-2.5 font-medium ${right ? "text-right" : "text-left"}`}>{children}</th>
}

function Empty({ text }: { text: string }) {
  return <div className="mb-7 rounded-xl border border-line px-3.5 py-5 text-center text-xs text-t4">{text}</div>
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="card px-4 py-3.5">
      <div className="text-xs text-t4">{label}</div>
      <div className="mt-1 text-xl font-semibold leading-none tracking-[-0.01em] text-t1">{value}</div>
    </div>
  )
}
