import { useEffect, useMemo, useState } from "react"
import { api } from "../lib/api"
import type { SessionListInfo } from "../lib/types"
import Tooltip from "./Tooltip"

interface Props {
  projects: string[]
  project: string | null
  running: boolean
  /** 各项目运行状态（跨项目并行时，运行中的项目行显示指示器） */
  busyMap: Record<string, boolean>
  /** 外部刷新驱动（会话操作 / rewound 事件后 +1，立即重拉列表） */
  refreshTick: number
  onClose: () => void
  onSelectProject: (dir: string) => void
  onAddProject: () => void
  onNew: (dir: string) => void
  onSwitch: (slot: number) => void
  onDelete: (slot: number) => void
  onRemove: (dir: string) => void
}

/** 仅显示最后一个子目录名；完整路径由调用处的 Tooltip 提供悬浮提示 */
const short = (dir: string) => {
  const parts = dir.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : dir
}

const relTime = (ts: number | null | undefined) => {
  if (!ts) return ""
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return "刚刚"
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return new Date(ts).toLocaleDateString()
}

/** 左侧面板：项目分组 + 历史会话列表（当前会话 + 归档槽位） */
export default function HistoryPanel({
  projects,
  project,
  running,
  busyMap,
  refreshTick,
  onClose,
  onSelectProject,
  onAddProject,
  onNew,
  onSwitch,
  onDelete,
  onRemove,
}: Props) {
  const [info, setInfo] = useState<SessionListInfo | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const load = () => {
    if (!project) {
      setInfo(null)
      return
    }
    api
      .sessions(project)
      .then((r) => {
        setInfo(r)
        setErr(null)
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }

  useEffect(load, [project, refreshTick])

  // 运行结束后刷新一次（消息数/预览会变）
  useEffect(() => {
    if (!running) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running])

  const total = useMemo(() => (info ? info.slots.length + (info.current.msgs > 0 ? 1 : 0) : 0), [info])

  const toggle = (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] }))

  return (
    <aside className="flex w-[264px] shrink-0 flex-col border-r border-line bg-nav">
      {/* 头部 */}
      <div className="flex h-14 shrink-0 items-center gap-2 px-3.5">
        <span className="text-xs font-semibold tracking-[-0.01em] text-t1">历史</span>
        {total > 0 && <span className="text-xs tabular-nums text-t4">{total}</span>}
        <div className="flex-1" />
        {/* ＋ 右补 8px：与折叠钮总间距 16px，使其中心落在 72px 基准——与下方项目行控制簇的「＋」同轴 */}
        <Tooltip label="添加项目目录" side="right" className="mr-2">
          <button
            onClick={onAddProject}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-sm text-t3 transition-colors hover:bg-hover hover:text-t1"
          >
            ＋
          </button>
        </Tooltip>
        <Tooltip label="收起面板" side="right">
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-t4 transition-colors hover:bg-hover hover:text-t1"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 4 6 8l4 4" />
            </svg>
          </button>
        </Tooltip>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-3">
        {projects.length === 0 && (
          <div className="px-2.5 py-8 text-center text-xs leading-relaxed text-t4">
            还没有项目。
            <br />
            添加一个目录开始协作。
          </div>
        )}

        {/* 项目分组 */}
        {projects.map((dir) => {
          const active = dir === project
          const open = !collapsed[dir]
          return (
            <div key={dir} className="mb-1.5">
              <div
                className={`group flex items-center gap-1.5 rounded-lg px-1.5 py-1.5 transition-colors ${
                  active ? "bg-surface" : "hover:bg-hover"
                }`}
              >
                <Tooltip label={open ? "折叠" : "展开"} side="bottom">
                  <button
                    onClick={() => toggle(dir)}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-t4 transition-colors hover:text-t2"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      className={`h-3 w-3 transition-transform ${open ? "rotate-90" : ""}`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M6 4l4 4-4 4" />
                    </svg>
                  </button>
                </Tooltip>
                <Tooltip label={dir} side="bottom" className="min-w-0 flex-1">
                  <button
                    onClick={() => onSelectProject(dir)}
                    className="flex min-w-0 w-full items-center gap-1.5 text-left"
                  >
                  <span className={`text-xs leading-none ${active ? "text-accent" : "text-t4"}`}>
                    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3l1.5 1.5H13a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 13 12.5H3A1.5 1.5 0 0 1 1.5 11z" />
                    </svg>
                  </span>
                  <span className={`truncate text-xs ${active ? "font-medium text-t1" : "text-t2"}`}>{short(dir)}</span>
                  </button>
                </Tooltip>
                {/* 右侧控制簇：三控件等宽 20px、等间距（gap-1），删除按钮严格居中；「＋」中轴 72px 与头部「＋」同轴 */}
                <div className="flex shrink-0 items-center gap-1">
                  {/* 给该项目新建会话（当前会话自动归档）；当前项目常显，其它行悬停显示。
                      锁按项目粒度（与服务端 409 同口径）：只锁本行项目运行中，其它项目运行不受影响。
                      隐藏用 invisible 而非 opacity-0：disabled:opacity-40 在样式表序上会顶掉 opacity-0，导致运行中集体显形 */}
                  <Tooltip label="新建会话（当前会话自动归档）" side="bottom">
                    <button
                      onClick={() => onNew(dir)}
                      disabled={Boolean(busyMap[dir])}
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-t4 transition-colors hover:bg-surface hover:text-t1 focus:visible disabled:opacity-40 ${
                        active ? "visible" : "invisible group-hover:visible"
                      }`}
                    >
                      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                        <path d="M8 3.5v9M3.5 8h9" />
                      </svg>
                    </button>
                  </Tooltip>
                  {/* 移除项目：移出历史面板并清除该项目在 thincoder 中的会话历史（目录文件保留） */}
                  <Tooltip label="移除项目（目录文件保留，仅清除会话历史）" side="bottom">
                    <button
                      onClick={() => onRemove(dir)}
                      disabled={Boolean(busyMap[dir])}
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-t4 invisible transition-colors hover:bg-surface hover:text-red-400 focus:visible disabled:opacity-40 group-hover:visible"
                    >
                      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 4.5h10M6.5 2.5h3M4.8 4.5l.5 9h5.4l.5-9M6.8 7v4.5M9.2 7v4.5" />
                      </svg>
                    </button>
                  </Tooltip>
                  {/* 运行指示：与按钮等宽 20px 常驻位（空闲时空白，spinner 居中其中），保证三控件中心等距、各项目行按钮位置一致 */}
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                    {busyMap[dir] && (
                      <Tooltip label="该项目有任务运行中" side="bottom">
                        <span className="spinner" />
                      </Tooltip>
                    )}
                  </span>
                </div>
              </div>

              {/* 会话列表（仅当前项目展开） */}
              {open && active && (
                <div className="ml-3.5 mt-0.5 flex flex-col gap-0.5 border-l border-line pl-2">
                  {err && <div className="px-2 py-1.5 text-xs text-red-300">{err}</div>}
                  {!info && !err && <div className="px-2 py-1.5 text-xs text-t4">加载中…</div>}

                  {info && (
                    <>
                      {/* 当前会话 */}
                      <button
                        onClick={() => {}}
                        className="flex items-start gap-2 rounded-lg bg-accent-soft px-2 py-1.5 text-left"
                      >
                        <span className="mt-0.5 shrink-0 text-accent">
                          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M13.5 8A5.5 5.5 0 0 1 8 13.5H3.5l1.2-1.7A5.5 5.5 0 1 1 13.5 8z" />
                          </svg>
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs text-t1">
                            {info.current.preview || "（空会话）"}
                          </span>
                          <span className="mt-0.5 block text-xs text-t4">
                            当前 · {info.current.msgs} 条
                            {info.current.updatedAt ? ` · ${relTime(info.current.updatedAt)}` : ""}
                          </span>
                        </span>
                      </button>

                      {/* 归档槽位：点条目标题=恢复该槽位；右侧 × =删除该存档 */}
                      {info.slots.map((s) => (
                        <div
                          key={s.slot}
                          className="group flex items-start gap-1 rounded-lg px-2 py-1.5 transition-colors hover:bg-hover"
                        >
                          <Tooltip label={`恢复槽位 #${s.slot}`} side="bottom" className="min-w-0 flex-1">
                            <button
                              onClick={() => onSwitch(s.slot)}
                              disabled={running}
                              className="flex min-w-0 w-full items-start gap-2 text-left disabled:opacity-50"
                            >
                            <span className="mt-0.5 shrink-0 text-t4">
                              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M2 3.5h12v3H2zM3 6.5h10V13H3z" />
                                <path d="M6.5 9h3" />
                              </svg>
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs text-t2 group-hover:text-t1">
                                {s.preview || "（空会话）"}
                              </span>
                              <span className="mt-0.5 block text-xs text-t4">
                                #{s.slot} · {s.msgs} 条 · {s.date}
                              </span>
                            </span>
                            </button>
                          </Tooltip>
                          <Tooltip label={`删除归档 #${s.slot}`} side="bottom">
                            <button
                              onClick={() => onDelete(s.slot)}
                              className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-t4 opacity-0 transition-colors hover:bg-surface hover:text-red-400 group-hover:opacity-100"
                            >
                              <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M4 4l8 8M12 4l-8 8" />
                              </svg>
                            </button>
                          </Tooltip>
                        </div>
                      ))}

                      {/* 操作提示（新建会话在项目行的 + 号；新建/切换时当前会话自动归档） */}
                      {running && <div className="px-2 py-1 text-xs text-t4">运行中：会话操作已锁定</div>}
                    </>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </aside>
  )
}
