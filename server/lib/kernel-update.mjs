/**
 * kernel-update.mjs — 内核（npm 包 thincoder）最新版本检查（零依赖）
 *
 * 查 npm registry 的 dist-tags 最小接口（仅返回版本号，几十字节），
 * 先直连 registry.npmjs.org，失败兜底 registry.npmjs.org 的国内镜像 npmmirror.com
 * （npmmirror 同步有滞后，兜底命中时在 source 里标注，前端据此提示「可能滞后」）。
 *
 * 结果带 TTL 缓存在内存：成功 4 小时、失败 5 分钟（离线时不反复撞超时）。
 * 并发请求共享同一次在途检查（in-flight 去重）。
 */

const PACKAGE = "thincoder"
const OK_TTL_MS = 4 * 60 * 60 * 1000 // 成功缓存 4 小时
const FAIL_TTL_MS = 5 * 60 * 1000 // 失败缓存 5 分钟
const FETCH_TIMEOUT_MS = 5000
// 官方源优先；npmmirror 仅兜底（同步滞后可能导致误报「已是最新」）
const SOURCES = [
  { name: "npmjs", url: `https://registry.npmjs.org/-/package/${PACKAGE}/dist-tags` },
  { name: "npmmirror", url: `https://registry.npmmirror.com/-/package/${PACKAGE}/dist-tags` },
]

/** @type {{ latest: string|null, source: string|null, checkedAt: number, error: string|null }|null} */
let cache = null
/** @type {Promise<any>|null} 在途检查（并发去重） */
let inflight = null

/**
 * 语义化版本比较：a > b 返回 1，a < b 返回 -1，相等返回 0。
 * 只处理数字段（1.2.66 / 0.12.7），非数字段按 0 对齐；段数不齐右侧补 0。
 * 内核版本号格式简单（无 prerelease/build 需求），不值得引入 semver 库。
 */
export function compareVersions(a, b) {
  const pa = String(a ?? "").split(/[+~-]/)[0].split(".").map((n) => Number.parseInt(n, 10) || 0)
  const pb = String(b ?? "").split(/[+~-]/)[0].split(".").map((n) => Number.parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/** 拉取一个源的 dist-tags，返回 latest 版本号；结构意外时抛错由上层降级到下一源 */
async function fetchLatestFrom(source) {
  const res = await fetch(source.url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: "application/json" },
  })
  if (!res.ok) throw new Error(`${source.name} HTTP ${res.status}`)
  const data = await res.json()
  const latest = data?.["dist-tags"]?.latest ?? data?.latest
  if (typeof latest !== "string" || !latest) throw new Error(`${source.name} 响应无 latest 标签`)
  return latest
}

/**
 * 检查内核最新版（带缓存；并发共享在途请求）。
 * 返回 { latest, source, checkedAt, error }：latest 为 null 表示本次没能取到（error 给原因）。
 */
export async function checkKernelUpdate() {
  if (cache && Date.now() - cache.checkedAt < (cache.latest ? OK_TTL_MS : FAIL_TTL_MS)) return cache
  if (!inflight) {
    inflight = (async () => {
      let lastErr = "未知错误"
      for (const source of SOURCES) {
        try {
          const latest = await fetchLatestFrom(source)
          cache = { latest, source: source.name, checkedAt: Date.now(), error: null }
          return cache
        } catch (e) {
          lastErr = e?.message ?? String(e)
        }
      }
      cache = { latest: null, source: null, checkedAt: Date.now(), error: lastErr }
      return cache
    })().finally(() => {
      inflight = null
    })
  }
  return inflight
}
