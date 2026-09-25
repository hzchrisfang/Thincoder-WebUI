import { useState } from "react"

type Props = {
  value: string
  onChange: (v: string) => void
  /** 清单状态：null = 尚未拉取。失败时显示 `reason`（服务端映射的一句人话短句）——
   *  `error`（上游原始报文）不上界面，只留给 API 消费方与排查。 */
  list: { ok: boolean; list?: string[]; error?: string; reason?: string } | null
  loading: boolean
  /** 手动（重新）拉取清单；null = 不提供按钮 */
  onReload: (() => void) | null
  placeholder?: string
}

/**
 * 模型字段控件 —— 「有清单就选项、没清单才文本」：输入框照常手输，有清单时给出候选可点选。
 *
 * **大小写纪律**（渠道对模型名大小写敏感度不一：错大小写 → 运行期 400/404）：
 * - 清单命中判定用**精确** `items.includes(value)`——绝不做 toLowerCase/toUpperCase 归一，也不 lowercased 比较；
 * - 写入值恒为「用户所输原样」或「清单条目原样」逐字节相等（本组件不改写 value）；
 * - 唯一的大小写不敏感处是候选**筛选**（输入词过滤显示哪些候选），它只影响「显示哪些候选」，
 *   不改变写入值——见下方 q / candidates。
 */
export default function ModelSelect({ value, onChange, list, loading, onReload, placeholder }: Props) {
  const [open, setOpen] = useState(false)
  // 候选筛选词与字段值分开：**打开面板时恒空**（否则会按当前值把自己筛成唯一候选＝看不到其它模型），
  // 只有用户真敲了字才作为筛选词；取值仍走 onChange(原样文本)，两者互不污染。
  const [query, setQuery] = useState("")
  const items = list?.ok ? list.list ?? [] : []
  // 筛选：大小写不敏感的子串匹配——只决定「显示哪些候选」，写入值不受影响（见上方大小写纪律）
  const trimmed = value.trim() // 与保存端同口径：保存只去前后空白，绝不改大小写
  const q = query.trim().toLowerCase()
  const candidates = q ? items.filter((m) => m.toLowerCase().includes(q)) : items
  const hit = items.includes(trimmed) // 精确大小写敏感命中

  /** 展开面板：仅「由关到开」那一次清筛选词，已展开时的再次点击不清（不打断正在看的候选） */
  const openPanel = () => {
    if (!open) setQuery("")
    setOpen(true)
  }

  // 常驻状态行文案：清单成败 + 命中情况都摆明，失败绝不静默降级成「文本输入」的错觉
  const status = loading
    ? { cls: "text-t4", text: "拉取模型清单中…" }
    : list && list.ok
      ? items.length === 0
        ? { cls: "text-t3", text: "渠道返回了空清单，已按手输值保存" }
        : !trimmed
          ? { cls: "text-t4", text: `尚未选择模型（清单 ${items.length} 项，可点选或直接手输）` }
          : hit
            ? { cls: "text-emerald-400", text: "✓ 在渠道清单中" }
            : {
                cls: "text-amber-400",
                text: `⚠ 不在渠道清单中（清单 ${items.length} 项）——模型名需与渠道完全一致，部分渠道区分大小写`,
              }
      : list
        ? { cls: "text-red-300", text: list.reason ?? "无法拉取清单" }
        : { cls: "text-t4", text: "尚未拉取模型清单" }

  return (
    <div>
      {/* 展开时输入框必须仍在 `fixed inset-0 z-40` 遮罩之上（否则点回输入框只会被遮罩吞掉、无法继续聚焦输入），
          故输入框自身也定位并抬到 z-50；面板是同层 z-50 的后继兄弟，压在其上（两者不重叠）。 */}
      <div className="relative z-50">
        {open && <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />}
        <input
          value={value}
          onChange={(e) => {
            setQuery(e.target.value)
            onChange(e.target.value)
            setOpen(true)
          }}
          onFocus={openPanel}
          onClick={openPanel}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          className="field relative z-50 px-3 py-2 text-xs"
        />
        {open && (
          <div className="absolute left-0 top-full z-50 mt-1.5 max-h-72 w-full overflow-y-auto rounded-xl border border-line bg-surface shadow-lg">
            <div className="sticky top-0 border-b border-line bg-surface px-3.5 py-2 text-xs text-t4">
              {list?.ok ? `清单 ${items.length} 项` : loading ? "拉取模型清单中…" : list ? "清单不可用" : "尚未拉取模型清单"}
            </div>
            {loading && <div className="px-3.5 py-2 text-xs text-t4">拉取模型清单中…</div>}
            {list && !list.ok && <div className="px-3.5 py-2 text-xs text-red-300">{list.reason ?? "无法拉取清单"}</div>}
            {candidates.map((m) => (
              <button
                key={m}
                type="button"
                // 与 SuggestChips 同款：按下即阻止默认，避免点击抢走输入框焦点（否则点完光标就丢）
                onMouseDown={(e) => {
                  e.preventDefault()
                  onChange(m)
                  setOpen(false)
                }}
                className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs text-t2 transition-colors hover:bg-hover"
              >
                <span className="min-w-0 truncate font-mono">{m}</span>
              </button>
            ))}
            {!loading && candidates.length === 0 && (
              <div className="px-3.5 py-2 text-xs text-t4">
                {query.trim()
                  ? list?.ok
                    ? "无匹配候选——已输入的值仍会原样保存"
                    : "尚无清单——已输入的值仍会原样保存"
                  : "可直接手输模型名"}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <span className={`min-w-0 flex-1 text-xs ${status.cls}`}>{status.text}</span>
        {onReload && (
          <button type="button" onClick={onReload} className="btn-ghost shrink-0 px-2 py-0.5 text-xs">
            重新拉取
          </button>
        )}
      </div>
    </div>
  )
}
