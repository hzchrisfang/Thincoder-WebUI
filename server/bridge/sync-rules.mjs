/**
 * bridge/sync-rules.mjs — 将 WebUI 项目内的 AGENTS.md 全局规则同步到内核全局层。
 *
 * 内核 thincoder 运行期间，每次组装 system prompt 都会自动读取
 * `~/.thincoder/AGENTS.md`（用户全局层，覆盖所有项目）。WebUI 无法直接改内核，
 * 因此在启动时把仓库内维护的规则源同步到该文件，让"运行期 agent"自动读到。
 *
 * 同步策略（受管片段）：
 *   目标文件里用 `<!-- webui-managed:begin -->` / `<!-- webui-managed:end -->`
 *   标记 webui 管理的内容块。每次同步只替换管理块，其余内容（用户自定义的
 *   全局指令）原样保留；不存在则该块追加在文件末尾。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const TARGET = join(homedir(), ".thincoder", "AGENTS.md")
const BEGIN = "<!-- webui-managed:begin -->"
const END = "<!-- webui-managed:end -->"

/** 取仓库内规则源文件路径 */
export function getSourcePath() {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "AGENTS.md")
}

/** 读仓库内规则源内容 */
async function readSource() {
  return await readFile(getSourcePath(), "utf8")
}

/**
 * 把新内容合并进既有文本：替换管理块，或保留全部并追加新块。
 * 用户自定义部分（管理块之外）始终保留。
 */
function merge(targetText, newContent) {
  const block = `${BEGIN}\n${newContent.trim()}\n${END}`
  if (targetText.includes(BEGIN)) {
    const pre = targetText.slice(0, targetText.indexOf(BEGIN))
    const post = targetText.slice(targetText.indexOf(END) + END.length)
    return `${pre.trimEnd()}\n\n${block}\n${post.trimStart().length ? "\n" + post.trimStart() : ""}`
  }
  const body = targetText.trim()
  return body ? `${body}\n\n${block}\n` : `${block}\n`
}

/** 规范化文本仅用于幂等判断：压缩多余空行、trim 首尾，避免换行抖动造成无谓重写 */
function normalize(text) {
  return text
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** 同步一次。返回 true=已写入/创建；false=无需变更。失败集合并抛出。 */
export async function syncGlobalRules() {
  const source = await readSource()
  if (!source.trim()) return false
  await mkdir(dirname(TARGET), { recursive: true })

  let target = ""
  try {
    target = await readFile(TARGET, "utf8")
  } catch {
    target = "" // 目标尚不存在
  }

  const next = merge(target, source)
  if (normalize(next) === normalize(target)) return false
  await writeFile(TARGET, next, "utf8")
  return true
}