import { Marked } from "marked"
import katex from "katex"
import "katex/dist/katex.min.css"

// 文档面专用实例（DocPanel）：KaTeX 公式渲染走独立 Marked 实例而非全局 marked——
// 全局实例被 Timeline（聊天时间线）共享，挂上扩展会让聊天里的 $...$ 也变公式；
// 因此文档面整体迁到独立实例。基础选项与 Timeline 的全局 setOptions 保持同源。
export const docMarkdown = new Marked({ gfm: true, breaks: true }, katexExtension())

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

interface KatexToken {
  text: string
  displayMode: boolean
}

function renderKatex(token: KatexToken): string {
  return katex.renderToString(token.text, { throwOnError: false, displayMode: token.displayMode })
}

function katexExtension() {
  return {
    extensions: [
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
          if (match) {
            return {
              type: "inlineKatex" as const,
              raw: match[0],
              text: match[2].trim(),
              displayMode: match[1].length === 2,
            }
          }
        },
        renderer(token: KatexToken) {
          return renderKatex(token)
        },
      },
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
        renderer(token: KatexToken) {
          return renderKatex(token) + "\n"
        },
      },
    ],
  }
}
