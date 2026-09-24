import { useEffect, useMemo, useRef, useState } from "react"
import { SLASH_COMMANDS, type SlashCommand } from "../lib/commands"
import DirPicker from "./DirPicker"
import Tooltip from "./Tooltip"

interface Props {
  disabled: boolean
  disabledReason?: string
  running: boolean
  queued: number
  onSubmit: (text: string) => void
  onAbort: () => void
  prefill?: { text: string; nonce: number } | null
}

/** 输入区：Claude 风格 —— 圆润浮起输入框 + 珊瑚色发送键；键入 / 弹出斜线命令菜单 */
export default function Composer({ disabled, disabledReason, running, queued, onSubmit, onAbort, prefill }: Props) {
  const [text, setText] = useState("")
  const [menuOpen, setMenuOpen] = useState(true)
  const [sel, setSel] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)
  const [pickingFile, setPickingFile] = useState(false)

  // 「＋」选文件后把绝对路径插到光标处（含空格的路径加引号）
  const insertPath = (p: string) => {
    setPickingFile(false)
    const snippet = (/\s/.test(p) ? `"${p}"` : p) + " "
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

  // 方案卡「需要调整」等场景的输入框预填
  useEffect(() => {
    if (prefill) {
      setText(prefill.text)
      ref.current?.focus()
    }
  }, [prefill?.nonce]) // eslint-disable-line react-hooks/exhaustive-deps

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
          <Tooltip label="插入文件路径（从磁盘选文件）">
            <button
              onClick={() => setPickingFile(true)}
              disabled={disabled}
              aria-label="插入文件路径（从磁盘选文件）"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-t3 transition-colors hover:bg-hover hover:text-t1 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <svg viewBox="0 0 16 16" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M8 3.5v9M3.5 8h9" />
              </svg>
            </button>
          </Tooltip>

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

          {running ? (
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
