import { useState } from "react"
import type { ApprovalMode, ProviderStatus, SubagentItem, SubagentStats, ThinkingInfo } from "../lib/types"
import Tooltip from "./Tooltip"

interface Props {
  provider: ProviderStatus | null
  /** 思考程度（/api/thinking）：supported=false 或为 null 时不渲染选择器 */
  thinking: ThinkingInfo | null
  /** 选档：auto=切换 Auto-think / off=关思考 / effort+level=具体档位 */
  onThinking: (action: "auto" | "off" | "effort", level?: string) => void
  /** 模型胶囊菜单「打开模型设置…」/ 未配置态点击 → 进设置页 */
  onOpenSettings: () => void
  /** 菜单点选渠道 → App 调 setActiveProvider + refreshProvider */
  onSwitchProvider: (name: string) => void
  mode: ApprovalMode
  onMode: (m: ApprovalMode) => void
  running: boolean
  /** 挂起会话中（后台池仍 live）：会话仍忙，停止键保持可达 */
  suspended: boolean
  queued: number
  usage: { prompt: number; completion: number }
  tasks: { title: string; status: string }[]
  onStop: () => void
  planMode: boolean
  showTasks: boolean
  onToggleTasks: () => void
  /** 子代理面板（agent 派发的子任务进度） */
  subagents: SubagentItem[]
  /** 子代理进度统计（已派发/已结束/失败）：按钮上的「已结束/已派发」数字取它 */
  subagentStats: SubagentStats | null
  showSubagents: boolean
  onToggleSubagents: () => void
  // 左右面板开关
  showHistory: boolean
  onToggleHistory: () => void
  showDocs: boolean
  onToggleDocs: () => void
  docCount: number
}

const MODE_LABEL: Record<ApprovalMode, string> = {
  suggest: "Suggest（逐项审批）",
  "auto-edit": "Auto Edit（写盘免批）",
  "full-auto": "Full Auto（全部放行）",
}

const MODE_SHORT: Record<ApprovalMode, string> = {
  suggest: "逐项审批",
  "auto-edit": "写盘免批",
  "full-auto": "全部放行",
}

/** 审批模式状态点配色：绿=逐项审批（最稳）→ 琥珀=写盘免批 → 红=全部放行（最宽） */
const MODE_DOT: Record<ApprovalMode, string> = {
  suggest: "bg-emerald-400",
  "auto-edit": "bg-amber-400",
  "full-auto": "bg-red-400",
}

/** 用量缩写显示：K / M / B 三级，最多 1 位小数（999,999 → 1M 自动进位）。 */
const compactFmt = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })

/** 顶栏：面板开关 / 模型状态 / 任务 / 文档 / 审批模式 / 运行状态。
    项目与会话管理已收敛到左侧历史面板，这里不再重复。 */
export default function TopBar(p: Props) {
  const done = p.tasks.filter((t) => t.status === "done").length
  const totalTok = p.usage.prompt + p.usage.completion
  const subRunning = p.subagents.filter((s) => s.status === "running").length
  const subQueueing = p.subagents.filter((s) => s.status === "queued").length
  // 按钮前的转圈：只要还有子代理在活动就转——running（在跑）∨ queued（等槽位 / 等依赖）
  // ∨ pending（已收尾、等消化）。挂起会话里两轮消化之间 running 会被复位，pending 兼住；
  // 池里只剩排队条目时也转（用户裁定 2026-09-24：queued 计入）。
  const subPending = p.subagents.filter((s) => s.pending === true).length
  const subBusy = subRunning > 0 || subQueueing > 0 || subPending > 0
  // 进度式数字：已结束/已派发（分母用服务端**单调计数**——面板行有 20 条自裁上限，拿行数当分母会永远卡在 20）
  const sd = p.subagentStats
  const sdDispatched = sd?.dispatched ?? 0
  const sdFinished = Math.min(sd?.finished ?? 0, sdDispatched)
  const sdFailed = sd?.failed ?? 0
  // 悬停明细：失败数 / 排队数（数字只在 > 0 时出现，与「dispatched=0 不显数字」同为克制策略）
  const subTip = [
    "子代理面板（agent 派发的 explore / coder / 审阅等子任务进度）",
    sdDispatched > 0 ? `本会话已结束 ${sdFinished} / 已派发 ${sdDispatched}` : "",
    sdFailed > 0 ? `失败 ${sdFailed}` : "",
    subQueueing > 0 ? `排队 ${subQueueing}` : "",
  ]
    .filter(Boolean)
    .join(" · ")
  // 模型胶囊：已配置且有多渠道（或想进设置）时可点，弹出渠道切换菜单
  const [provMenu, setProvMenu] = useState(false)
  const provClickable = p.provider !== null
  // 思考胶囊（provider/model 右侧同款）：点击弹菜单；显示 think: <state>，标签全英文
  const [thinkMenu, setThinkMenu] = useState(false)
  // 审批模式胶囊（与 think 胶囊同款交互）：点击弹菜单切换
  const [modeMenu, setModeMenu] = useState(false)
  const th = p.thinking
  const thinkOff = Boolean(th && !th.autoThink && th.state === "off")
  const thinkDisplay = th ? (th.autoThink ? "auto" : (th.state ?? "on")) : ""
  // 悬停提示（预计算——模板串里嵌套模板串会撕裂 JSX）
  const thinkTip = th
    ? th.autoThink
      ? "Auto-think：内核按任务难度每轮自动定思考强度"
      : th.state === "on"
        ? "思考程度：当前开（服务端默认强度）"
        : th.state === "off"
          ? "思考程度：当前已关闭"
          : `思考程度：当前档位 ${th.state}`
    : ""
  // 菜单项：auto / off / 模型档位（枚举随模型走）；自动模式下选手动项 = 退出自动并应用
  const thinkItems: { label: string; action: "auto" | "off" | "effort"; level?: string; active: boolean }[] = th
    ? [
        { label: "auto", action: "auto", active: th.autoThink },
        { label: "off", action: "off", active: !th.autoThink && th.state === "off" },
        ...th.levels.map((lv) => ({
          label: lv,
          action: "effort" as const,
          level: lv,
          active: !th.autoThink && th.state === lv,
        })),
      ]
    : []

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-bg px-3">
      {/* 左侧面板开关 */}
      <Tooltip label={p.showHistory ? "收起历史面板" : "展开历史面板（项目 / 会话）"} side="right" className="shrink-0">
        <button
          onClick={p.onToggleHistory}
          aria-pressed={p.showHistory}
          className={`flex h-8 w-8 items-center justify-center rounded-xl transition-colors ${
            p.showHistory ? "bg-accent-soft text-accent" : "text-t3 hover:bg-hover hover:text-t1"
          }`}
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2" />
            <path d="M6.4 2.8v10.4" />
          </svg>
        </button>
      </Tooltip>

      <span className="h-5 w-px shrink-0 bg-line" />

      {/* 模型状态：状态点 + 模型名（可点击：已配置弹渠道切换菜单，未配置进设置页；文字样式不变） */}
      <div className="relative shrink-0">
        <Tooltip label={p.provider?.baseURL ?? "模型连接状态"} side="bottom">
          <button
            onClick={() => {
              if (p.provider === null) return // 连接中：无动作
              if (!p.provider.configured) p.onOpenSettings()
              else setProvMenu((v) => !v)
            }}
            className={`flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium ${
              p.provider === null
                ? "bg-surface2 text-t4"
                : p.provider.configured
                  ? "bg-emerald-950 text-emerald-300"
                  : "bg-red-950 text-red-300"
            } ${provClickable ? "cursor-pointer" : "cursor-default"}`}
          >
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                p.provider === null ? "bg-t4/60" : p.provider.configured ? "bg-emerald-400" : "bg-red-400"
              }`}
            />
            {p.provider === null ? "连接中…" : p.provider.configured ? `${p.provider.provider} / ${p.provider.model}` : "未配置模型"}
          </button>
        </Tooltip>
        {provMenu && p.provider?.configured && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setProvMenu(false)} />
            <div className="absolute left-0 top-full z-50 mt-1.5 w-64 overflow-hidden rounded-xl border border-line bg-surface shadow-lg">
              <div className="border-b border-line px-3.5 py-2 text-xs text-t4">切换模型渠道</div>
              {p.provider.providers.map((x) => {
                const active = p.provider?.activeProvider === x.name
                return (
                  <Tooltip key={x.name} label={`${x.name} / ${x.model}`} side="right" className="w-full">
                    <button
                      onClick={() => {
                        setProvMenu(false)
                        if (!active) p.onSwitchProvider(x.name)
                      }}
                      className={`flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs transition-colors hover:bg-hover ${
                        active ? "text-accent" : "text-t2"
                      }`}
                    >
                      <span className={`w-3.5 shrink-0 ${active ? "" : "invisible"}`}>✓</span>
                      <span className="shrink-0 font-medium">{x.name}</span>
                      <span className="min-w-0 truncate font-mono text-t4">{x.model}</span>
                    </button>
                  </Tooltip>
                )
              })}
              <button
                onClick={() => {
                  setProvMenu(false)
                  p.onOpenSettings()
                }}
                className="flex w-full items-center border-t border-line px-3.5 py-2 text-left text-xs text-t3 transition-colors hover:bg-hover hover:text-t1"
              >
                打开模型设置…
              </button>
            </div>
          </>
        )}
      </div>

      {/* 思考程度（内核 /think 等价面）：provider/model 右侧同款胶囊 + 下拉菜单（标签全英文） */}
      {th?.supported && (
        <div className="relative shrink-0">
          <Tooltip label={thinkTip} side="bottom">
            <button
              onClick={() => setThinkMenu((v) => !v)}
              className={`flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs font-medium ${
                thinkOff ? "bg-surface2 text-t4" : "bg-emerald-950 text-emerald-300"
              }`}
            >
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${thinkOff ? "bg-t4/60" : "bg-emerald-400"}`} />
              think: {thinkDisplay}
            </button>
          </Tooltip>
          {thinkMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setThinkMenu(false)} />
              <div className="absolute left-0 top-full z-50 mt-1.5 w-44 overflow-hidden rounded-xl border border-line bg-surface shadow-lg">
                <div className="border-b border-line px-3.5 py-2 text-xs text-t4">切换思考强度</div>
                {thinkItems.map((it) => (
                  <button
                    key={it.label}
                    onClick={() => {
                      setThinkMenu(false)
                      p.onThinking(it.action, it.level)
                    }}
                    className={`flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs transition-colors hover:bg-hover ${
                      it.active ? "text-accent" : "text-t2"
                    }`}
                  >
                    <span className={`w-3.5 shrink-0 ${it.active ? "" : "invisible"}`}>✓</span>
                    <span className="shrink-0 font-medium">{it.label}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      <div className="flex-1" />

      {/* PLAN 徽标 */}
      {p.planMode && (
        <Tooltip label="Plan 模式：只读探索，方案确认前不改文件" side="bottom">
          <span className="rounded-full bg-sky-950 px-2.5 py-1 text-xs font-semibold tracking-wide text-sky-300">
            PLAN
          </span>
        </Tooltip>
      )}

      {/* 审批模式：与 think 胶囊同款（胶囊 + 下拉菜单），状态点按模式宽紧着色；
          位置在「任务」按钮左侧，与其以分割线相隔 */}
      <div className="relative shrink-0">
        <Tooltip label={`审批策略：${MODE_LABEL[p.mode]}`} side="bottom">
          <button
            onClick={() => setModeMenu((v) => !v)}
            className="flex h-7 cursor-pointer items-center gap-1.5 rounded-full bg-surface2 px-2.5 text-xs font-medium text-t2"
          >
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${MODE_DOT[p.mode]}`} />
            {MODE_SHORT[p.mode]}
          </button>
        </Tooltip>
        {modeMenu && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setModeMenu(false)} />
            <div className="absolute left-0 top-full z-50 mt-1.5 w-44 overflow-hidden rounded-xl border border-line bg-surface shadow-lg">
              <div className="border-b border-line px-3.5 py-2 text-xs text-t4">切换审批模式</div>
              {(Object.keys(MODE_LABEL) as ApprovalMode[]).map((m) => (
                <Tooltip key={m} label={MODE_LABEL[m]} side="right" className="w-full">
                  <button
                    onClick={() => {
                      setModeMenu(false)
                      if (m !== p.mode) p.onMode(m)
                    }}
                    className={`flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs transition-colors hover:bg-hover ${
                      m === p.mode ? "text-accent" : "text-t2"
                    }`}
                  >
                    <span className={`w-3.5 shrink-0 ${m === p.mode ? "" : "invisible"}`}>✓</span>
                    <span className="shrink-0 font-medium">{MODE_SHORT[m]}</span>
                  </button>
                </Tooltip>
              ))}
            </div>
          </>
        )}
      </div>

      <span className="h-5 w-px shrink-0 bg-line" />

      {/* 右侧面板：任务 / 子代理 / 文档（互斥展开） */}
      <Tooltip label="任务面板" side="bottom">
        <button
          onClick={p.onToggleTasks}
          aria-pressed={p.showTasks}
          className={`flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors ${
            p.showTasks ? "bg-accent-soft text-accent" : "text-t3 hover:bg-hover hover:text-t1"
          }`}
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2.5 8.5l3 3 8-8" />
          </svg>
          任务
          {p.tasks.length > 0 && (
            <span className="tabular-nums opacity-80">
              {done}/{p.tasks.length}
            </span>
          )}
        </button>
      </Tooltip>

      {/* 子代理面板：数字 = 已结束/已派发（任务面板同款进度式）；有在跑/待消化的子代理时按钮前是 spinner */}
      <Tooltip label={subTip} side="bottom">
        <button
          onClick={p.onToggleSubagents}
          aria-pressed={p.showSubagents}
          className={`flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors ${
            p.showSubagents ? "bg-accent-soft text-accent" : "text-t3 hover:bg-hover hover:text-t1"
          }`}
        >
          {subBusy ? (
            <span className="spinner" />
          ) : (
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="3" cy="8" r="1.5" />
              <path d="M4.5 8h7.9" />
              <path d="M5.8 8c2.3 0 2.1-4.6 4.6-4.6h2" />
              <path d="M5.8 8c2.3 0 2.1 4.6 4.6 4.6h2" />
            </svg>
          )}
          子代理
          {sdDispatched > 0 && (
            <span className="tabular-nums opacity-80">
              {sdFinished}/{sdDispatched}
            </span>
          )}
        </button>
      </Tooltip>

      <Tooltip label="文档预览面板" side="bottom">
        <button
          onClick={p.onToggleDocs}
          aria-pressed={p.showDocs}
          className={`flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors ${
            p.showDocs ? "bg-accent-soft text-accent" : "text-t3 hover:bg-hover hover:text-t1"
          }`}
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 2h5l3 3v9H4z" />
            <path d="M9 2v3h3" />
          </svg>
          文档
          {p.docCount > 0 && <span className="tabular-nums opacity-80">{p.docCount}</span>}
        </button>
      </Tooltip>

      <span className="h-5 w-px shrink-0 bg-line" />

      {/* 用量（md 以下隐藏——显隐类留在原 div，Tooltip 嵌套在内容层避免 display 冲突） */}
      <div className="hidden text-xs tabular-nums text-t4 md:block">
        <Tooltip label={`本次会话累计 token（输入 + 输出）：${totalTok.toLocaleString()}`} side="bottom">
          <span className="inline-block">{compactFmt.format(totalTok)} tokens</span>
        </Tooltip>
      </div>

      <span className="h-5 w-px shrink-0 bg-line" />

      {/* 运行状态 / 停止：挂起期停止键必须可达（两轮消化之间 running 可能已复位，可用 suspended 兜住） */}
      {p.running || p.suspended ? (
        <Tooltip label="中断当前运行" side="bottom">
          <button
            onClick={p.onStop}
            className="flex h-7 items-center gap-1.5 rounded-full bg-red-950 px-2.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-900"
          >
            <span className="spinner" />
            停止{p.queued > 0 ? `（队列 ${p.queued}）` : ""}
          </button>
        </Tooltip>
      ) : (
        <Tooltip label="没有正在运行的任务" side="left">
          <span className="flex h-7 items-center gap-1.5 pr-1 text-xs text-t4">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
            空闲
          </span>
        </Tooltip>
      )}
    </header>
  )
}
