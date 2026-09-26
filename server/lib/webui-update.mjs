/**
 * webui-update.mjs — WebUI 自身最新版本检查（零依赖）
 *
 * 查公开 GitHub 仓 main 分支 package.json 的 version 字段。
 * 先直连 raw.githubusercontent.com，失败兜底 jsDelivr CDN 镜像
 * （jsdelivr 有 ~12h 缓存滞后，兜底命中时在 source 里标注，前端据此提示「结果可能偏旧」）。
 *
 * 结果带 TTL 缓存在内存：成功 4 小时、失败 5 分钟（离线时不反复撞超时）。
 * 并发请求共享同一次在途检查（in-flight 去重）。
 *
 * 与 kernel-update.mjs 同一套模式；WebUI 版本号唯一来源是根 package.json（/api/version 读它）。
 */

const REPO = "hzchrisfang/Thincoder-WebUI"
// 公开仓 main 分支与 clone URL：版本检查与一键更新编排器（webui-apply.mjs）共用同一常量——检查与拉取永远同源
export const REPO_BRANCH = "main"
export { REPO }
const OK_TTL_MS = 4 * 60 * 60 * 1000 // 成功缓存 4 小时
const FAIL_TTL_MS = 5 * 60 * 1000 // 失败缓存 5 分钟
const FETCH_TIMEOUT_MS = 5000
// 官方源优先；jsDelivr 仅兜底（CDN 缓存滞后可能导致误报「已是最新」）
const SOURCES = [
  { name: "github-raw", url: `https://raw.githubusercontent.com/${REPO}/main/package.json` },
  { name: "jsdelivr", url: `https://cdn.jsdelivr.net/gh/${REPO}@main/package.json` },
]

/** @type {{ latest: string|null, source: string|null, checkedAt: number, error: string|null }|null} */
let cache = null
/** @type {Promise<any>|null} 在途检查（并发去重） */
let inflight = null

/** 拉取一个源的 package.json，返回 version；结构意外时抛错由上层降级到下一源 */
async function fetchLatestFrom(source) {
  const res = await fetch(source.url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: "application/json" },
  })
  if (!res.ok) throw new Error(`${source.name} HTTP ${res.status}`)
  const data = await res.json()
  const latest = data?.version
  if (typeof latest !== "string" || !latest) throw new Error(`${source.name} 响应无 version 字段`)
  return latest
}

/**
 * 检查 WebUI 最新版（带缓存；并发共享在途请求）。
 * 返回 { latest, source, checkedAt, error }：latest 为 null 表示本次没能取到（error 给原因）。
 */
export async function checkWebuiUpdate() {
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
