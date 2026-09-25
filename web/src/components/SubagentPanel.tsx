import { useEffect, useState } from "react"
import type { SubagentItem, SubagentStats } from "../lib/types"
import Tooltip from "./Tooltip"

interface Props {
  items: SubagentItem[]
  /** 进度统计（已派发/已结束/失败）：标题上的「已结束/已派发」数字取它 */
  stats: SubagentStats | null
  onClose: () => void
}

const ACTIVE = new Set(["running", "queued"])

/**
 * 每行左侧状态标记：六态各自可区分（字形与语义色都不同）。
 * running 不是字形而是行内的 CSS spinner（转圈本身就与五种静态标记互斥），其余五态全走这张表：
 *   排队○（空心）· 完成✓ · 出错✗ · 被停■ · 结束●（实心）
 * 颜色沿用项目语义色阶（index.css 按主题重映射，浅/深色各一套）：成功 emerald-400、出错 red-300、
 * 被停 amber-400、中性（排队/结束）t4。
 */
const MARK: Record<string, { icon: string; cls: string }> = {
  queued: { icon: "○", cls: "text-t4" },
  done: { icon: "✓", cls: "text-emerald-400" },
  stopped: { icon: "■", cls: "text-amber-400" },
  error: { icon: "✗", cls: "text-red-300" },
  ended: { icon: "●", cls: "text-t4" },
}

/** 表外的未知状态（服务端将来可能新增）：不当成任何一种六态，回落中性空心圆 */
const MARK_UNKNOWN = { icon: "○", cls: "text-t4" }

const STATUS_LABEL: Record<string, string> = {
  queued: "排队中",
  running: "运行中",
  done: "已完成",
  stopped: "已中止",
  error: "出错",
  ended: "已结束",
}

/** 排队原因（内核 ⟦ev⟧queued 的 kind 字段：slot = 槽位满 / wait = 等依赖 / depc = 依赖被取消） */
const QUEUE_KIND: Record<string, string> = {
  slot: "等待槽位",
  wait: "等待依赖",
  depc: "依赖已取消",
}

function fmtElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ""
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`
}

/** 已结束的行按最后一次变更时刻冻结 elapsed（否则旁边有运行条目时会一直涨） */
function elapsedOf(it: SubagentItem, now: number): string {
  if (typeof it.startedAt !== "number") return ""
  const end = ACTIVE.has(it.status) ? now : typeof it.updatedAt === "number" ? it.updatedAt : now
  return fmtElapsed(end - it.startedAt)
}

function subtitleOf(it: SubagentItem): string {
  if (it.status === "queued") {
    const why = it.queueKind ? QUEUE_KIND[it.queueKind] ?? it.queueKind : ""
    const pos = typeof it.position === "number" && it.position > 0 ? `第 ${it.position} 位` : ""
    return ["排队中", why, pos].filter(Boolean).join(" · ")
  }
  if (it.waitingApproval) return `${it.currentTool ?? "工具调用"} · 等待审批`
  if (it.currentTool) return it.currentTool
  if (it.lastText) return it.lastText
  return STATUS_LABEL[it.status] ?? ""
}

/** 子代理面板（右侧检查器）——服务端分流内核 relay 前缀后的进度登记表 */
export default function SubagentPanel({ items, stats, onClose }: Props) {
  const [open, setOpen] = useState<string | null>(null)
  const [, forceTick] = useState(0) // 1s 心跳：仅用于刷新 elapsed
  const anyActive = items.some((it) => ACTIVE.has(it.status))

  // 有运行/排队条目才 tick（无运行条目不 tick——免得白渲染）
  useEffect(() => {
    if (!anyActive) return
    const timer = setInterval(() => forceTick((t) => t + 1), 1000)
    return () => clearInterval(timer)
  }, [anyActive])

  const queued = items.filter((it) => it.status === "queued").length
  // 进度式数字：已结束/已派发（分母用服务端**单调计数**——终态行按 20 条自裁，行数当分母会封顶失真）
  const dispatched = stats?.dispatched ?? 0
  const finished = Math.min(stats?.finished ?? 0, dispatched)
  const failed = stats?.failed ?? 0
  const now = Date.now()

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-line bg-surface2">
      <div className="flex items-center justify-between px-4 py-3.5">
        <div className="text-xs font-medium tracking-wide text-t2">
          子代理
          {dispatched > 0 && (
            <Tooltip
              label={`本会话已结束 ${finished} / 已派发 ${dispatched}${failed > 0 ? ` · 失败 ${failed}` : ""}`}
              side="bottom"
            >
              <span className="ml-1.5 tabular-nums text-t4">
                {finished}/{dispatched}
              </span>
            </Tooltip>
          )}
          {failed > 0 && <span className="ml-1.5 tabular-nums text-red-300">失败 {failed}</span>}
          {queued > 0 && <span className="ml-1.5 tabular-nums text-t4">排队 {queued}</span>}
        </div>
        <button
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded-lg text-t4 transition-colors hover:bg-hover hover:text-t1"
        >
          ✕
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
        {items.length === 0 ? (
          <div className="px-2 py-10 text-center text-xs leading-relaxed text-t4">
            暂无子代理。
            <br />
            agent 派发子任务（探索 / 编码 / 审阅等）
            <br />
            时会在这里显示进度与完成报告。
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {items.map((it) => {
              const m = MARK[it.status] ?? MARK_UNKNOWN
              const expanded = open === it.key
              const elapsed = elapsedOf(it, now)
              return (
                <li key={it.key} className="rounded-lg px-2.5 py-2 text-xs transition-colors hover:bg-hover">
                  {/* 包裹层必须自带 w-full：默认 inline-flex 是内容宽，内层 w-full 的百分比无从解析
                      （拿内容 max-content）——行宽会溢出 li（实测 1977px / li 267px：列表横向溢出
                      7 倍，右侧 elapsed/轮次列被挤出面板）。包层 w-full ⇒ 内层百分比有基准。 */}
                  <Tooltip label={expanded ? "收起详情" : "展开详情"} side="bottom" className="w-full">
                    <button
                      onClick={() => setOpen(expanded ? null : it.key)}
                      className="flex w-full items-start gap-2.5 text-left"
                    >
                    {/* 状态标记：running=转圈；其余五态按字形+语义色区分（六态互不混同） */}
                    <span className="mt-px w-3.5 shrink-0 text-center">
                      {it.status === "running" ? (
                        <span className="spinner" />
                      ) : (
                        <span className={m.cls}>{m.icon}</span>
                      )}
                    </span>

                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-1.5">
                        <span className={`truncate font-medium ${it.status === "done" ? "text-t3" : "text-t2"}`}>
                          {it.role}#{it.id}
                        </span>
                        {it.pending && (
                          <span className="shrink-0 rounded-full bg-sky-950 px-1.5 text-[10px] font-medium text-sky-300">待消化</span>
                        )}
                        {it.model && <span className="truncate text-[10px] text-t4">{it.model}</span>}
                      </span>
                      <span className="mt-0.5 block truncate text-t4">{subtitleOf(it)}</span>
                    </span>

                    <span className="shrink-0 text-right text-[10px] tabular-nums leading-4 text-t4">
                      {elapsed && <span className="block">{elapsed}</span>}
                      {(it.turn > 0 || it.maxTurns > 0) && (
                        <span className="block">
                          {it.turn}/{it.maxTurns}
                        </span>
                      )}
                    </span>
                    </button>
                  </Tooltip>

                  {expanded && (
                    <div className="mt-2 space-y-1.5 border-t border-line pt-2 text-[11px] leading-relaxed text-t3">
                      <div className="text-t4">
                        状态：{STATUS_LABEL[it.status] ?? it.status}
                        {it.pending ? " · 待消化（报告已收尾，等消化轮读进会话）" : ""}
                        {it.model ? ` · 模型 ${it.model}` : ""}
                        {it.turn > 0 || it.maxTurns > 0 ? ` · 轮次 ${it.turn}/${it.maxTurns}` : ""}
                      </div>

                      {it.files.length > 0 && (
                        <div>
                          <div className="text-t4">改动文件（{it.files.length}）</div>
                          <div className="mt-0.5 break-all font-mono text-[10px] leading-relaxed text-t2">
                            {it.files.map((f) => (
                              <div key={f}>{f}</div>
                            ))}
                            {it.files.length >= 20 && <div className="text-t4">（仅显示前 20 个）</div>}
                          </div>
                        </div>
                      )}

                      {it.lastText && (
                        <div>
                          <div className="text-t4">最近活动</div>
                          <div className="mt-0.5 whitespace-pre-wrap break-words">{it.lastText}</div>
                        </div>
                      )}

                      {it.report && (
                        <div>
                          <div className="text-t4">完成报告{it.reportTruncated ? "（已截断）" : ""}</div>
                          <pre className="mt-0.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface3 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-t2">
                            {it.report}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </aside>
  )
}
