interface Props {
  items: string[]
  onPick: (text: string) => void
}

/**
 * 一轮结束后的追问建议：对话流尾部的**建议卡片**（贴合内容宽度、右侧一枚细箭头、无边框），
 * 点击**填入输入框**（可编辑后再发送，不直接提交）。
 * 空数组时不渲染任何东西——没有建议就等于没这功能（不占位、不留白条）。
 */
export default function SuggestChips({ items, onPick }: Props) {
  if (items.length === 0) return null
  return (
    <div className="rise flex flex-col items-start gap-3 pl-9">
      {items.map((t) => (
        <button
          key={t}
          type="button"
          // 与斜线命令菜单同款：按下即阻止默认，避免点击抢走 textarea 焦点（否则点完卡片光标就丢了）
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(t)}
          className="flex max-w-full items-center gap-3 rounded-[8px] bg-surface2 px-3 py-2 text-left text-sm text-t3 transition-colors hover:bg-hover hover:text-t1"
        >
          <span className="min-w-0 break-words">{t}</span>
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0 opacity-70"
            aria-hidden="true"
          >
            <path d="M2.5 8h11" />
            <path d="M9 3.5 13.5 8 9 12.5" />
          </svg>
        </button>
      ))}
    </div>
  )
}
