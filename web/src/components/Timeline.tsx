import { useEffect, useMemo, useRef, useState } from "react"
import { marked } from "marked"
import type { TimelineItem } from "../lib/types"
import { copyText } from "../lib/clipboard"
import ToolCard from "./ToolCard"
import SuggestChips from "./SuggestChips"
import TMark from "./TMark"

marked.setOptions({ gfm: true, breaks: true })

/** 时间戳：今天的只显示时刻，跨天带日期 */
function fmtTime(ts: number) {
  const d = new Date(ts)
  const time = d.toLocaleTimeString("zh-CN", { hour12: false })
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString("zh-CN")} ${time}`
}

/** token 数：千位以上缩写为 k */
function fmtTokens(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** 助手消息里的代码块：渲染后给每个 <pre> 挂一个复制按钮（事件委托不易命中，直接在 DOM 上补） */
function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const html = useMemo(() => {
    try {
      return marked.parse(text, { async: false }) as string
    } catch {
      return text
    }
  }, [text])

  useEffect(() => {
    // 流式期间每帧都在变，等这轮结束再挂按钮
    if (streaming) return
    const root = boxRef.current
    if (!root) return
    const created: HTMLButtonElement[] = []
    for (const pre of Array.from(root.querySelectorAll("pre"))) {
      if (pre.querySelector("[data-tcw-copy]")) continue
      const btn = document.createElement("button")
      btn.type = "button"
      btn.dataset.tcwCopy = "1"
      btn.textContent = "复制"
      btn.className = "md-copy-btn"
      const src = pre.querySelector("code") ?? pre
      btn.addEventListener("click", async () => {
        const okFlag = await copyText((src as HTMLElement).innerText.replace(/\n$/, ""))
        btn.textContent = okFlag ? "已复制" : "复制失败"
        window.setTimeout(() => { btn.textContent = "复制" }, 1400)
      })
      pre.appendChild(btn)
      created.push(btn)
    }
    return () => { for (const b of created) b.remove() }
  }, [html, streaming])

  return <div ref={boxRef} className="md" dangerouslySetInnerHTML={{ __html: html }} />
}

/** 复制按钮：点一下变对勾，1.4 秒后复原 */
function CopyButton({ text, title = "复制", className = "" }: { text: string; title?: string; className?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      title={done ? "已复制" : title}
      aria-label={title}
      onClick={async () => {
        const okFlag = await copyText(text)
        if (!okFlag) return
        setDone(true)
        window.setTimeout(() => setDone(false), 1400)
      }}
      className={`tool-btn ${className}`}
    >
      {done ? (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 8.5l3.4 3.4L13 5.2" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <rect x="6" y="6" width="8" height="8" rx="2" />
          <path d="M10 6V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h2" />
        </svg>
      )}
    </button>
  )
}

export default function Timeline({
  items,
  running,
  suggests,
  onPickSuggest,
  onApprovePlan,
  onAdjustPlan,
  onRollback,
  onUndoRewind,
}: {
  items: TimelineItem[]
  running: boolean
  suggests: string[]
  onPickSuggest: (text: string) => void
  onApprovePlan: () => void
  onAdjustPlan: () => void
  onRollback: (item: { rewindId: string; text: string }) => void
  onUndoRewind: () => void
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  // 用户贴近底部时自动滚动；向上翻看时不打扰。
  // 依赖含 suggests：建议是 run_end 之后旁路异步回来的，到得晚，贴底时应跟着滚进视野
  useEffect(() => {
    const el = boxRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [items, suggests])

  const onScroll = () => {
    const el = boxRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  return (
    <div ref={boxRef} onScroll={onScroll} className="mx-auto h-full max-w-3xl overflow-y-auto px-5 py-8">
      {items.length === 0 && (
        <div className="mt-28 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-accent">
            <TMark className="h-5 w-5 text-white" />
          </div>
          <div className="text-base font-medium tracking-[-0.01em] text-t2">
            {running ? "正在处理…" : "今天想让 thincoder 做点什么？"}
          </div>
          <div className="mt-1.5 text-sm text-t4">它会先探索、再动手，每一步都看得见。</div>
        </div>
      )}

      <div className="flex flex-col gap-5">
        {items.map((it) => {
          if (it.kind === "user") {
            const canRollback = Boolean(it.rewindId)
            return (
              <div key={it.id} className="rise group flex justify-end">
                <div className="flex max-w-[85%] flex-col items-end gap-1">
                  <div className="flex items-end gap-1">
                    {/* 悬停工具条：复制 / 回退到这条消息之前 */}
                    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <CopyButton text={it.text} />
                      <button
                        type="button"
                        disabled={!canRollback}
                        title={canRollback ? "回退到这条消息之前" : "这条消息没有可用的回退点（可能已被压缩或超出保留范围）"}
                        aria-label="回退到这条消息之前"
                        onClick={() => canRollback && onRollback({ rewindId: it.rewindId as string, text: it.text })}
                        className="tool-btn disabled:cursor-not-allowed disabled:opacity-35"
                      >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M2 8a6 6 0 1 0 6-6 6.5 6.5 0 0 0-4.5 1.83L2 5.33" />
                          <path d="M2 2v3.33h3.33" />
                        </svg>
                      </button>
                    </div>
                    <div className="whitespace-pre-wrap rounded-[18px] bg-bubble px-4 py-2.5 text-sm leading-relaxed text-t1">
                      {it.text}
                    </div>
                  </div>
                  {Boolean(it.ts) && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] leading-none tabular-nums text-t4">{fmtTime(it.ts as number)}</span>
                      {/* 左向小三角：与「思考过程」折叠三角同尺寸、方向相反，颜色同气泡底色 */}
                      <span
                        aria-hidden="true"
                        className="inline-block h-0 w-0 border-y-5 border-r-6 border-y-transparent"
                        style={{ borderRightColor: "var(--bubble-user)" }}
                      />
                    </div>
                  )}
                </div>
              </div>
            )
          }

          if (it.kind === "assistant") {
            const streaming = !it.done && running
            return (
              <div key={it.id} className="rise group flex gap-3">
                <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-accent">
                  <TMark className="h-3.5 w-3.5 text-white" />
                </div>
                <div className="relative min-w-0 flex-1">
                  {it.text && (
                    <div className="absolute right-0 top-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                      <CopyButton text={it.text} />
                    </div>
                  )}
                  {it.reasoning && (
                    <details className="mb-2 text-xs text-t4">
                      <summary className="cursor-pointer select-none rounded-md py-0.5 transition-colors hover:text-t3">
                        思考过程
                      </summary>
                      <div className="mt-1.5 whitespace-pre-wrap border-l-2 border-line pl-3 leading-relaxed text-t4">
                        {it.reasoning}
                      </div>
                    </details>
                  )}
                  {it.text && (
                    <div className={`text-sm text-t-body ${streaming ? "stream-cursor" : ""}`}>
                      <Markdown text={it.text} streaming={streaming} />
                    </div>
                  )}
                </div>
              </div>
            )
          }

          if (it.kind === "tool") {
            return <ToolCard key={it.id} tool={it.tool} />
          }

          if (it.kind === "plan") {
            return (
              <div key={it.id} className="rise rounded-2xl border border-sky-700/40 bg-sky-950/60 p-4">
                <div className="mb-2 flex items-center gap-2">
                  <span className="rounded-full bg-sky-700/40 px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-sky-300">
                    实施方案
                  </span>
                  <span className="text-xs text-t4">Plan 模式产出 · 确认后实施</span>
                </div>
                <div className="text-sm text-t-body">
                  <Markdown text={it.plan} />
                </div>
                <div className="mt-3.5 flex gap-2">
                  <button onClick={onApprovePlan} className="btn-primary px-4 py-2 text-xs">
                    批准，开始实施
                  </button>
                  <button onClick={onAdjustPlan} className="btn-ghost px-4 py-2 text-xs">
                    需要调整…
                  </button>
                </div>
              </div>
            )
          }

          if (it.kind === "runEnd") {
            const parts = [fmtTime(it.ts)]
            if (it.prompt > 0 || it.completion > 0) {
              parts.push(`Token ↑ ${fmtTokens(it.prompt)} / ↓ ${fmtTokens(it.completion)}`)
            }
            return (
              <div key={it.id} className="rise flex items-center gap-3 text-[11px] text-t4" title="本轮运行完成时间与 token 消耗">
                <span className="h-px flex-1 bg-line" />
                <span className="shrink-0 tabular-nums">{parts.join(" · ")}</span>
                <span className="h-px flex-1 bg-line" />
              </div>
            )
          }

          // notice
          const tone =
            it.level === "error"
              ? "border-red-900 bg-red-950 text-red-300"
              : it.level === "warn"
                ? "border-amber-900 bg-amber-950 text-amber-300"
                : "border-line bg-surface2 text-t3"
          return (
            <div key={it.id} className={`rise rounded-xl border px-3.5 py-2 text-xs leading-relaxed ${tone}`}>
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">{it.text}</div>
                {it.action?.kind === "undo-rewind" && (
                  <button onClick={onUndoRewind} className="shrink-0 rounded-md border border-current/40 px-2 py-1 font-medium">
                    {it.action.label}
                  </button>
                )}
              </div>
            </div>
          )
        })}

        {/* 追问建议：一轮正常收尾才产生；渲染在对话流末尾（收尾线之后）、与助手正文列左对齐；点击填入输入框 */}
        {suggests.length > 0 && items.length > 0 && <SuggestChips items={suggests} onPick={onPickSuggest} />}

        {running && items.length > 0 && items[items.length - 1].kind !== "assistant" && (
          <div className="flex items-center gap-2 pl-9 text-xs text-t4">
            <span className="spinner" /> 工作中…
          </div>
        )}
      </div>
    </div>
  )
}
