import { useEffect, useMemo, useRef, useState } from "react"
import { api } from "../lib/api"
import { SLASH_COMMANDS, type SlashCommand } from "../lib/commands"
import type { SkillsResponse } from "../lib/types"
import DirPicker from "./DirPicker"
import Tooltip from "./Tooltip"

interface Props {
  disabled: boolean
  disabledReason?: string
  running: boolean
  /** 挂起会话中（后台池仍 live）：停止键让位给发送键——挂起期输入开放且优先执行（D1） */
  suspended: boolean
  queued: number
  /** 当前项目（「＋ → 载入技能」拉技能清单用；null = 只列用户层技能） */
  project: string | null
  onSubmit: (text: string) => void
  onAbort: () => void
  prefill?: { text: string } | null
  /** 预填是「一次性交接」：取用后立刻通知父层清空，否则下次挂载会把过期文本重新倒进输入框 */
  onPrefillTaken: () => void
}

/** 输入区：Claude 风格 —— 圆润浮起输入框 + 珊瑚色发送键；键入 / 弹出斜线命令菜单 */
export default function Composer({ disabled, disabledReason, running, suspended, queued, project, onSubmit, onAbort, prefill, onPrefillTaken }: Props) {
  const [text, setText] = useState("")
  const [menuOpen, setMenuOpen] = useState(true)
  const [sel, setSel] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)
  const [pickingFile, setPickingFile] = useState(false)
  /** 「＋」菜单（用户裁定 2026-09-27：一类功能变两类——插文件路径 / 载入技能） */
  const [addOpen, setAddOpen] = useState(false)
  /** 「＋」菜单的层级：一级两项（插路径 / 调技能），二级才是技能清单（用户裁定 2026-09-28） */
  const [addView, setAddView] = useState<"root" | "skills">("root")
  /** 可载入的技能 = 内核合并结果里的 effective（就是 agent 真能看到的那些；遮蔽行不会进来） */
  const [skills, setSkills] = useState<SkillsResponse["effective"] | null>(null)
  const [skillsErr, setSkillsErr] = useState<string | null>(null)

  /** 把一段文本插到光标处（「＋」两条入口共用同一套光标/选区处理） */
  const insertSnippet = (snippet: string) => {
    const el = ref.current
    if (!el) {
      setText((t) => t + snippet)
      return
    }
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? start
    setText(el.value.slice(0, start) + snippet + el.value.slice(end))
    const pos = start + snippet.length
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(pos, pos)
    })
  }

  // 「＋」选文件后把绝对路径插到光标处（含空格的路径加引号）
  const insertPath = (p: string) => {
    setPickingFile(false)
    insertSnippet((/\s/.test(p) ? `"${p}"` : p) + " ")
  }

  /** 开/关「＋」菜单；首次打开时懒加载技能清单（拉失败只影响二级菜单，不影响插文件路径） */
  const openAdd = () => {
    if (addOpen) {
      setAddOpen(false)
      return
    }
    setAddView("root") // 每次打开都从一级开始
    setAddOpen(true)
  }

  /** 进二级才拉技能清单（用户只想要「插入文档路径」时不发这个请求）；读失败只影响这一个二级菜单 */
  const openSkills = () => {
    setAddView("skills")
    if (skills || skillsErr) return
    void api
      .skills(project)
      .then((r) => setSkills(r.effective))
      .catch((e: unknown) => setSkillsErr(e instanceof Error ? e.message : String(e)))
  }

  /** 点一个技能：把「加载技能「名」」填进输入框——**只填不发**（发不发由用户按发送键决定） */
  const pickSkill = (name: string) => {
    setAddOpen(false)
    insertSnippet(`加载技能「${name}」 `)
  }

  // 方案卡「需要调整」/ 点建议卡 / 回退回填的输入框预填。**一次性交接**：取用后立刻让父层清掉 prefill——
  // 这个 effect 在挂载时也会跑，父层若留着旧值，切走视图再回来（输入框重挂）就会把早已过期的文本重放进来
  useEffect(() => {
    if (!prefill) return
    setText(prefill.text)
    ref.current?.focus()
    onPrefillTaken()
  }, [prefill]) // eslint-disable-line react-hooks/exhaustive-deps

  // 受控 textarea 的唯一事实源是 state：DOM 值若被外部改写（浏览器表单态恢复 / 自动填充等），
  // React 只在「渲染值变化」时才写 DOM，不会自愈——每次渲染后与窗口回焦/可见时各对齐一次
  const textRef = useRef(text)
  const syncDom = () => {
    const el = ref.current
    if (el && el.value !== textRef.current) el.value = textRef.current
  }
  useEffect(() => {
    textRef.current = text
    syncDom()
  })
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") syncDom()
    }
    window.addEventListener("focus", syncDom)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      window.removeEventListener("focus", syncDom)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [])

  // 随内容自适应高度（Claude 式：输入越长，框越高）
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [text])

  // 斜线命令菜单：仅在「/ + 命令名前缀（尚未输入空格参数）」时出现
  const query = /^\/[a-zA-Z]*$/.test(text) ? text.slice(1).toLowerCase() : null
  const matches = useMemo(
    () => (query === null ? [] : SLASH_COMMANDS.filter((c) => c.name.startsWith(query))),
    [query]
  )
  const showMenu = menuOpen && matches.length > 0 && !disabled

  // 每次输入变化重置选择项与关闭态（Esc 关闭后继续输入会重新打开）
  useEffect(() => {
    setSel(0)
    setMenuOpen(true)
  }, [query])

  const run = (t: string) => {
    onSubmit(t)
    setText("")
    ref.current?.focus()
  }

  const choose = (c: SlashCommand) => {
    if (c.takesArgs) {
      // 需要参数的命令：补进输入框待补完（如 /goal set <目标>；<判据>）
      setText(`/${c.name} `)
      setMenuOpen(false)
      ref.current?.focus()
      return
    }
    run(`/${c.name}`)
  }

  const submit = () => {
    const t = text.trim()
    if (!t || disabled) return
    run(t)
  }

  return (
    <div className="shrink-0 px-4 pb-4 pt-1">
      <div className="relative mx-auto w-full max-w-3xl">
        {/* 斜线命令菜单（浮于输入框上方） */}
        {showMenu && (
          <div className="absolute bottom-full left-0 mb-2 w-full overflow-hidden rounded-xl border border-line bg-surface shadow-lg">
            <div className="border-b border-line px-3 py-1.5 text-[11px] text-t4">
              命令 · ↑↓ 选择 · Enter 执行 · Esc 关闭
            </div>
            {matches.map((c, i) => (
              <button
                key={c.name}
                onMouseDown={(e) => {
                  e.preventDefault()
                  choose(c)
                }}
                onMouseEnter={() => setSel(i)}
                className={`flex w-full items-baseline gap-3 px-3 py-2 text-left transition-colors ${
                  i === sel ? "bg-accent-soft" : "hover:bg-hover"
                }`}
              >
                <span className={`w-16 shrink-0 font-mono text-xs ${i === sel ? "text-accent" : "text-t1"}`}>
                  /{c.name}
                </span>
                <span className={`text-xs ${i === sel ? "text-accent" : "text-t4"}`}>{c.desc}</span>
              </button>
            ))}
          </div>
        )}

        <div
          className={`flex items-end gap-2 rounded-[22px] border bg-surface p-2 transition-shadow ${
            disabled ? "border-line opacity-70" : "border-line2 shadow-sm focus-within:border-accent focus-within:shadow-md"
          }`}
        >
          <div className="relative shrink-0">
            <Tooltip label="插入文档路径 / 调用技能">
              <button
                data-add-open
                onClick={openAdd}
                disabled={disabled}
                aria-label="插入文档路径 / 调用技能"
                className="flex h-9 w-9 items-center justify-center rounded-full text-t3 transition-colors hover:bg-hover hover:text-t1 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <svg viewBox="0 0 16 16" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                  <path d="M8 3.5v9M3.5 8h9" />
                </svg>
              </button>
            </Tooltip>
            {addOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setAddOpen(false)} />
                <div
                  data-add="menu"
                  data-add-view={addView}
                  className="absolute bottom-full left-0 z-50 mb-2 max-h-80 w-72 overflow-y-auto rounded-xl border border-line2 bg-surface2 py-1 shadow-lg"
                >
                  {/* 一级只两项（用户裁定 2026-09-28）：插路径 / 调技能；技能清单在二级 */}
                  {addView === "root" ? (
                    <>
                      <button
                        data-add-item="file"
                        onClick={() => {
                          setAddOpen(false)
                          setPickingFile(true)
                        }}
                        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs text-t2 transition-colors hover:bg-hover"
                      >
                        <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M1.5 4.5A1.5 1.5 0 0 1 3 3h3l1.5 1.5H13a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 13 12.5H3A1.5 1.5 0 0 1 1.5 11z" />
                        </svg>
                        插入文档路径
                      </button>
                      <button
                        data-add-item="skills"
                        onClick={openSkills}
                        className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs text-t2 transition-colors hover:bg-hover"
                      >
                        {/* 锤子 = 技能（Lucide hammer，ISC；与左侧导航轨那个技能图标同形——两处一起改） */}
                        <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                          <g transform="scale(0.66667)" strokeWidth="2.4">
                            <path d="m15 12-9.373 9.373a1 1 0 0 1-3.001-3L12 9" />
                            <path d="m18 15 4-4" />
                            <path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172v-.344a2 2 0 0 0-.586-1.414l-1.657-1.657A6 6 0 0 0 12.516 3H9l1.243 1.243A6 6 0 0 1 12 8.485V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5" />
                          </g>
                        </svg>
                        调用技能
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        data-add-item="back"
                        onClick={() => setAddView("root")}
                        className="block w-full px-3 py-2 text-left text-xs text-t3 transition-colors hover:bg-hover"
                      >
                        ← 返回
                      </button>
                      <div className="my-1 border-t border-line" />
                      {skillsErr ? (
                        <div className="px-3 py-1.5 text-xs text-red-300">技能清单读取失败：{skillsErr}</div>
                      ) : skills === null ? (
                        <div className="px-3 py-1.5 text-xs text-t4">读取技能清单…</div>
                      ) : skills.length === 0 ? (
                        <div className="px-3 py-1.5 text-xs text-t4">（还没有技能）</div>
                      ) : (
                        skills.map((s) => (
                          <button
                            key={s.name}
                            data-add-skill={s.name}
                            onClick={() => pickSkill(s.name)}
                            className="block w-full px-3 py-1.5 text-left transition-colors hover:bg-hover"
                          >
                            <span className="block truncate text-xs text-t1">{s.name}</span>
                            <span className="block truncate text-[11px] text-t4">{s.declaredDescription ?? s.description}</span>
                          </button>
                        ))
                      )}
                    </>
                  )}
                </div>
              </>
            )}
          </div>

          <textarea
            ref={ref}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (showMenu) {
                if (e.key === "ArrowDown") {
                  e.preventDefault()
                  setSel((s) => (s + 1) % matches.length)
                  return
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault()
                  setSel((s) => (s - 1 + matches.length) % matches.length)
                  return
                }
                if (e.key === "Escape") {
                  e.preventDefault()
                  setMenuOpen(false)
                  return
                }
                if ((e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) || e.key === "Tab") {
                  e.preventDefault()
                  choose(matches[sel])
                  return
                }
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
            rows={1}
            placeholder={disabled ? (disabledReason ?? "…") : "给 thincoder 派个活…（输入 / 查看命令）"}
            disabled={disabled}
            className="no-focus-ring max-h-[220px] min-h-[40px] w-full resize-none bg-transparent px-2.5 py-2 text-sm leading-relaxed text-t1 outline-none placeholder:text-t4 disabled:cursor-not-allowed"
          />

          {running && !suspended ? (
            <button
              onClick={onAbort}
              className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-red-950 px-4 text-sm font-medium text-red-300 transition-colors hover:bg-red-900"
            >
              <span className="inline-block h-2.5 w-2.5 rounded-[2px] bg-current" />
              停止{queued > 0 ? ` · ${queued}` : ""}
            </button>
          ) : (
            <Tooltip label="发送（Enter）">
              <button
                onClick={submit}
                disabled={disabled || !text.trim()}
                className="btn-primary h-9 w-9 shrink-0 rounded-full !px-0 text-base"
              >
                ↑
              </button>
            </Tooltip>
          )}
        </div>

        {pickingFile && <DirPicker mode="file" onClose={() => setPickingFile(false)} onPick={insertPath} />}

        <div className="mt-2 flex items-center justify-center gap-1.5 text-xs text-t4">
          <span>Enter 发送 · Shift+Enter 换行</span>
          <span className="text-line2">|</span>
          <span>输入 / 查看命令</span>
          <span className="text-line2">|</span>
          <span>副作用操作会先弹审批</span>
        </div>
      </div>
    </div>
  )
}
