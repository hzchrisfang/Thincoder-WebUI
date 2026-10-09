import { Marked } from "marked"
import type { MarkedExtension, Tokens } from "marked"
import katex from "katex"
import "katex/dist/katex.min.css"

// ---------------------------------------------------------------------------
// 三个实例，按「面」与「流式阶段」分工（彼此独立，互不影响）：
//   docMarkdown        文档预览（DocPanel）——$ 定界符 + 内容式守卫
//   chatMarkdown       聊天时间线·定稿臂（Timeline）—— 在上述基础上多认反斜杠定界符
//   chatStreamMarkdown 聊天时间线·流式臂（Timeline）——不挂 KaTeX：流式途中半截 TeX
//                      不渲染（否则每来一个字符就闪一次 KaTeX 红字），定稿后整体换公式
//
// **两面守卫同口径、定界符有差**：内容式守卫（内容不像数学就保持字面）自 0.13.5 起
// 文档面也启用（此前只有位置式，`价格 $5$ 元` 这类成对闭合成对误判挡不住）；
// 反斜杠定界符 `\(...\)` / `\[...\]` 仍只在聊天面——模型在对话里默认输出这种写法，
// 文档里少见（不加不会让用户觉得文档不能写公式，`$...$` 仍可用）。
//
// 双态的依据：模型逐字符吐字，`$E=mc^` 这种半截定界符在流式期间必然高频出现；
// 等 turn 结束（TimelineItem.done）再整体解析渲染，是无闪烁的稳定形态。
// 与 deepseek harness 的「双臂语法」（流式臂 parseGfm 不含 math、定稿臂 parseGfmWithMath）
// 同构，只是我们把「换语法」落在实例选择上而非解析器内部。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// KaTeX 扩展（自 marked-katex-extension@5.1.13 内联修改；上游 MIT License）。
// 不直接依赖该包的原因：其行内定界正则的闭合前瞻集不认「全角分号/顿号/括号/CJK 汉字」，
// 起始侧（start 定位器）又只认「行首或 ASCII 空格」——中文正文里「公式$...$；文字」
// 「速览：$...$」两类写法整体失配（实测 2026-10-08，红字原文）。此处按上游结构内联，
// 修两侧字符集，其余语义（$$ 块级、throwOnError 容错）与上游一致：
//   闭合前瞻 = 上游集合 ∪ 全角标点补齐（；、：（）引号书名号）∪ CJK 汉字 ∪ 行尾
//   起始侧   = 行首 / ASCII 空白 / 全角标点（**不含** CJK 汉字——「价格$5」的金额闸保留：
//              开 $ 紧贴汉字时整条不识别，金额不会被误判成公式）
// ---------------------------------------------------------------------------
const CJK_CLOSE = String.raw`；、（）「」『』“”‘’《》〈〉【】…—`
const CJK_OPEN = String.raw`，。；：！？、（）“”‘’《》〈〉【】…—`
/** 行内公式：$...$ 行内模式、$$...$$ 行内 display 模式（块级独占一行的走 blockKatex） */
const inlineRule = new RegExp(
  `^(\\${"$"}{1,2})(?!\\${"$"})((?:\\\\.|[^\\\\\\n])*?(?:\\\\.|[^\\\\\\n\\${"$"}]))\\1(?=[\\s?!.,:？！。，：${CJK_CLOSE}]|$|[\\u4e00-\\u9fff])`,
)
/** 反斜杠行内定界符 \(...\)（TeX 标准写法；deepseek 系模型对话里默认输出这种） */
const bsInlineRule = /^\\\(((?:\\.|[^\\])*?)\\\)/
/** 反斜杠块级定界符：\[...\] 单行独占，或 \[ 与 \] 各独占一行 */
const bsBlockRule = /^\\\[((?:\\[^]|[^\\])+?)\\\](?:\n|$)/

// ---------------------------------------------------------------------------
// 内容式守卫（**两面共有**）——看 `$...$` **内容**像不像数学，不像就整条不认。
// 与位置式守卫（起始侧不放行 CJK 汉字）互补：位置式挡「紧贴汉字开 $」，
// 内容式挡「成对闭合但内容不是数学」（如 `价格 $5$ 元`、`变量 $name$ 值`）。
// 判据取自 ZCode 的 isLikelySingleDollarMath（packages/ui/src/components/ai-elements/message.tsx:559）。
// 一处收紧：纯数字不认（`$5$` 在中文里更可能是价格而非「数字 5」这个公式）。
// ---------------------------------------------------------------------------
const MATH_SYMBOL_RE = /[\\{}^_=+\-*/<>|()[\]∇∂∫∑√∞≈≠≤≥±×÷πΠα-ωΑ-Ω]/u
const TEX_COMMAND_RE = /\\[A-Za-z]+/
const SIMPLE_IDENT_RE = /^(?:[A-Za-z]|[a-z][A-Za-z0-9]{1,2})$/

/** 内容是否「像数学」：含 TeX 命令或数学符号，或无空格的简单标识符 */
function isLikelyMathText(content: string): boolean {
  const c = content.trim()
  if (!c || /[\r\n]/.test(c)) return false
  if (TEX_COMMAND_RE.test(c) || MATH_SYMBOL_RE.test(c)) return true
  return !/\s/.test(c) && SIMPLE_IDENT_RE.test(c)
}

function renderKatex(token: Tokens.Generic): string {
  const text = typeof token.text === "string" ? token.text : ""
  return katex.renderToString(text, { throwOnError: false, displayMode: token.displayMode === true })
}

/** 定位「下一个可能命中的 \( 位置」——跳过被转义的反斜杠（`\\(` 是字面 `\(`，不认） */
function findBackslashDelimiter(src: string, marker: string): number | undefined {
  for (let i = 0; i < src.length - 1; i++) {
    if (src[i] !== "\\" || src[i + 1] !== marker) continue
    let escapes = 0
    for (let j = i - 1; j >= 0 && src[j] === "\\"; j--) escapes++
    if (escapes % 2 === 0) return i
  }
  return undefined
}

interface KatexExtensionOptions {
  /** 内容式守卫：`$...$` 内容不像数学就不认（两面都开） */
  strictMath?: boolean
  /** 反斜杠定界符 \(...\) / \[...\]（仅聊天面——模型对话默认写法） */
  backslash?: boolean
}

function katexExtension({ strictMath = false, backslash = false }: KatexExtensionOptions = {}) {
  const inlineExtensions: NonNullable<MarkedExtension["extensions"]> = [
    {
      name: "inlineKatex",
      level: "inline" as const,
      // marked 用 start 定位「下一个可能命中的位置」：只放行不会误伤的开 $ 前置字符
      start(src: string) {
        let index: number
        let indexSrc = src
        while (indexSrc) {
          index = indexSrc.indexOf("$")
          if (index === -1) return
          const prev = index > 0 ? indexSrc.charAt(index - 1) : ""
          if (index === 0 || /[\s]/.test(prev) || CJK_OPEN.includes(prev)) {
            if (indexSrc.substring(index).match(inlineRule)) return index
          }
          indexSrc = indexSrc.substring(index + 1).replace(/^\$+/, "")
        }
      },
      tokenizer(src: string) {
        const match = src.match(inlineRule)
        if (!match) return
        const text = match[2].trim()
        if (strictMath && !isLikelyMathText(text)) return
        return {
          type: "inlineKatex" as const,
          raw: match[0],
          text,
          displayMode: match[1].length === 2,
        }
      },
      renderer(token) {
        return renderKatex(token)
      },
    },
  ]

  const blockExtensions: NonNullable<MarkedExtension["extensions"]> = [
    {
      name: "blockKatex",
      level: "block" as const,
      // 块级公式定界符须独占一行（与上游一致）
      tokenizer(src: string) {
        const match = src.match(/^(\${1,2})\n((?:\\[^]|[^\\])+?)\n\1(?:\n|$)/)
        if (match) {
          return {
            type: "blockKatex" as const,
            raw: match[0],
            text: match[2].trim(),
            displayMode: match[1].length === 2,
          }
        }
      },
      renderer(token) {
        return renderKatex(token) + "\n"
      },
    },
  ]

  if (backslash) {
    inlineExtensions.push({
      name: "bsInlineKatex",
      level: "inline" as const,
      start: (src: string) => findBackslashDelimiter(src, "("),
      tokenizer(src: string) {
        const match = src.match(bsInlineRule)
        if (!match) return
        const text = match[1].trim()
        if (!text || !isLikelyMathText(text)) return
        return { type: "bsInlineKatex" as const, raw: match[0], text, displayMode: false }
      },
      renderer(token) {
        return renderKatex(token)
      },
    })
    blockExtensions.push({
      name: "bsBlockKatex",
      level: "block" as const,
      tokenizer(src: string) {
        const match = src.match(bsBlockRule)
        if (!match) return
        const text = match[1].trim()
        if (!text) return
        return { type: "bsBlockKatex" as const, raw: match[0], text, displayMode: true }
      },
      renderer(token) {
        return renderKatex(token) + "\n"
      },
    })
  }

  return { extensions: [...blockExtensions, ...inlineExtensions] }
}

/** 文档预览面：$ 定界符 + 内容式守卫（0.13.5 起补齐，与聊天面同口径） */
export const docMarkdown = new Marked(
  { gfm: true, breaks: true },
  katexExtension({ strictMath: true }),
)

/** 聊天定稿臂：$ 与 \(...\)/\[...\] 双定界符 + 内容式守卫（内容不像数学即字面） */
export const chatMarkdown = new Marked(
  { gfm: true, breaks: true },
  katexExtension({ strictMath: true, backslash: true }),
)

/** 聊天流式臂：不挂 KaTeX——半截 TeX 在流式途中保持字面，定稿后才换公式 */
export const chatStreamMarkdown = new Marked({ gfm: true, breaks: true })
