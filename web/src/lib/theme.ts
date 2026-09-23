/**
 * theme.ts — 浅色/深色主题（默认深色）
 * <html class="dark"> = 深色；无 class = 浅色。选择持久化到 localStorage。
 * index.html 里有首屏防闪烁脚本，先于 React 应用主题。
 */

export type Theme = "light" | "dark"

const KEY = "tcw-theme"

export function getInitialTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark"
  } catch {
    return "dark"
  }
}

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark")
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    /* 隐私模式等场景存不上就算了，仅本次生效 */
  }
}
