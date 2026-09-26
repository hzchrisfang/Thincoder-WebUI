/**
 * clipboard.ts — 复制到剪贴板（带降级）
 *
 * 为什么不能直接调 navigator.clipboard：
 * 本服务只跑 http，navigator.clipboard 只在"安全上下文"可用 —— http://localhost 算，
 * 但局域网 http://192.168.x.x:8181 不算，那里 navigator.clipboard 是 undefined，会静默失败。
 * 因此统一走这里：优先 Clipboard API，不可用则退回隐藏 textarea + execCommand。
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false

  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 落到降级路径 */
  }

  try {
    const ta = document.createElement("textarea")
    ta.value = text
    ta.setAttribute("readonly", "")
    ta.style.position = "fixed"
    ta.style.top = "0"
    ta.style.left = "0"
    ta.style.width = "1px"
    ta.style.height = "1px"
    ta.style.padding = "0"
    ta.style.border = "none"
    ta.style.outline = "none"
    ta.style.boxShadow = "none"
    ta.style.background = "transparent"
    ta.style.opacity = "0"
    document.body.appendChild(ta)

    const selection = document.getSelection()
    const saved = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
    ta.focus()
    ta.select()
    ta.setSelectionRange(0, ta.value.length) // iOS Safari 需要
    const okFlag = document.execCommand("copy")
    document.body.removeChild(ta)
    if (selection && saved) {
      selection.removeAllRanges()
      selection.addRange(saved)
    }
    return okFlag
  } catch {
    return false
  }
}
