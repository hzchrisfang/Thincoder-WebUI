import { useCallback, useEffect, useRef, useState } from "react"
import { api, ApiError } from "./lib/api"
import type { ApprovalMode, PendingApproval, PendingRequest, ProviderStatus, RewindSummary, ServerEvent, Snapshot, SubagentItem, ThinkingInfo, TimelineItem } from "./lib/types"
import TopBar from "./components/TopBar"
import Timeline from "./components/Timeline"
import Composer from "./components/Composer"
import Modals from "./components/Modals"
import SetupPanel from "./components/SetupPanel"
import TaskPanel from "./components/TaskPanel"
import SubagentPanel from "./components/SubagentPanel"
import NavRail, { type View } from "./components/NavRail"
import HistoryPanel from "./components/HistoryPanel"
import DocPanel, { isPreviewable } from "./components/DocPanel"
import RollbackDialog from "./components/RollbackDialog"
import DirPicker from "./components/DirPicker"
import UsagePage from "./components/UsagePage"
import GitPage from "./components/GitPage"
import SettingsPage from "./components/SettingsPage"
import AboutPage from "./components/AboutPage"
import JobsPage from "./components/JobsPage"
import McpPage from "./components/McpPage"
import TMark from "./components/TMark"
import { getInitialTheme, applyTheme, type Theme } from "./lib/theme"
import { unlockAudio, playSound } from "./lib/sound"
import { parseSlash } from "./lib/commands"

let uidCounter = 0
const uid = () => `i${Date.now().toString(36)}_${(uidCounter++).toString(36)}`

/** 面板开合状态持久化（左右面板各自独立记忆） */
const PANEL_KEY = "tcw-panels"
function readPanels(): { left: boolean; right: boolean } {
  try {
    const raw = localStorage.getItem(PANEL_KEY)
    if (raw) {
      const p = JSON.parse(raw) as { left?: boolean; right?: boolean }
      return { left: Boolean(p.left), right: Boolean(p.right) }
    }
  } catch {
    /* 忽略损坏的持久化数据 */
  }
  return { left: false, right: false }
}

/** 上次选中的项目目录（刷新后恢复，避免跳回列表末尾） */
const PROJECT_KEY = "tcw-project"
function readLastProject(): string | null {
  try {
    return localStorage.getItem(PROJECT_KEY)
  } catch {
    return null
  }
}

/** 上次见到的服务启动标识（用于识别「服务重启过」） */
const BOOT_KEY = "tcw-boot"
/**
 * 记录本次服务 boot 标识，返回「是否该默认展开历史面板」。
 * 不一致（服务重启过）或无记录（首次访问 / 清了缓存）→ 展开；同一进程内刷新维持用户上次选择。
 */
function consumeBoot(boot: string): boolean {
  try {
    const last = localStorage.getItem(BOOT_KEY)
    localStorage.setItem(BOOT_KEY, boot)
    return last !== boot
  } catch {
    return false // 隐私模式等写不了 localStorage：不强制展开，保持原行为
  }
}

/** 长任务判定：一轮运行达到此时长（毫秒），run_end 时才响完成音 */
const LONG_TASK_MS = 30_000

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [projects, setProjects] = useState<string[]>([])
  const [project, setProject] = useState<string | null>(null)
  const projectRef = useRef<string | null>(null)
  const [provider, setProvider] = useState<ProviderStatus | null>(null)
  // 思考程度（顶栏选择器）：随项目打开 / 模型切换刷新；supported=false 时 TopBar 不渲染
  const [thinking, setThinking] = useState<ThinkingInfo | null>(null)
  const [items, setItems] = useState<TimelineItem[]>([])
  const itemsRef = useRef<TimelineItem[]>([])
  const streamIdRef = useRef<string | null>(null)
  const [pending, setPending] = useState<PendingRequest[]>([])
  const [running, setRunning] = useState(false)
  const [queued, setQueued] = useState(0)
  const [mode, setModeState] = useState<ApprovalMode>("suggest")
  const [usage, setUsage] = useState({ prompt: 0, completion: 0 })
  // 当前这一轮运行的 token 累计（run_start 清零，run_end 随总结项落进时间线）
  const runUsageRef = useRef({ prompt: 0, completion: 0 })
  const [tasks, setTasks] = useState<{ title: string; status: string }[]>([])
  // 子代理进度（服务端分流 relay 前缀后广播；右栏「子代理」面板的数据源）
  const [subagents, setSubagents] = useState<SubagentItem[]>([])
  // M2
  const [planMode, setPlanMode] = useState(false)
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null)
  // 一轮结束后自动生成的追问建议（服务端旁路生成；纯前端临时态，不落盘）
  const [suggests, setSuggests] = useState<string[]>([])
  // 递增即作废在途请求：清空 / 切项目 / 新回合都 +1，晚到的回包再也写不进来（防串台）
  const suggestSeqRef = useRef(0)
  // 本轮是否异常收尾（停止/暂停/报错）与是否弹过方案卡——两者都不生成建议
  const turnBadRef = useRef(false)
  const planPresentedRef = useRef(false)
  // M3
  const [view, setView] = useState<View>("chat")
  // M4：定时任务（通知计数 + 页面刷新驱动）
  const [jobNotice, setJobNotice] = useState(0)
  const [jobsTick, setJobsTick] = useState(0)
  // MCP 页刷新驱动（安装/重连/延迟冲刷后广播 mcp 事件）
  const [mcpTick, setMcpTick] = useState(0)
  // 左侧历史面板刷新驱动（session_changed / rewound 事件，或本端会话操作后立即 +1）
  const [sessionsTick, setSessionsTick] = useState(0)
  // 各项目运行状态（跨项目并行：历史面板为所有运行中的项目显示指示器）
  const [busyMap, setBusyMap] = useState<Record<string, boolean>>({})
  const busyMapRef = useRef<Record<string, boolean>>({})
  // 切入正在运行的项目会错过水合点之后的流式增量，记下待补的项目，run_end 后重水合一次
  const pendingHealRef = useRef<string | null>(null)
  // 各项目当前一轮运行的开始时刻（长任务完成音判定用）
  const runStartRef = useRef<Record<string, number>>({})
  // 会话回退（复制 / 回退）
  const [rollback, setRollback] = useState<{ rewindId: string; text: string } | null>(null)
  const [pickingDir, setPickingDir] = useState(false)
  const viewRef = useRef<View>("chat")
  viewRef.current = view

  // 左右面板（可关闭，状态持久化）
  const initialPanels = useRef(readPanels())
  const [showHistory, setShowHistory] = useState(initialPanels.current.left)
  const [showDocs, setShowDocs] = useState(initialPanels.current.right)
  const [rightTab, setRightTab] = useState<"tasks" | "subagents" | "docs">("tasks")
  useEffect(() => {
    try {
      localStorage.setItem(PANEL_KEY, JSON.stringify({ left: showHistory, right: showDocs }))
    } catch {
      /* 忽略写入失败（隐私模式等） */
    }
  }, [showHistory, showDocs])

  // 主题（浅色/深色，持久化）
  const [theme, setTheme] = useState<Theme>(getInitialTheme)
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  const commit = (next: TimelineItem[]) => {
    itemsRef.current = next
    setItems(next)
  }

  const pushItem = (item: TimelineItem) => commit([...itemsRef.current, item])

  const notice = (level: "info" | "error" | "warn", text: string, action?: { label: string; kind: "undo-rewind" }) =>
    pushItem({ kind: "notice", id: uid(), level, text, action })

  // ---------- 追问建议（旁路生成，失败静默） ----------

  const clearSuggests = () => {
    suggestSeqRef.current++ // 作废在途回包：清空之后到达的结果一律丢弃
    setSuggests([])
  }

  /** 取时间线里最后一轮问答，请服务端生成 2 条追问建议；没有可用上下文就清空 */
  const loadSuggests = (dir: string) => {
    let user = ""
    let assistant = ""
    const cur = itemsRef.current
    for (let i = cur.length - 1; i >= 0; i--) {
      const it = cur[i]
      if (!assistant && it.kind === "assistant" && it.text.trim()) assistant = it.text
      else if (!user && it.kind === "user" && it.text.trim()) user = it.text
      if (user && assistant) break
    }
    if (!user && !assistant) {
      clearSuggests()
      return
    }
    const n = ++suggestSeqRef.current
    api
      .suggest(dir, { user, assistant, planMode })
      .then((r) => {
        // 期间清空过（新回合 / 切会话）或已切走项目：这份回包作废
        if (suggestSeqRef.current === n && projectRef.current === dir) setSuggests(r.suggestions ?? [])
      })
      .catch(() => {
        /* 静默：没有建议就等于没这功能 */
      })
  }

  // ---------- 事件处理 ----------

  const handleEvent = (ev: ServerEvent) => {
    if (ev.type === "snapshot") {
      const snap = ev as unknown as Snapshot & ServerEvent
      setProjects(snap.projects)
      const bm: Record<string, boolean> = {}
      for (const [dir, st] of Object.entries(snap.active ?? {})) {
        bm[dir] = Boolean(st?.busy)
        // 已在运行的项目（如刷新后重连）：开始时刻未知，记为当前时刻——
        // 只影响长任务判定偏保守（需再跑满 30s 才响），无副作用
        if (st?.busy && !runStartRef.current[dir]) runStartRef.current[dir] = Date.now()
      }
      busyMapRef.current = bm
      setBusyMap(bm)
      const cur = projectRef.current
      if (cur && snap.projects.includes(cur)) {
        const st = snap.active[cur]
        setRunning(st?.busy ?? false)
        setQueued(st?.queued ?? 0)
        if (st?.mode) setModeState(st.mode)
        setPlanMode(Boolean(st?.planMode))
        if (st?.provider) setProvider(st.provider)
        setSubagents(snap.subagents?.[cur] ?? []) // 子代理面板播种（刷新/重连时恢复）
      }
      // 挂起审批/提问按全项目播种（原只播当前项目——后台项目挂起时，切回去也看不到弹窗）
      setPending([
        ...snap.pendingApprovals.map((p) => ({
          reqType: "approval" as const,
          ...p,
          mode: snap.active[p.project]?.mode ?? ("suggest" as ApprovalMode),
        })),
        ...snap.pendingQuestions.map((q) => ({ reqType: "question" as const, ...q })),
      ])
      return
    }
    // 运行状态不按项目过滤：后台项目也要维护 busyMap（历史面板指示器依赖它）
    if (ev.type === "run_start" || ev.type === "run_end") {
      const p = String(ev.project ?? "")
      if (ev.type === "run_start") runStartRef.current[p] = Date.now()
      if (p) {
        busyMapRef.current = { ...busyMapRef.current, [p]: ev.type === "run_start" }
        setBusyMap(busyMapRef.current)
      }
    }
    // 审批/提问不按项目过滤（跨项目死锁修复）：后台项目挂起审批时若丢弃事件，
    // 弹窗永远不弹、切回项目时也不恢复（pending 只在快照播种一次），项目永久转圈。
    // 弹窗全局可见 + 项目名徽标（方案 A，用户拍板 2026-09-23）；提示音与后台项目完成音同口径。
    if (ev.type === "permission_request") {
      // 弹窗提示音（snapshot 水合不经过这里，只有新弹窗才响）
      playSound("alert")
      setPending((p) => [
        ...p,
        {
          reqType: "approval" as const,
          reqId: String(ev.reqId),
          project: String(ev.project),
          name: String(ev.name),
          args: (ev.args as Record<string, unknown>) ?? {},
          mode: (ev.mode as ApprovalMode) ?? "suggest",
          diff: (ev.diff as PendingApproval["diff"]) ?? null,
        },
      ])
      return
    }
    if (ev.type === "question") {
      playSound("alert")
      setPending((p) => [
        ...p,
        {
          reqType: "question" as const,
          reqId: String(ev.reqId),
          project: String(ev.project),
          question: String(ev.question),
          options: (ev.options as string[]) ?? [],
        },
      ])
      return
    }
    if (ev.type === "decision" || ev.type === "answered") {
      // 不按项目过滤：审批/提问全局入列后，裁定事件同样要全局出列
      setPending((p) => p.filter((x) => x.reqId !== ev.reqId))
      return
    }
    if (ev.project && ev.project !== projectRef.current) return

    switch (ev.type) {
      case "token": {
        const text = String(ev.text ?? "")
        const id = streamIdRef.current
        const cur = itemsRef.current
        if (id) {
          commit(cur.map((it) => (it.kind === "assistant" && it.id === id ? { ...it, text: it.text + text } : it)))
        } else {
          const nid = uid()
          streamIdRef.current = nid
          commit([...cur, { kind: "assistant", id: nid, text, reasoning: "", done: false }])
        }
        break
      }
      case "reasoning": {
        const text = String(ev.text ?? "")
        const id = streamIdRef.current
        const cur = itemsRef.current
        if (id) {
          commit(cur.map((it) => (it.kind === "assistant" && it.id === id ? { ...it, reasoning: it.reasoning + text } : it)))
        } else {
          const nid = uid()
          streamIdRef.current = nid
          commit([...cur, { kind: "assistant", id: nid, text: "", reasoning: text, done: false }])
        }
        break
      }
      case "tool_call": {
        streamIdRef.current = null
        pushItem({
          kind: "tool",
          id: uid(),
          tool: {
            callId: String(ev.callId),
            name: String(ev.name),
            args: (ev.args as Record<string, unknown>) ?? {},
            state: "running",
          },
        })
        break
      }
      case "tool_result": {
        const callId = String(ev.callId)
        commit(
          itemsRef.current.map((it) =>
            it.kind === "tool" && it.tool.callId === callId
              ? {
                  ...it,
                  tool: {
                    ...it.tool,
                    state: ev.isError ? "error" : "ok",
                    preview: String(ev.preview ?? ""),
                    truncated: Boolean(ev.truncated),
                    fullLength: Number(ev.fullLength ?? 0),
                  },
                }
              : it
          )
        )
        break
      }
      case "tool_output": {
        // 挂到最近一个同名运行中的工具卡（bash 实时输出）
        const name = String(ev.name)
        const chunk = String(ev.chunk ?? "")
        const cur = [...itemsRef.current]
        for (let i = cur.length - 1; i >= 0; i--) {
          const it = cur[i]
          if (it.kind === "tool" && it.tool.name === name && it.tool.state === "running") {
            cur[i] = { ...it, tool: { ...it.tool, output: ((it.tool.output ?? "") + chunk).slice(-8000) } }
            break
          }
        }
        commit(cur)
        break
      }
      case "task_update":
        setTasks(((ev.items as { title: string; status: string }[]) ?? []).map((t) => ({ title: t.title, status: t.status })))
        break
      case "subagents_update":
        // 只吃当前项目（上方 project 过滤已挡住其它项目；服务端每次下发全量 items）
        setSubagents((ev.items as SubagentItem[]) ?? [])
        break
      case "usage": {
        const u = (ev.usage as Record<string, number>) ?? {}
        runUsageRef.current.prompt += u.prompt_tokens ?? 0
        runUsageRef.current.completion += u.completion_tokens ?? 0
        setUsage((prev) => ({
          prompt: prev.prompt + (u.prompt_tokens ?? 0),
          completion: prev.completion + (u.completion_tokens ?? 0),
        }))
        break
      }
      case "compress":
        notice("info", "上下文过长，内核已自动压缩（早期对话由 LLM 摘要）")
        break
      case "queued":
        setQueued(Number(ev.queued ?? 0))
        break
      case "run_start":
        setRunning(true)
        setQueued(Number(ev.queued ?? 0))
        runUsageRef.current = { prompt: 0, completion: 0 }
        // 新回合开始：上一轮的建议立刻失效（它指向的是上一轮的上下文），异常标记复位
        turnBadRef.current = false
        clearSuggests()
        break
      case "run_end": {
        // 长任务完成音：这一轮跑满 30s 才响（短问答不吵）；后台项目跑完也响
        const startedAt = runStartRef.current[String(ev.project ?? "")]
        delete runStartRef.current[String(ev.project ?? "")]
        if (startedAt && Date.now() - startedAt >= LONG_TASK_MS) playSound("done")
        setRunning(false)
        setQueued(Number(ev.queued ?? 0))
        streamIdRef.current = null
        // 一轮收尾：落一条总结（完成时间 + 该轮 token 消耗）
        pushItem({
          kind: "runEnd",
          id: uid(),
          ts: Number(ev.ts ?? Date.now()),
          prompt: runUsageRef.current.prompt,
          completion: runUsageRef.current.completion,
        })
        runUsageRef.current = { prompt: 0, completion: 0 }
        // 这一轮开始前打了回退点，结束后同步一下，让刚发出那条消息的回退按钮可用；
        // 若是切入运行中项目后收的尾，先重水合补齐错过的增量，再对回退点
        if (ev.project === projectRef.current) {
          if (pendingHealRef.current === ev.project) {
            pendingHealRef.current = null
            hydrateHistory(ev.project as string, () => syncRewindIds(ev.project as string))
          } else {
            void syncRewindIds(ev.project as string)
          }
        }
        // 追问建议只在「正常收尾」时生成：异常收尾（停止/暂停/报错）上下文不完整；
        // 本轮弹了方案卡也不生成（方案卡自带「批准/调整」，再叠一层 chips 是噪声）
        const clean = !turnBadRef.current && !planPresentedRef.current
        planPresentedRef.current = false
        const endDir = String(ev.project ?? "")
        if (clean && endDir && endDir === projectRef.current) loadSuggests(endDir)
        break
      }
      case "done":
        closeStream()
        break
      case "aborted":
        closeStream()
        turnBadRef.current = true // 异常收尾：本轮不生成追问建议
        notice("warn", "已手动停止")
        break
      case "paused":
        closeStream()
        turnBadRef.current = true
        notice("warn", String(ev.message ?? "已暂停"))
        break
      case "error":
        closeStream()
        turnBadRef.current = true
        notice("error", String(ev.message ?? "发生错误"))
        break
      case "mode":
        if (ev.project === projectRef.current) setModeState((ev.mode as ApprovalMode) ?? "suggest")
        break
      case "system":
        notice("info", String(ev.text ?? ""))
        break
      case "plan_mode":
        setPlanMode(Boolean(ev.planMode))
        if (ev.planMode) notice("info", "已进入 Plan 模式：只读探索，不动文件")
        break
      case "plan_presented": {
        closeStream()
        planPresentedRef.current = true // 本轮已有方案卡：run_end 后不再生成追问建议
        setPlanMode(false)
        const plan = String(ev.plan ?? "")
        if (plan) pushItem({ kind: "plan", id: uid(), plan })
        break
      }
      case "session_changed":
        setSessionsTick((t) => t + 1) // 左侧历史面板立刻刷新（新建/切换/删除槽位）
        clearSuggests() // 切/新建会话后旧建议指向的是上一个会话的上下文
        if (ev.project === projectRef.current) hydrateHistory(ev.project as string)
        break
      case "rewound": {
        const undo = Boolean(ev.undo)
        setSessionsTick((t) => t + 1) // 回退会改写会话文件，历史面板同步刷新
        clearSuggests() // 回退后时间线变了，旧建议已失效
        if (Array.isArray(ev.tasks)) setTasks((ev.tasks as { title: string; status: string }[]).map((t) => ({ title: t.title, status: t.status })))
        setPlanMode(Boolean(ev.planMode))
        setRollback(null)
        if (ev.project !== projectRef.current) break
        if (undo) {
          hydrateHistory(ev.project as string, () => notice("info", "已撤销回退，工作区与会话恢复为回退前的状态"))
        } else {
          const parts = [`已回退到该消息之前：移除 ${Number(ev.messages ?? 0)} 条会话消息`]
          if (Number(ev.files)) parts.push(`还原 ${Number(ev.files)} 个文件`)
          if (Number(ev.removed)) parts.push(`删除 ${Number(ev.removed)} 个新建文件`)
          if (Number(ev.cleared)) parts.push(`丢弃 ${Number(ev.cleared)} 条待发消息`)
          const degraded = ev.degraded ? String(ev.degraded) : null
          if (degraded) parts.push(`文件未回退（${degraded}）`)
          hydrateHistory(ev.project as string, () =>
            notice(degraded ? "warn" : "info", parts.join("，"), { label: "撤销回退", kind: "undo-rewind" })
          )
        }
        break
      }
      case "job_started":
        setJobsTick((t) => t + 1)
        break
      case "job_retry":
        setJobsTick((t) => t + 1)
        if (viewRef.current !== "jobs") setJobNotice((n) => n + 1)
        break
      case "job_done":
        setJobsTick((t) => t + 1)
        if (viewRef.current !== "jobs") setJobNotice((n) => n + 1)
        break
      case "mcp":
        setMcpTick((t) => t + 1)
        break
      default:
        break
    }
  }

  const closeStream = () => {
    const id = streamIdRef.current
    streamIdRef.current = null
    if (id) {
      commit(itemsRef.current.map((it) => (it.kind === "assistant" && it.id === id ? { ...it, done: true } : it)))
    }
  }

  const handleEventRef = useRef(handleEvent)
  handleEventRef.current = handleEvent

  // ---------- SSE 订阅 ----------

  useEffect(() => {
    const es = new EventSource("/api/events")
    es.onmessage = (e) => {
      try {
        handleEventRef.current(JSON.parse(e.data) as ServerEvent)
      } catch {
        /* 忽略坏事件 */
      }
    }
    es.onerror = () => {
      /* EventSource 自动重连；401 时由初始化检查兜底 */
    }
    return () => es.close()
  }, [])

  // ---------- 初始化 ----------

  // 提示音解锁：首次用户手势的同步栈里创建 AudioContext（Chrome 自动播放策略），
  // 一次性监听，解锁即摘除
  useEffect(() => {
    const unlock = () => {
      unlockAudio()
      window.removeEventListener("pointerdown", unlock)
      window.removeEventListener("keydown", unlock)
    }
    window.addEventListener("pointerdown", unlock, { once: true })
    window.addEventListener("keydown", unlock, { once: true })
    return () => {
      window.removeEventListener("pointerdown", unlock)
      window.removeEventListener("keydown", unlock)
    }
  }, [])

  useEffect(() => {
    ;(async () => {
      try {
        const ver = await api.version()
        // 服务重启过（boot 变化）或首次访问 → 默认展开历史面板；
        // 同一进程内刷新维持用户上次的收/展选择（readPanels 的记忆优先）
        if (consumeBoot(ver.boot)) setShowHistory(true)
        setAuthed(true)
        const { projects: list } = await api.projects()
        const dirs = list.map((p) => p.dir)
        setProjects(dirs)
        if (dirs.length > 0) {
          // 恢复上次选中的项目；不在列表里（已删除/首次访问）才回落到列表末尾
          const last = readLastProject()
          selectProject(last && dirs.includes(last) ? last : dirs[dirs.length - 1])
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) setAuthed(false)
        else setAuthed(true)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectProject = (dir: string) => {
    setProject(dir)
    projectRef.current = dir
    // 目标项目正在运行：等它 run_end 后重水合一次，补齐切入期间错过的流式增量
    pendingHealRef.current = busyMapRef.current[dir] ? dir : null
    try {
      localStorage.setItem(PROJECT_KEY, dir)
    } catch {
      /* 忽略写入失败（隐私模式等） */
    }
    // 运行状态跟随项目：snapshot 仅在 SSE 建连时下发，切换项目必须就地纠正，
    // 否则沿用上个项目的 running（busyMap 已由 snapshot + run_start/run_end 维护全项目状态）
    setRunning(Boolean(busyMapRef.current[dir]))
    setQueued(0)
    commit([])
    streamIdRef.current = null
    // pending 不清：审批/提问弹窗是全局的（跨项目可见），切项目后仍在等待的项目弹窗要保留
    setTasks([])
    setSubagents([]) // 切项目：上一个项目的子代理进度不带过去（等着本项目的广播/快照）
    setUsage({ prompt: 0, completion: 0 })
    setProvider(null)
    setPlanMode(false)
    setRollback(null)
    clearSuggests() // 切项目：旧建议属于上一个项目的上下文
    api
      .open(dir)
      .then((r) => {
        setProvider(r.provider)
        hydrateHistory(dir)
      })
      .catch((e) => notice("error", `打开项目失败：${e.message}`))
  }

  /** M2：从服务端重建时间线（恢复会话 / 刷新页面均走这里）。after 在水合落地后执行，保证提示不被覆盖 */
  const hydrateHistory = (dir: string, after?: () => void) => {
    api
      .history(dir)
      .then((r) => {
        if (projectRef.current !== dir) return
        streamIdRef.current = null
        commit(r.items)
        after?.()
      })
      .catch(() => {})
  }

  /**
   * 把服务端的回退点对到本地时间线的用户消息上（顺序 + 前缀匹配）。
   * 好处是不用水合就能启用刚发出那条消息的回退按钮，本地的时间线内容也不会被冲掉。
   */
  const syncRewindIds = async (dir: string) => {
    try {
      const { points } = await api.rewindPoints(dir)
      if (projectRef.current !== dir) return
      let ptr = 0
      commit(
        itemsRef.current.map((it) => {
          if (it.kind !== "user") return it
          for (let i = ptr; i < points.length; i++) {
            const pv = points[i].preview
            if (pv && it.text.startsWith(pv)) {
              ptr = i + 1
              return { ...it, rewindId: points[i].id }
            }
          }
          return it
        })
      )
    } catch {
      /* 拿不到回退点就保持原样（按钮置灰） */
    }
  }

  // ---------- 会话操作（M2） ----------

  /** 新建会话（当前会话自动归档）；传入 dir 时先切到该项目（项目行的 + 号用） */
  const newSession = async (dir?: string) => {
    const target = dir ?? projectRef.current
    if (!target) return
    try {
      if (target !== projectRef.current) selectProject(target)
      await api.newSession(target)
      setTasks([])
      setPlanMode(false)
      setSessionsTick((t) => t + 1) // 不依赖 SSE 回包，立即刷新历史面板
    } catch (e) {
      notice("error", `新建会话失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const switchSession = async (slot: number) => {
    if (!project) return
    try {
      await api.switchSession(project, slot)
      setTasks([])
      setPlanMode(false)
      setSessionsTick((t) => t + 1)
    } catch (e) {
      notice("error", `切换会话失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const deleteSessionSlot = async (slot: number) => {
    if (!project) return
    if (!window.confirm(`删除归档 #${slot}？该存档会被永久移除（当前会话不受影响）。`)) return
    try {
      await api.deleteSessionSlot(project, slot)
      setSessionsTick((t) => t + 1)
      notice("info", `已删除归档 #${slot}`)
    } catch (e) {
      notice("error", `删除归档失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 移除项目：移出历史面板并清除该项目在 thincoder 中的会话历史（目录内文件保留） */
  const removeProject = async (dir: string) => {
    const name = dir.split(/[\\/]/).filter(Boolean).pop() ?? dir
    if (
      !window.confirm(
        `移除项目「${name}」？\n\n目录内的所有文件都会保留；仅删除 thincoder 中该项目的会话历史（当前会话、归档、回退点、用量记录），且不可恢复。\n引用该目录的定时任务将失效，可在定时页删除。`
      )
    )
      return
    try {
      const { projects: list } = await api.removeProject(dir)
      const dirs = list.map((p) => p.dir)
      setProjects(dirs)
      if (projectRef.current === dir) {
        if (dirs.length > 0) selectProject(dirs[dirs.length - 1])
        else {
          // 清到「无项目」首屏（与初始化 dirs.length === 0 同一状态）
          pendingHealRef.current = null
          setProject(null)
          projectRef.current = null
          try {
            localStorage.removeItem(PROJECT_KEY)
          } catch {
            /* 忽略 */
          }
          setRunning(false)
          setQueued(0)
          commit([])
          streamIdRef.current = null
          setPending([])
          setTasks([])
          setSubagents([])
          setUsage({ prompt: 0, completion: 0 })
          setProvider(null)
          setPlanMode(false)
          setRollback(null)
        }
      }
      setSessionsTick((t) => t + 1)
      notice("info", `已移除「${name}」（目录文件保留）`)
    } catch (e) {
      notice("error", `移除项目失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ---------- 会话回退（复制 / 回退） ----------

  /** 回退弹窗确认后：同步任务/Plan 状态，按需把原文放回输入框 */
  const onRollbackDone = (summary: RewindSummary, restoreToInput: boolean) => {
    const text = rollback?.text ?? ""
    setRollback(null)
    if (Array.isArray(summary.tasks)) setTasks(summary.tasks.map((t) => ({ title: t.title, status: t.status })))
    if (typeof summary.planMode === "boolean") setPlanMode(summary.planMode)
    if (restoreToInput && text) setPrefill({ text, nonce: Date.now() })
    const dir = projectRef.current
    if (dir) void syncRewindIds(dir)
  }

  const undoRewind = async () => {
    const dir = projectRef.current
    if (!dir) return
    try {
      await api.rewindUndo(dir)
    } catch (e) {
      notice("error", `撤销回退失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ---------- 方案卡操作（M2） ----------

  const approvePlan = () => send("批准该方案，请按方案开始实施")
  const adjustPlan = () => setPrefill({ text: "请调整方案：", nonce: Date.now() })

  // ---------- 操作 ----------

  const send = async (text: string) => {
    if (!project) return
    // 已注册的斜线命令：不进 agent 对话，走 /api/command（服务端执行内核 TUI 处理器）；
    // 未注册的 /xxx（如绝对路径 /Users/…）原样按普通消息发送
    const cmd = parseSlash(text)
    if (cmd) {
      pushItem({ kind: "user", id: uid(), text: `/${cmd.name}${cmd.args.length ? ` ${cmd.args.join(" ")}` : ""}`, ts: Date.now() })
      try {
        const r = await api.command(project, cmd.name, cmd.args)
        if (r.ok && cmd.name === "new") {
          setTasks([])
          setPlanMode(false)
        }
        for (const line of r.lines) notice(r.ok ? "info" : "error", line)
      } catch (e) {
        notice("error", `命令执行失败：${e instanceof Error ? e.message : String(e)}`)
      }
      return
    }
    pushItem({ kind: "user", id: uid(), text, ts: Date.now() })
    try {
      await api.chat(project, text)
    } catch (e) {
      notice("error", `发送失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const stop = () => {
    if (project) api.abort(project).catch(() => {})
  }

  const changeMode = (m: ApprovalMode) => {
    if (!project) return
    setModeState(m)
    api.setMode(project, m).catch((e) => notice("error", `切换模式失败：${e.message}`))
  }

  /** 添加项目：打开目录浏览弹窗（资源管理器选目录，替代手填绝对路径） */
  const addProject = () => setPickingDir(true)

  const pickProject = async (dir: string) => {
    setPickingDir(false)
    try {
      const { projects: list } = await api.addProject(dir)
      setProjects(list.map((p) => p.dir))
      selectProject(dir)
    } catch (e) {
      notice("error", `添加项目失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const onDecide = async (reqId: string, allow: boolean, remember: boolean) => {
    setPending((p) => p.filter((x) => x.reqId !== reqId))
    try {
      await api.decide(reqId, allow, remember)
    } catch (e) {
      notice("error", `审批提交失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const onAnswer = async (reqId: string, answer: string) => {
    setPending((p) => p.filter((x) => x.reqId !== reqId))
    try {
      await api.answer(reqId, answer)
    } catch (e) {
      notice("error", `回答提交失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const refreshProvider = useCallback(() => {
    const dir = projectRef.current
    if (!dir) return
    api
      .open(dir)
      .then((r) => setProvider(r.provider))
      .catch(() => {})
  }, [])

  // 思考程度状态刷新：项目变化 / 模型切换后重取（档位枚举随模型走）
  const refreshThinking = useCallback(() => {
    const dir = projectRef.current
    if (!dir) {
      setThinking(null)
      return
    }
    api
      .thinking(dir)
      .then((r) => setThinking(r))
      .catch(() => setThinking(null))
  }, [])

  // 切回对话视图时对齐一次模型状态：设置页切换供应商 / 终端 TUI 改配置 / 多标签操作后都能自愈
  useEffect(() => {
    if (view === "chat") {
      refreshProvider()
      refreshThinking()
    }
  }, [view, refreshProvider, refreshThinking])

  // 项目切换后重取思考档状态
  useEffect(() => {
    refreshThinking()
  }, [project, refreshThinking])

  // ---------- 渲染 ----------

  if (authed === null) {
    return <Splash text="正在连接服务…" />
  }
  if (!authed) {
    return (
      <Splash
        text="未授权访问"
        hint="请使用服务启动时终端打印的登录链接（/login?token=…）进入。"
      />
    )
  }

  const noProject = projects.length === 0

  // 从时间线收集 agent 读写过的文件路径，只保留右侧面板可预览的类型（图片 / 网页 / Markdown）
  const touchedFiles = items.flatMap((it) => {
    if (it.kind !== "tool") return []
    const name = it.tool.name
    if (!/(write|edit|read|create|multi_edit|apply_patch)/i.test(name)) return []
    const a = it.tool.args ?? {}
    const p = (a.path ?? a.file_path ?? a.filePath ?? a.target ?? a.filename) as unknown
    return typeof p === "string" && isPreviewable(p.trim()) ? [p.trim()] : []
  })

  return (
    <div className="flex h-full overflow-x-hidden">
      <NavRail
        view={view}
        onChange={(v) => {
          setView(v)
          if (v === "jobs") setJobNotice(0)
        }}
        busy={running}
        jobNotice={jobNotice}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
      />

      {view === "chat" && showHistory && (
        <HistoryPanel
          projects={projects}
          project={project}
          running={running}
          busyMap={busyMap}
          refreshTick={sessionsTick}
          onClose={() => setShowHistory(false)}
          onSelectProject={selectProject}
          onAddProject={addProject}
          onNew={newSession}
          onSwitch={switchSession}
          onDelete={deleteSessionSlot}
          onRemove={removeProject}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {view === "chat" && (
          <>
            <TopBar
              provider={provider}
              thinking={thinking}
              onThinking={(action, level) => {
                if (!project) return
                api
                  .setThinking(project, action, level)
                  .then((r) => {
                    setThinking(r.after)
                    notice(
                      "info",
                      r.after.autoThink
                        ? "think: auto（内核按任务难度逐轮自动定档）"
                        : r.after.state === "off"
                          ? "think: off"
                          : r.after.state === "on"
                            ? "think: on（服务端默认强度）"
                            : `think: ${r.after.state}`
                    )
                  })
                  .catch((e) => notice("error", `设置思考档位失败：${e instanceof Error ? e.message : String(e)}`))
              }}
              onOpenSettings={() => setView("settings")}
              onSwitchProvider={(name) => {
                api
                  .setActiveProvider(name)
                  .then(() => refreshProvider())
                  .catch((e) => notice("error", `切换模型失败：${e instanceof Error ? e.message : String(e)}`))
              }}
              mode={mode}
              onMode={changeMode}
              running={running}
              queued={queued}
              usage={usage}
              tasks={tasks}
              onStop={stop}
              planMode={planMode}
              showTasks={rightTab === "tasks" && showDocs}
              onToggleTasks={() => {
                if (rightTab === "tasks" && showDocs) setShowDocs(false)
                else {
                  setRightTab("tasks")
                  setShowDocs(true)
                }
              }}
              subagents={subagents}
              showSubagents={rightTab === "subagents" && showDocs}
              onToggleSubagents={() => {
                if (rightTab === "subagents" && showDocs) setShowDocs(false)
                else {
                  setRightTab("subagents")
                  setShowDocs(true)
                }
              }}
              showHistory={showHistory}
              onToggleHistory={() => setShowHistory((v) => !v)}
              showDocs={rightTab === "docs" && showDocs}
              onToggleDocs={() => {
                if (rightTab === "docs" && showDocs) setShowDocs(false)
                else {
                  setRightTab("docs")
                  setShowDocs(true)
                }
              }}
              docCount={touchedFiles.length}
            />

            {/* 左侧内容列（Plan 横幅 / 时间线 / 配置面板 / 输入框）与右侧面板并排：
                输入框属于这一列，因此右侧面板的宽度会直接决定输入框的横向宽度，
                输入框永远停在右侧面板的左边，而不是压在它下方。 */}
            <div className="flex min-h-0 flex-1">
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                {planMode && (
                  <div className="shrink-0 border-b border-sky-800 bg-sky-950 px-4 py-2 text-center text-xs font-medium tracking-wide text-sky-300">
                    PLAN 模式 —— 只读探索中，文件变更会被拒绝，直到方案确认
                  </div>
                )}

                <main className="min-h-0 min-w-0 flex-1">
                  {noProject ? (
                    <EmptyState
                      title="还没有项目"
                      body="添加一个项目目录，即可开始与 thincoder 协作。"
                      action={
                        <button onClick={addProject} className="btn-primary px-4 py-2 text-sm">
                          添加项目
                        </button>
                      }
                    />
                  ) : (
                    <Timeline
                      items={items}
                      running={running}
                      onApprovePlan={approvePlan}
                      onAdjustPlan={adjustPlan}
                      onRollback={(it) => setRollback(it)}
                      onUndoRewind={undoRewind}
                      suggests={suggests}
                      onPickSuggest={(t) => setPrefill({ text: t, nonce: Date.now() })}
                    />
                  )}
                </main>

                {provider && !provider.configured && <SetupPanel onSaved={refreshProvider} />}

                <Composer
                  disabled={!project || (provider ? !provider.configured : false)}
                  disabledReason={!project ? "请先选择项目" : provider && !provider.configured ? "尚未配置模型 API key（见上方配置面板）" : undefined}
                  running={running}
                  queued={queued}
                  onSubmit={send}
                  onAbort={stop}
                  prefill={prefill}
                />
              </div>

              {/* 右侧面板：任务 / 子代理 / 文档预览 三个 tab（贯通 TopBar 以下的整列高度） */}
              {showDocs &&
                (rightTab === "tasks" ? (
                  <TaskPanel tasks={tasks} onClose={() => setShowDocs(false)} />
                ) : rightTab === "subagents" ? (
                  <SubagentPanel items={subagents} onClose={() => setShowDocs(false)} />
                ) : (
                  <DocPanel project={project} files={touchedFiles} onClose={() => setShowDocs(false)} />
                ))}
            </div>
          </>
        )}

        {view === "usage" && <UsagePage />}
        {view === "git" && <GitPage project={project} />}
        {view === "jobs" && <JobsPage projects={projects} refreshTick={jobsTick} />}
        {view === "mcp" && <McpPage project={project} running={running} refreshTick={mcpTick} />}
        {view === "settings" && <SettingsPage onProviderChanged={refreshProvider} />}
        {view === "about" && <AboutPage />}
      </div>

      {pending.length > 0 && (
        <Modals req={pending[0]} queueCount={pending.length} currentProject={project} onDecide={onDecide} onAnswer={onAnswer} />
      )}

      {rollback && project && (
        <RollbackDialog
          project={project}
          rewindId={rollback.rewindId}
          text={rollback.text}
          queued={queued}
          onClose={() => setRollback(null)}
          onDone={onRollbackDone}
        />
      )}

      {pickingDir && <DirPicker onClose={() => setPickingDir(false)} onPick={pickProject} />}
    </div>
  )
}

function Splash({ text, hint }: { text: string; hint?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-bg text-t4">
      <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent shadow-sm">
        <TMark className="h-6 w-6 text-white" />
      </div>
      <div className="spinner" />
      <div className="text-sm">{text}</div>
      {hint && <div className="max-w-md text-center text-xs leading-relaxed text-t4">{hint}</div>}
    </div>
  )
}

function EmptyState({ title, body, action }: { title: string; body: string; action: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2.5">
      <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-xl bg-accent">
        <TMark className="h-5 w-5 text-white" />
      </div>
      <div className="text-lg font-semibold tracking-[-0.01em] text-t1">{title}</div>
      <div className="text-sm text-t3">{body}</div>
      <div className="mt-3">{action}</div>
    </div>
  )
}
