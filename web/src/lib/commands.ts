/**
 * lib/commands.ts — 斜线命令表（WebUI 侧）
 *
 * 命令语义全部由内核 TUI 处理器承担（服务端 /api/command → 薄壳 cmd-*.mjs），
 * 这里只描述「有哪些命令、怎么显示、要不要先收参数」。
 * 加新命令的正确做法：内核 cmd-*.mjs 有了处理器 → 服务端 slashCommands 表登记 → 本表加一行。
 */

export interface SlashCommand {
  name: string
  /** 菜单里的一句话说明 */
  desc: string
  /** true = 菜单选中后先补进输入框待补参数（不立即执行） */
  takesArgs?: boolean
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "plan", desc: "切换 Plan 模式（只读探索，方案确认前不改文件）" },
  { name: "new", desc: "新建会话（当前会话自动归档）" },
  { name: "eng", desc: "切换工程模式（设计评审 → 用户批准 → 实施）" },
  { name: "goal", desc: "长期目标：查看 / 设定 / 取消", takesArgs: true },
  { name: "skills", desc: "列出项目技能（.thincoder/skills/）" },
  { name: "init", desc: "生成 AGENTS.md 骨架" },
]

/**
 * 解析输入框文本是否是一条「已注册」的斜线命令。
 * 仅识别 `/name` 或 `/name args...` 形态且 name 在册——`/绝对路径/…` 这类路径输入
 * 不匹配（name 后紧跟非空白字符），原样按普通消息发送。
 */
export function parseSlash(text: string): { name: string; args: string[] } | null {
  const m = /^\/([a-zA-Z]+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!m) return null
  const name = m[1].toLowerCase()
  if (!SLASH_COMMANDS.some((c) => c.name === name)) return null
  const args = m[2] ? m[2].trim().split(/\s+/).filter(Boolean) : []
  return { name, args }
}
