import { useState } from "react"
import type { ApprovalMode, ProviderStatus, SubagentItem } from "../lib/types"

interface Props {
  provider: ProviderStatus | null
  /** 模型胶囊菜单「打开模型设置…」/ 未配置态点击 → 进设置页 */
  onOpenSettings: () => void
  /** 菜单点选渠道 → App 调 setActiveProvider + refreshProvider */
  onSwitchProvider: (name: string) => void
  mode: ApprovalMode
  onMode: (m: ApprovalMode) => void
  running: boolean
  queued: number
  usage: { prompt: number; completion: number }
  tasks: { title: string; status: string }[]
  onStop: () => void
  planMode: boolean
  showTasks: boolean
  onToggleTasks: () => void
  /** 子代理面板（agent 派发的子任务进度） */
  subagents: SubagentItem[]
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

/** 用量缩写显示：K / M / B 三级，最多 1 位小数（999,999 → 1M 自动进位）。 */
const compactFmt = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })

/** 顶栏：面板开关 / 模型状态 / 任务 / 文档 / 审批模式 / 运行状态。
    项目与会话管理已收敛到左侧历史面板，这里不再重复。 */
export default function TopBar(p: Props) {
  const done = p.tasks.filter((t) => t.status === "done").length
  const totalTok = p.usage.prompt + p.usage.completion
  const subRunning = p.subagents.filter((s) => s.status === "running").length
  // 模型胶囊：已配置且有多渠道（或想进设置）时可点，弹出渠道切换菜单
  const [provMenu, setProvMenu] = useState(false)
  const provClickable = p.provider !== null

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-bg px-3">
      {/* 左侧面板开关 */}
      <button
        onClick={p.onToggleHistory}
        title={p.showHistory ? "收起历史面板" : "展开历史面板（项目 / 会话）"}
        aria-pressed={p.showHistory}
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition-colors ${
          p.showHistory ? "bg-accent-soft text-accent" : "text-t3 hover:bg-hover hover:text-t1"
        }`}
      >
        <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2" />
          <path d="M6.4 2.8v10.4" />
        </svg>
      </button>

      <span className="h-5 w-px shrink-0 bg-line" />

      {/* 模型状态：状态点 + 模型名（可点击：已配置弹渠道切换菜单，未配置进设置页；文字样式不变） */}
      <div className="relative shrink-0">
        <button
          onClick={() => {
            if (p.provider === null) return // 连接中：无动作
            if (!p.provider.configured) p.onOpenSettings()
            else setProvMenu((v) => !v)
          }}
          className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
            p.provider === null
              ? "bg-surface2 text-t4"
              : p.provider.configured
                ? "bg-emerald-950 text-emerald-300"
                : "bg-red-950 text-red-300"
          } ${provClickable ? "cursor-pointer" : "cursor-default"}`}
          title={p.provider?.baseURL ?? "模型连接状态"}
        >
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              p.provider === null ? "bg-t4/60" : p.provider.configured ? "bg-emerald-400" : "bg-red-400"
            }`}
          />
          {p.provider === null ? "连接中…" : p.provider.configured ? `${p.provider.provider} / ${p.provider.model}` : "未配置模型"}
        </button>
        {provMenu && p.provider?.configured && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setProvMenu(false)} />
            <div className="absolute left-0 top-full z-50 mt-1.5 w-64 overflow-hidden rounded-xl border border-line bg-surface shadow-lg">
              <div className="border-b border-line px-3.5 py-2 text-xs text-t4">切换模型渠道</div>
              {p.provider.providers.map((x) => {
                const active = p.provider?.activeProvider === x.name
                return (
                  <button
                    key={x.name}
                    onClick={() => {
                      setProvMenu(false)
                      if (!active) p.onSwitchProvider(x.name)
                    }}
                    title={`${x.name} / ${x.model}`}
                    className={`flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs transition-colors hover:bg-hover ${
                      active ? "text-accent" : "text-t2"
                    }`}
                  >
                    <span className={`w-3.5 shrink-0 ${active ? "" : "invisible"}`}>✓</span>
                    <span className="shrink-0 font-medium">{x.name}</span>
                    <span className="min-w-0 truncate font-mono text-t4">{x.model}</span>
                  </button>
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

      <div className="flex-1" />

      {/* PLAN 徽标 */}
      {p.planMode && (
        <span
          className="rounded-full bg-sky-950 px-2.5 py-1 text-xs font-semibold tracking-wide text-sky-300"
          title="Plan 模式：只读探索，方案确认前不改文件"
        >
          PLAN
        </span>
      )}

      {/* 右侧面板：任务 / 子代理 / 文档（互斥展开） */}
      <button
        onClick={p.onToggleTasks}
        title="任务面板"
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

      {/* 子代理面板：徽标 = 运行中数量（有运行条目时按钮内是 spinner，与历史面板的运行指示器同款） */}
      <button
        onClick={p.onToggleSubagents}
        title="子代理面板（agent 派发的 explore / coder / 审阅等子任务进度）"
        aria-pressed={p.showSubagents}
        className={`flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors ${
          p.showSubagents ? "bg-accent-soft text-accent" : "text-t3 hover:bg-hover hover:text-t1"
        }`}
      >
        {subRunning > 0 ? (
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
        {p.subagents.length > 0 && (
          <span className="tabular-nums opacity-80">{subRunning > 0 ? subRunning : p.subagents.length}</span>
        )}
      </button>

      <button
        onClick={p.onToggleDocs}
        title="文档预览面板（图片 / 网页 / Markdown）"
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

      <span className="h-5 w-px shrink-0 bg-line" />

      {/* 用量 */}
      <div
        className="hidden text-xs tabular-nums text-t4 md:block"
        title={`本次会话累计 token（输入 + 输出）：${totalTok.toLocaleString()}`}
      >
        {compactFmt.format(totalTok)} tokens
      </div>

      {/* 审批模式 */}
      <select
        value={p.mode}
        onChange={(e) => p.onMode(e.target.value as ApprovalMode)}
        className="h-7 cursor-pointer appearance-none rounded-full border border-line bg-surface2 px-2.5 pr-6 text-xs text-t2 outline-none transition-colors hover:bg-hover focus:border-accent"
        style={{
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%238a8784' stroke-width='1.8' stroke-linecap='round'%3E%3Cpath d='M5 6.5l3 3 3-3'/%3E%3C/svg%3E\")",
          backgroundRepeat: "no-repeat",
          backgroundPosition: "right 6px center",
          backgroundSize: "12px",
        }}
        title={`审批策略（对齐 Codex）：${MODE_LABEL[p.mode]}`}
      >
        {(Object.keys(MODE_LABEL) as ApprovalMode[]).map((m) => (
          <option key={m} value={m}>
            {MODE_SHORT[m]}
          </option>
        ))}
      </select>

      <span className="h-5 w-px shrink-0 bg-line" />

      {/* 运行状态 / 停止 */}
      {p.running ? (
        <button
          onClick={p.onStop}
          className="flex h-7 items-center gap-1.5 rounded-full bg-red-950 px-2.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-900"
          title="中断当前运行"
        >
          <span className="spinner" />
          停止{p.queued > 0 ? `（队列 ${p.queued}）` : ""}
        </button>
      ) : (
        <span className="flex h-7 items-center gap-1.5 pr-1 text-xs text-t4" title="没有正在运行的任务">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
          空闲
        </span>
      )}
    </header>
  )
}
