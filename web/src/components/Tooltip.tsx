import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"

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
 * 自定义悬浮提示：纯 CSS（具名组 group/tt 悬停显示），不依赖浏览器原生 title——
 * Chrome 安装为应用后的独立窗口里，原生 title 提示在贴窗口边缘处（左侧栏 / 输入框底部）不渲染
 * （浏览器标签页正常），DOM 浮层两种窗口形态都可靠且立即出现、跟随主题。
 * 具名组的作用域只到本包裹层——外层元素若也有 group 类（如历史面板行容器）不会串扰本浮层。
 *
 * **空闲态必须是 `hidden`（display:none）**：浮层若只用 `opacity-0` 隐藏，它仍是一个**真实盒子**，
 * `absolute` 元素会算进祖先滚动容器的可滚动溢出——而 `overflow-y-auto` 的容器按 CSS 规则
 * 另一轴会变成 `auto`，于是长 label（如超长 baseURL）的提示会**直接撑出一条横向滚动条**
 * （2026-09-25 实测：当时设置页供应商行那条 baseURL 提示探出容器右缘 65px——该处提示已按「冗余提示」
 * 在 0.12.0 撤下，这里只留这次测量作为「为什么必须 hidden」的机制证据）。
 * 代价：不再淡入，悬停立即出现（与「立即出现」的初衷一致）。
 *
 * **但它在「可滚动容器内」仍旧不够用**——`absolute` 浮层会算进祖先滚动容器的可滚动溢出，长 label 既被容器裁掉、
 * 又当场撑出横向滚动条（2026-09-26 实测：下拉菜单里浮层左缘 -22px、菜单 scrollW 296 > clientW 239）。
 * 这类场景（下拉菜单 / 侧栏 / 表格单元格）一律改用下方 `FloatingTooltip`。
 */
export default function Tooltip({ label, side = "top", className, children }: Props) {
  return (
    <span className={`group/tt relative inline-flex ${className ?? ""}`}>
      {children}
      {label != null && (
        <span
          role="tooltip"
          className={`pointer-events-none absolute z-50 hidden whitespace-nowrap rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-t2 shadow-lg group-hover/tt:block ${POS[side]}`}
        >
          {label}
        </span>
      )}
    </span>
  )
}

const FLOAT_GAP = 8 // 浮层与触发元素的间距
const FLOAT_EDGE = 8 // 浮层与视口边缘的最小留白
const FLOAT_MAX_W = "min(480px, calc(100vw - 16px))" // 超过就换行——超长模型名必须完整可读，浮层自己不能再截一次
// 配 `width:max-content`（见下）：宽度必须与「落在哪」解耦。否则 `width:auto` 会按「视口右缘减 left」再收缩一次，
// 而那个宽度是定位时还没有的 ⇒ 两趟互相追，钳制结果跟着漂（360px 窄窗实测不稳定：有时左右各留 8px、有时贴死右缘）。

/** 包裹层内是否有**真被截断**的文本（某个 overflow 裁剪的盒子横向溢出了）——只有真截断才值得弹提示：
 *  短名悬停不弹，菜单里划过一行也不闪一层浮层。（`truncate` = overflow:hidden + nowrap ⇒ 横向溢出即被省略号截断）
 *
 *  判据用**严格大于**，**不留给 1px 容差**：溢出一像素时浏览器已经画出省略号（肉眼能看见不全），
 *  而留容差会把这种情形当成「没截断」⇒ 看得见省略号却不弹（用户在「刚好卡在该行宽度的名字」上实测报过）。
 *  反向代价（宽度取整导致多弹一次）可接受：多一个冗余提示不丢信息，少一个提示就是信息丢失。 */
function hasClippedText(root: HTMLElement): boolean {
  const boxes: HTMLElement[] = [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]
  return boxes.some((el) => {
    const ox = getComputedStyle(el).overflowX
    return (ox === "hidden" || ox === "clip") && el.scrollWidth > el.clientWidth
  })
}

/** 量浮层该落在哪（视口坐标系，供 `position:fixed` 用）。
 *  触发元素已滚出视口 ⇒ null，浮层跟着消失（不留一个指向空气的提示）。 */
function placeFloating(trigger: HTMLElement | null, bubble: HTMLElement | null): { left: number; top: number } | null {
  if (!trigger || !bubble) return null
  const t = trigger.getBoundingClientRect()
  if (t.bottom < 0 || t.top > window.innerHeight || t.right < 0 || t.left > window.innerWidth) return null
  const b = bubble.getBoundingClientRect()
  const above = t.top - FLOAT_GAP - b.height // 默认在触发元素上方（与现役 side="top" 同款）；上方放不下就翻到下方
  const below = Math.min(t.bottom + FLOAT_GAP, Math.max(FLOAT_EDGE, window.innerHeight - FLOAT_EDGE - b.height))
  const top = above >= FLOAT_EDGE ? above : below
  const maxLeft = Math.max(FLOAT_EDGE, window.innerWidth - FLOAT_EDGE - b.width)
  const left = Math.min(Math.max(FLOAT_EDGE, t.left + t.width / 2 - b.width / 2), maxLeft)
  return { left: Math.round(left), top: Math.round(Math.max(FLOAT_EDGE, top)) }
}

/**
 * 长文本（模型名 / 路径 / baseURL）的悬停全名提示 —— **可滚动容器里一律用它，别用上方那个纯 CSS 版**。
 *
 * 纯 CSS 版的浮层是触发元素的 `absolute` 子节点，而 `absolute` 浮层算进祖先滚动容器的可滚动溢出：
 * 放进 `overflow-y-auto` 的下拉菜单时，长 label 既被菜单裁掉、又当场撑出一条横向滚动条
 * （2026-09-26 实测：浮层左缘 -22px 露出菜单之外、四角 elementFromPoint 命中 offscreen；菜单 scrollW 296 > clientW 239）。
 * 故本组件换两条路：⓵ **悬停时才挂载**浮层（不悬停 DOM 里根本没有它，不参与任何溢出计算）；
 * ⓶ **`position:fixed` + 视口坐标**（逃出滚动容器的裁剪与溢出，实测四角全中浮层、菜单与页面均无横条）。
 *
 * 三条行为约定：**只在真被截断时才弹**（短名悬停不弹）；**超长 label 换行**显示（不自己再截一次）；
 * **左右恒钳 8px、上下在放得下时钳**（宽度由 `FLOAT_MAX_W` 封顶；高度侧**故意不封顶**——真遇上换行后比视口还高的
 * 极端结果，压高度会把正在展示的全名切掉，比底边越出更糟），悬停期间容器滚动 / 窗口缩放时跟着重算，触发元素滚出视口即隐去。
 *
 * 前置条件：祖先链上不得有 `transform` / `filter`（**含 `backdrop-filter`**）/ `will-change` —— 它们会为 `fixed` 后代建立新的
 * 包含块，浮层会重新被裁或错位。**本组件当前调用点的祖先链已核**（`App.tsx` 壳层、设置页 / 供应商表单、顶栏渠道菜单链上均无此类）。
 * 但本仓另有 6 处弹窗遮罩带 `backdrop-blur-sm`（`DirPicker` / `GitPage` / `JobsPage` / `Modals` / `RollbackDialog` / `SessionPanel`）：
 * **把那类容器里的文本接上本组件前，必须先复核包含块**（`backdrop-filter` 与 `filter` 同类，别只查 `transform`）。
 */
export function FloatingTooltip({ label, className, children }: Omit<Props, "side">) {
  const wrapRef = useRef<HTMLSpanElement>(null)
  const bubRef = useRef<HTMLSpanElement>(null)
  const [showing, setShowing] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // 挂载 / 文本变化后当帧内量坐标（useLayoutEffect 在浏览器绘制前跑 ⇒ 用户看不到「先出现在左上角再跳到正确位置」）。
  // `label` 也要入依赖：菜单在数据回来后（`load()` 刷新 rowModel / current）会重建行，旧坐标会落在新文本上。
  useLayoutEffect(() => {
    if (!showing) return
    const wrap = wrapRef.current
    if (wrap && !hasClippedText(wrap)) {
      setShowing(false) // 新文本已不再截断 ⇒ 收起，不留一个没必要的浮层（下一轮 no-op，不会成环）
      return
    }
    setPos(placeFloating(wrap, bubRef.current))
  }, [showing, label])

  useEffect(() => {
    if (!showing) return
    const onMove = () => setPos(placeFloating(wrapRef.current, bubRef.current))
    window.addEventListener("scroll", onMove, true)
    window.addEventListener("resize", onMove)
    return () => {
      window.removeEventListener("scroll", onMove, true)
      window.removeEventListener("resize", onMove)
    }
  }, [showing])

  const show = () => {
    const wrap = wrapRef.current
    if (label == null || !wrap || !hasClippedText(wrap)) return
    setPos(null) // 先挂载（visibility:hidden，可测量）→ 量完再给坐标，避免用上一次的旧坐标闪一帧
    setShowing(true)
  }

  return (
    <span ref={wrapRef} onMouseEnter={show} onMouseLeave={() => setShowing(false)} className={className}>
      {children}
      {label != null && showing && (
        <span
          ref={bubRef}
          role="tooltip"
          style={{ position: "fixed", width: "max-content", maxWidth: FLOAT_MAX_W, overflowWrap: "anywhere", ...(pos ?? { left: 0, top: 0, visibility: "hidden" }) }}
          className="pointer-events-none z-50 block whitespace-normal rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-t2 shadow-lg"
        >
          {label}
        </span>
      )}
    </span>
  )
}
