/**
 * bridge/suggest.mjs — 「一轮对话结束后的追问建议」：提示词构造 + 输出解析 + 编排
 *
 * 为什么单独成档：建议生成是**旁路**小调用（借 chatOnce 直接打模型，不进 agent 会话/上下文/
 * 工具链），与对话链路零耦合——失败一律降级为「没有建议」，绝不向上抛（同内核 generate-title
 * 的 non-fatal 纪律：辅助功能坏了不能影响主流程）。
 *
 * buildSuggestMessages / parseSuggestions 是纯函数（零 IO），供单测直接锁定提示词约束与解析容错。
 */

import { chatOnce } from "./thincoder.mjs"

const USER_MAX = 600 // 用户消息只留开头：追问依赖的是这句的口吻与主题，全文无益
const ASSIST_HEAD = 1500 // 助手回复的头部（结论/要点通常在前）
const ASSIST_TAIL = 500 // 与尾部（「接下来可以…」这类话头常在结尾，两侧都留）
const MAX_ITEM_CHARS = 80 // 单条建议字符上限：模型跑歪（整段解释/代码）时整条丢弃
const MAX_ITEMS = 2 // 用户拍板固定 2 条

/** 超长文本压成「头…尾」——只留头部会丢掉结尾的下一步口吻，只留尾部会丢主题 */
function clipMid(text, head, tail) {
  if (text.length <= head + tail) return text
  return `${text.slice(0, head)}…${text.slice(-tail)}`
}

/**
 * 提示词约束不许松（语言跟随/用户视角/具体/只要 JSON），措辞可微调。
 * 语言跟随是显式要求：中英混用的会话里，建议必须跟最后一轮同语言。
 */
const SYSTEM_PROMPT = `你在帮用户准备下一条要发的消息。根据最后一轮问答，预测用户接下来最可能说的 2 句话。

要求：
- 用最后一轮对话的语言书写（用户说中文就用中文，说英文就用英文）；
- 站在用户视角，写出来就能直接当作下一条消息发送；
- 每条不超过 20 个汉字（英文不超过 8 个词）；
- 具体、针对本轮内容（可以点名文件、函数、结论）；
- 不要泛泛的「继续」「谢谢」这类没有信息量的句子；
- 只输出 JSON 数组，例如 ["帮我看看第二个方案","这个函数要改哪里"]，不要编号、解释或代码块。`

/**
 * 组装旁路调用的 messages。空侧跳过（助手只回了工具调用、没有正文时只有【用户】一侧）。
 * @param {{user?: string, assistant?: string, planMode?: boolean}} ctx
 */
export function buildSuggestMessages({ user, assistant, planMode } = {}) {
  const u = typeof user === "string" ? user.trim() : ""
  const a = typeof assistant === "string" ? assistant.trim() : ""
  const parts = []
  if (u) parts.push(`【用户】${u.slice(0, USER_MAX)}`)
  if (a) parts.push(`【助手】${clipMid(a, ASSIST_HEAD, ASSIST_TAIL)}`)
  // Plan 模式的产物是「待确认的方案」，此时用户的下一步更可能是对着方案说话——给模型一个语境提示
  if (planMode) parts.push("（当前处于 Plan 模式：上面这份是助手刚给出的方案，等待用户批准或要求调整）")
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `最后一轮对话：\n\n${parts.join("\n")}` },
  ]
}

/** 行式回退只认「列表标记行」与「整行引号行」——见 parseSuggestions 注释。
 *  标记后可无空格：中文序号习惯写「1、继续」而不是「1. 继续」（单测抓到的真实形态） */
const LIST_MARK = /^(?:[-*•·]|\d+[.、)])\s*/
const QUOTED_LINE = /^["'“”「『](.*)["'“”」』]$/

/** 去 markdown 代码围栏（```json / ```）；顺手剥掉常见的中文冒号引导句不影响解析 */
function stripFence(text) {
  return text.replace(/```[a-zA-Z]*\s*/g, "").trim()
}

/**
 * 把模型原文解析成建议列表。**永不 throw**（任何异常一律 []）。
 * 顺序：去围栏 → 抓第一段 [...] 做 JSON.parse（贪心不行再试非贪心）→ 行式回退 → 清洗。
 *
 * 行式回退的裁剪尺度（有意保守）：只收带列表标记（`-` `*` `1.`）或整行带引号的行。裸多行散文
 * 照单全收会造出「假建议」——模型没按 JSON 输出时，它更可能是在解释为什么不能做；宁缺毋滥，
 * 反正建议为空时前端就没有这个建议区。
 */
export function parseSuggestions(raw) {
  try {
    if (typeof raw !== "string") return []
    const text = stripFence(raw)
    if (!text) return []

    let items = null
    for (const re of [/\[[\s\S]*\]/, /\[[\s\S]*?\]/]) {
      const m = text.match(re)
      if (!m) continue
      try {
        const parsed = JSON.parse(m[0])
        if (Array.isArray(parsed)) {
          items = parsed
          break
        }
      } catch {
        /* 这一段不是合法 JSON，换下一段/走行式回退 */
      }
    }
    if (!items) {
      items = []
      for (const rawLine of text.split("\n")) {
        const line = rawLine.trim()
        if (!line) continue
        if (LIST_MARK.test(line)) {
          items.push(line.replace(LIST_MARK, "").trim())
          continue
        }
        const q = line.match(QUOTED_LINE)
        if (q) items.push(q[1].trim())
      }
    }

    // 清洗：只留字符串 → 去空白 → 丢超长 → 去重 → 截到 2 条
    const out = []
    for (const it of items) {
      if (typeof it !== "string") continue
      const s = it.trim()
      if (!s || s.length > MAX_ITEM_CHARS) continue
      if (out.includes(s)) continue
      out.push(s)
      if (out.length >= MAX_ITEMS) break
    }
    return out
  } catch {
    return []
  }
}

/** 同项目在途去重：一轮刚结束、多个页面同时拉时只打一次模型（跑完即删，不缓存结果） */
const inflight = new Map()

/**
 * 生成追问建议。任何失败（无 key / 网络 / 超时 / 解析空）一律返回 []——
 * 建议生成失败绝不能影响对话（调用方按「没有建议」处理）。
 * @param {string} projectDir 项目目录（决定用哪个 provider）
 * @param {{user?: string, assistant?: string, planMode?: boolean}} ctx 最后一轮问答
 * @returns {Promise<string[]>}
 */
export async function suggestFollowups(projectDir, { user, assistant, planMode } = {}) {
  const u = typeof user === "string" ? user.trim() : ""
  const a = typeof assistant === "string" ? assistant.trim() : ""
  if (!u && !a) return [] // 空上下文：不浪费一次调用

  const prev = inflight.get(projectDir)
  if (prev) return prev

  // 注意：inflight.set 必须在 run() 之内首个 await 之前完成——异步函数体同步执行到首个
  // await 才让出，下面的 finally 因而不会早于 set 执行
  const run = (async () => {
    try {
      const messages = buildSuggestMessages({ user: u, assistant: a, planMode: Boolean(planMode) })
      return parseSuggestions(await chatOnce(projectDir, { messages }))
    } catch {
      return [] // 静默降级（含 chatOnce 抛错、超时、模型不可用）
    } finally {
      inflight.delete(projectDir)
    }
  })()
  inflight.set(projectDir, run)
  return run
}
