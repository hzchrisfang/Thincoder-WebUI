import TMark from "./TMark"
import Tooltip from "./Tooltip"
export type View = "chat" | "jobs" | "usage" | "git" | "mcp" | "settings" | "about"

interface Props {
  view: View
  onChange: (v: View) => void
  busy: boolean
  jobNotice: number
  theme: "light" | "dark"
  onToggleTheme: () => void
}

/** 线性图标（1.5px 描边，对齐 WorkBuddy / Trae 的图标语言） */
const ICONS: Record<View | "sun" | "moon", React.ReactNode> = {
  // 对话：对话气泡（替代原来的 ❯ 字符）
  chat: (
    <>
      <path d="M14.5 8.2c0 3-2.9 5.4-6.5 5.4-.7 0-1.4-.1-2-.3L3.5 14.5l.6-2.3A5.2 5.2 0 0 1 1.5 8.2C1.5 5.2 4.4 2.8 8 2.8s6.5 2.4 6.5 5.4z" />
    </>
  ),
  // 定时任务：时钟
  jobs: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.6V8l2.3 1.6" />
    </>
  ),
  // 用量：柱状图
  usage: (
    <>
      <path d="M3 13V8.5M8 13V3.5M13 13v-3" />
    </>
  ),
  // Git：分支
  git: (
    <>
      <circle cx="4.6" cy="3.6" r="1.9" />
      <circle cx="4.6" cy="12.4" r="1.9" />
      <circle cx="11.4" cy="6.2" r="1.9" />
      <path d="M4.6 5.5v4.9M11.4 8.1c0 2.4-2.6 2.4-4.3 3.2" />
    </>
  ),
  // MCP：服务器堆叠
  mcp: (
    <>
      <rect x="2.5" y="2.5" width="11" height="4.6" rx="1.4" />
      <rect x="2.5" y="8.9" width="11" height="4.6" rx="1.4" />
      <path d="M5 4.8h.01M5 11.2h.01" />
    </>
  ),
  // 设置：齿轮
  settings: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.7M8 12.5v1.7M14.2 8h-1.7M3.5 8H1.8M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2M12.4 12.4l-1.2-1.2M4.8 4.8 3.6 3.6" />
    </>
  ),
  // 关于：圆圈 i
  about: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 7.2v3.6" />
      <path d="M8 4.9h.01" />
    </>
  ),
  sun: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.6M8 12.9v1.6M14.5 8h-1.6M3.1 8H1.5M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1M12.6 12.6l-1.1-1.1M4.5 4.5 3.4 3.4" />
    </>
  ),
  moon: <path d="M13.2 9.4A5.6 5.6 0 0 1 6.6 2.8a5.6 5.6 0 1 0 6.6 6.6z" />,
}

const ITEMS: { id: View; label: string; tip?: string }[] = [
  { id: "chat", label: "对话" },
  { id: "jobs", label: "定时", tip: "定时任务" },
  { id: "usage", label: "用量" },
  { id: "git", label: "Git" },
  { id: "mcp", label: "MCP" },
  { id: "settings", label: "设置" },
  { id: "about", label: "关于" },
]

function Icon({ name }: { name: View | "sun" | "moon" }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-[18px] w-[18px]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  )
}

/** 左侧导航轨：Claude 风格暖色侧栏（定时任务完成通知点 + 主题切换） */
export default function NavRail({ view, onChange, busy, jobNotice, theme, onToggleTheme }: Props) {
  return (
    <nav className="flex w-[68px] shrink-0 flex-col items-center gap-1 border-r border-line bg-nav py-4">
      <Tooltip label="thincoder-webui" side="right" className="mb-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent shadow-xs">
          {/* 主 logo：白色 T 字（与启动页 / favicon / 对话空态一致） */}
          <TMark className="h-[20px] w-[20px] text-white" />
        </div>
      </Tooltip>

      {ITEMS.map((it) => {
        const on = view === it.id
        return (
          <Tooltip key={it.id} label={it.tip ?? it.label} side="right" className="rounded-xl">
            <button
              onClick={() => onChange(it.id)}
              aria-current={on ? "page" : undefined}
              className={`relative flex h-[52px] w-[52px] flex-col items-center justify-center gap-1 rounded-xl transition-colors ${
                on ? "bg-surface text-accent shadow-xs" : "text-t4 hover:bg-hover hover:text-t2"
              }`}
            >
              <Icon name={it.id} />
              <span className="text-xs leading-none tracking-tight">{it.label}</span>
              {it.id === "chat" && busy && (
                <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-emerald-400" />
              )}
              {it.id === "jobs" && jobNotice > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-xs font-semibold leading-none text-white">
                  {jobNotice > 9 ? "9+" : jobNotice}
                </span>
              )}
            </button>
          </Tooltip>
        )
      })}

      <div className="flex-1" />

      <Tooltip label={theme === "dark" ? "切换到浅色主题" : "切换到深色主题"} side="right">
        <button
          onClick={onToggleTheme}
          className="flex h-[52px] w-[52px] flex-col items-center justify-center gap-1 rounded-xl text-t4 transition-colors hover:bg-hover hover:text-t2"
        >
          <Icon name={theme === "dark" ? "sun" : "moon"} />
          <span className="text-xs leading-none">{theme === "dark" ? "浅色" : "深色"}</span>
        </button>
      </Tooltip>
    </nav>
  )
}
