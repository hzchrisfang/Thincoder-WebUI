/**
 * scripts/patch-core.mjs — 20015 孤立代理清洗补丁（幂等，postinstall 自动执行）
 *
 * 背景：内核 memory 索引按 UTF-16 码元 slice（如 chunkCode 的 2000 码元窗口），切点落在
 * 代理对（emoji 等）中间时产出以孤立代理结尾的 embed 文本，SiliconFlow 拒收整批
 * （HTTP 400 code=20015 "The parameter is invalid"）。上游 @thincoder/core 未修（0.9.2 核对过）。
 *
 * 方案：在本地 node_modules/@thincoder/core/embedding.mjs 的 embed() 入口统一清洗——
 * 一处覆盖全部入口（memory/code/doc/查询）。补丁落在 WebUI 项目内的 node_modules，
 * 不触碰全局安装；`npm install` 会重置文件，故挂 postinstall 每次重打（幂等：有标记即跳过）。
 *
 * 手动执行：node scripts/patch-core.mjs
 * 补全局安装（重装/升级全局 thincoder 后）：node scripts/patch-core.mjs --target /opt/homebrew/lib/node_modules/thincoder/node_modules/@thincoder/core/embedding.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { execSync } from "node:child_process"
import { join, dirname } from "node:path"
import { createRequire } from "node:module"

const require = createRequire(new URL("../package.json", import.meta.url))

const MARKER = "thincoder-webui patch (20015)"

function resolveCoreEmbedding() {
  const argTarget = process.argv[process.argv.indexOf("--target") + 1]
  if (process.argv.includes("--target") && argTarget) return argTarget
  try {
    return join(dirname(require.resolve("@thincoder/core/package.json")), "embedding.mjs")
  } catch { /* 本地没装 */ }
  try {
    const root = execSync("npm root -g", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
    const p = join(root, "thincoder", "node_modules", "@thincoder", "core", "embedding.mjs")
    if (existsSync(p)) return p
  } catch { /* npm 不可用 */ }
  return null
}

const HELPERS = `// --- ${MARKER}: strip lone UTF-16 surrogates before batching ---
function stripLoneSurrogates(s) {
  return typeof s === "string"
    ? s.replace(/[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]/g, "")
    : s
}
`

const target = resolveCoreEmbedding()
if (!target) {
  console.warn("[patch-core] 未找到 @thincoder/core/embedding.mjs——跳过 20015 补丁（安装不完整？）")
  process.exit(0)
}

let src = readFileSync(target, "utf8")
if (src.includes(MARKER)) {
  console.log(`[patch-core] 已打过补丁，跳过：${target}`)
  process.exit(0)
}

const entryAnchor = "export async function embed(embedder, texts, { signal } = {}) {\n  if (texts.length === 0) return []"
if (!src.includes(entryAnchor)) {
  console.warn(`[patch-core] ⚠ 未匹配到 embed() 入口锚点（内核结构变了？）——跳过补丁，请人工核对：${target}`)
  process.exit(0)
}

src = src.replace(
  entryAnchor,
  HELPERS + entryAnchor + "\n  texts = texts.map(stripLoneSurrogates)"
)
writeFileSync(target, src, "utf8")
console.log(`[patch-core] ✓ 20015 补丁已打入：${target}`)
