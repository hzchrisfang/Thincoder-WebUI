/**
 * 子代理角色中文名单源——设置页「子代理模型」区块、顶部【子代理】tooltip、
 * 子代理面板空态文案三处统一引用，保证措辞一处改全局一致。
 * 内核角色槽（agent.subagentModels）+ 审阅（agent.advisor）双体系。
 */
export const SUBAGENT_ROLES = [
  { key: "explore", label: "探索", hint: "只读搜索与分析的子任务（explore）" },
  { key: "coder", label: "编码", hint: "写代码的实现类子任务（coder）" },
  { key: "advisor", label: "审阅", hint: "代码 / 设计评审（advisor）" },
] as const

export type SubagentRoleKey = (typeof SUBAGENT_ROLES)[number]["key"]

/** role 英文原文 → 中文名（未收录的角色如 plan / eng-coder 返回 null，调用方回退原文） */
export function roleLabel(role: string): string | null {
  const hit = SUBAGENT_ROLES.find((r) => r.key === role)
  return hit ? hit.label : null
}
