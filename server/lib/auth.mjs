/**
 * auth.mjs — 持久 token 鉴权（零依赖）
 * token 存 ~/.thincoder-webui/token（0600）；首启动生成，之后复用。
 * 校验来源三选一：HttpOnly cookie(tcw) / Authorization: Bearer / ?token=
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { homedir } from "node:os"

export const dataDir = join(homedir(), ".thincoder-webui")
const tokenPath = join(dataDir, "token")

let cachedToken = null

export function getToken() {
  if (cachedToken) return cachedToken
  try {
    const t = readFileSync(tokenPath, "utf8").trim()
    if (t) return (cachedToken = t)
  } catch { /* 首次启动 */ }
  const t = randomBytes(24).toString("base64url")
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(tokenPath, t, "utf8")
  try { chmodSync(tokenPath, 0o600) } catch { /* Windows 无 chmod 就算了 */ }
  return (cachedToken = t)
}

/** 解析请求里的候选 token（cookie > header > query） */
function candidateTokens(req, url) {
  const out = []
  const cookie = req.headers.cookie ?? ""
  for (const part of cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=")
    if (k === "tcw" && rest.length) out.push(decodeURIComponent(rest.join("=")))
  }
  const auth = req.headers.authorization ?? ""
  if (auth.startsWith("Bearer ")) out.push(auth.slice(7).trim())
  const q = url.searchParams.get("token")
  if (q) out.push(q)
  return out
}

export function isAuthed(req, url) {
  const token = getToken()
  return candidateTokens(req, url).some((t) => t === token)
}

export const COOKIE_NAME = "tcw"
