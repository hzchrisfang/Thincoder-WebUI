import type { ReactNode } from "react"

type Side = "top" | "right" | "bottom" | "left"

/** 提示浮层相对触发元素的定位（浮在窗口内侧：底部元素用 top、左栏用 right） */
const POS: Record<Side, string> = {
  top: "bottom-full left-1/2 -translate-x-1/2 mb-2",
  right: "left-full top-1/2 -translate-y-1/2 ml-2",
  bottom: "top-full left-1/2 -translate-x-1/2 mt-2",
  left: "right-full top-1/2 -translate-y-1/2 mr-2",
}

interface Props {
  /** 空标记/条件提示（如「检查失败：…」只在失败时才有文案）可传 undefined —— 此时只保留包裹层与子元素，不渲染浮层 */
  label?: string
  side?: Side
  /** 附着在包裹层上的附加类（如间距 mb-3） */
  className?: string
  children: ReactNode
}

/**
 * 自定义悬浮提示：纯 CSS（具名组 group/tt 悬停淡入），不依赖浏览器原生 title——
 * Chrome 安装为应用后的独立窗口里，原生 title 提示在贴窗口边缘处（左侧栏 / 输入框底部）不渲染
 * （浏览器标签页正常），DOM 浮层两种窗口形态都可靠且立即出现、跟随主题。
 * 具名组的作用域只到本包裹层——外层元素若也有 group 类（如历史面板行容器）不会串扰本浮层。
 */
export default function Tooltip({ label, side = "top", className, children }: Props) {
  return (
    <span className={`group/tt relative inline-flex ${className ?? ""}`}>
      {children}
      {label != null && (
        <span
          role="tooltip"
          className={`pointer-events-none absolute z-50 whitespace-nowrap rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-t2 opacity-0 shadow-lg transition-opacity duration-150 group-hover/tt:opacity-100 ${POS[side]}`}
        >
          {label}
        </span>
      )}
    </span>
  )
}
