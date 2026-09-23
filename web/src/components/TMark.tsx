/** 白色 T 字标识 —— 主 logo 统一符号（导航轨 / 启动页 / 空态 / Agent 头像 / 关于区复用），改样式只改这里 */
export default function TMark({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden="true">
      <path d="M3.6 3.2h8.8v2.2H9.1V12.8H6.9V5.4H3.6z" />
    </svg>
  )
}
