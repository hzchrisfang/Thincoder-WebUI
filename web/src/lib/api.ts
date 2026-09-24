import type {
  ApprovalMode,
  CheckpointInfo,
  CommitInfo,
  GitStatus,
  JobInfo,
  JobRun,
  McpConfigResponse,
  McpImportResult,
  McpOpResult,
  McpServerInfo,
  McpServerPayload,
  McpTestResult,
  Preset,
  ProviderStatus,
  ProvidersConfig,
  RewindPoints,
  RewindPreview,
  RewindSummary,
  SessionListInfo,
  Snapshot,
  SubagentItem,
  ThinkingInfo,
  TimelineItem,
  UsageStats,
} from "./types"

export class ApiError extends Error {
  constructor(public status: number, msg: string) {
    super(msg)
  }
}

async function request<T = Record<string, unknown>>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
  })
  if (res.status === 401) throw new ApiError(401, "未授权")
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new ApiError(res.status, data.error ?? res.statusText)
  return data
}

export const api = {
  state: () => request<Snapshot>("/api/state"),
  projects: () => request<{ projects: { dir: string; addedAt: number }[] }>("/api/projects"),
  addProject: (dir: string) =>
    request<{ projects: { dir: string }[] }>("/api/projects", { method: "POST", body: JSON.stringify({ dir }) }),
  /** 移除项目：移出历史面板并清除该项目在 thincoder 中的会话历史（目录内文件保留） */
  removeProject: (dir: string) =>
    request<{ projects: { dir: string }[] }>("/api/projects", { method: "DELETE", body: JSON.stringify({ dir }) }),
  /** 目录浏览：不传 dir 从用户主目录开始；withFiles 时同时返回文件条目（输入框插文件路径用） */
  fsList: (dir?: string, withFiles?: boolean) => {
    const q = [dir ? `dir=${encodeURIComponent(dir)}` : "", withFiles ? "files=1" : ""].filter(Boolean).join("&")
    return request<{ dir: string; parent: string | null; entries: { name: string; isDir?: boolean }[] }>(
      `/api/fs${q ? `?${q}` : ""}`
    )
  },
  open: (project: string) =>
    request<{ provider: ProviderStatus }>("/api/open", { method: "POST", body: JSON.stringify({ project }) }),
  chat: (project: string, text: string) =>
    request<{ ok: boolean; msgId: string }>("/api/chat", { method: "POST", body: JSON.stringify({ project, text }) }),
  abort: (project: string) => request("/api/abort", { method: "POST", body: JSON.stringify({ project }) }),
  setMode: (project: string, mode: ApprovalMode) =>
    request("/api/mode", { method: "POST", body: JSON.stringify({ project, mode }) }),
  decide: (reqId: string, allow: boolean, remember: boolean) =>
    request("/api/decision", { method: "POST", body: JSON.stringify({ reqId, allow, remember }) }),
  answer: (reqId: string, answer: string) =>
    request("/api/answer", { method: "POST", body: JSON.stringify({ reqId, answer }) }),
  // ---- 会话管理（M2） ----
  sessions: (project: string) => request<SessionListInfo>(`/api/sessions?project=${encodeURIComponent(project)}`),
  history: (project: string) =>
    request<{ items: TimelineItem[] }>(`/api/history?project=${encodeURIComponent(project)}`),
  readFile: (project: string, path: string) =>
    request<{ text: string; truncated: boolean; size: number }>(
      `/api/file?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`
    ),
  /** 图片 / 网页的原始流地址（供 <img> / <iframe> 直接引用，走 cookie 鉴权） */
  fileRawUrl: (project: string, path: string) =>
    `/api/file?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}&raw=1`,
  newSession: (project: string) =>
    request("/api/sessions/new", { method: "POST", body: JSON.stringify({ project }) }),
  switchSession: (project: string, slot: number) =>
    request("/api/sessions/switch", { method: "POST", body: JSON.stringify({ project, slot }) }),
  deleteSessionSlot: (project: string, slot: number) =>
    request<{ ok: boolean; slot: number }>("/api/sessions/delete", {
      method: "POST",
      body: JSON.stringify({ project, slot }),
    }),
  presets: () => request<{ presets: Preset[] }>("/api/config/presets"),
  saveProvider: (p: { name: string; baseURL: string; apiKey: string; model: string }) =>
    request("/api/config/provider", { method: "POST", body: JSON.stringify(p) }),
  // ---- 供应商全集 / 用量 / Git / 安全（M3） ----
  providersConfig: () => request<ProvidersConfig>("/api/config/providers"),
  upsertProvider: (p: { name: string; baseURL: string; apiKey?: string; model: string }) =>
    request("/api/config/providers", { method: "PUT", body: JSON.stringify(p) }),
  deleteProvider: (name: string) =>
    request("/api/config/providers", { method: "DELETE", body: JSON.stringify({ name }) }),
  setActiveProvider: (name: string) =>
    request("/api/config/active", { method: "POST", body: JSON.stringify({ name }) }),
  testProvider: (name: string) =>
    request<{ ok: boolean; models?: string[]; error?: string }>("/api/config/test", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  saveEmbedding: (apiKey: string) =>
    request("/api/config/embedding", { method: "PUT", body: JSON.stringify({ apiKey }) }),
  usage: (days: number) => request<UsageStats>(`/api/usage?days=${days}`),
  gitStatus: (project: string) => request<GitStatus>(`/api/git/status?project=${encodeURIComponent(project)}`),
  gitLog: (project: string) =>
    request<{ repo: boolean; commits: CommitInfo[] }>(`/api/git/log?project=${encodeURIComponent(project)}`),
  gitDiff: (project: string, path: string, staged: boolean) =>
    request<{ repo: boolean; text?: string; truncated?: boolean; note?: string }>(
      `/api/git/diff?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}${staged ? "&staged=1" : ""}`
    ),
  checkpoints: (project: string) =>
    request<{ checkpoints: CheckpointInfo[] }>(`/api/checkpoints?project=${encodeURIComponent(project)}`),
  createCheckpoint: (project: string) =>
    request<{ checkpoint: CheckpointInfo | null }>("/api/checkpoints/create", {
      method: "POST",
      body: JSON.stringify({ project }),
    }),
  rewindCheckpoint: (project: string, id: string) =>
    request<{ summary: { deleted: number; restored: number; patchApplied: boolean } }>("/api/checkpoints/rewind", {
      method: "POST",
      body: JSON.stringify({ project, id }),
    }),
  // ---- 会话回退（复制 / 回退） ----
  rewindPoints: (project: string) => request<RewindPoints>(`/api/rewind/points?project=${encodeURIComponent(project)}`),
  rewindPreview: (project: string, id: string) =>
    request<RewindPreview>(`/api/rewind/preview?project=${encodeURIComponent(project)}&id=${encodeURIComponent(id)}`),
  rewind: (project: string, id: string) =>
    request<{ ok: boolean; summary: RewindSummary }>("/api/rewind", { method: "POST", body: JSON.stringify({ project, id }) }),
  rewindUndo: (project: string) =>
    request<{ ok: boolean; summary: RewindSummary }>("/api/rewind/undo", { method: "POST", body: JSON.stringify({ project }) }),
  hostInfo: () => request<{ host: string; port: number | null; lanAddresses: { name: string; address: string }[] }>("/api/host"),
  setHost: (host: string) => request("/api/host", { method: "POST", body: JSON.stringify({ host }) }),
  tokenInfo: () => request<{ token: string }>("/api/token"),
  // ---- 定时任务（M4） ----
  jobs: () => request<{ jobs: JobInfo[] }>("/api/jobs"),
  createJob: (body: Record<string, unknown>) =>
    request<{ job: JobInfo }>("/api/jobs", { method: "POST", body: JSON.stringify(body) }),
  updateJob: (body: Record<string, unknown>) =>
    request<{ job: JobInfo }>("/api/jobs", { method: "PUT", body: JSON.stringify(body) }),
  deleteJob: (id: string) => request("/api/jobs", { method: "DELETE", body: JSON.stringify({ id }) }),
  runJobNow: (id: string) => request("/api/jobs/run", { method: "POST", body: JSON.stringify({ id }) }),
  jobRuns: (id: string, limit = 50) =>
    request<{ runs: JobRun[] }>(`/api/jobs/${encodeURIComponent(id)}/runs?limit=${limit}`),
  // ---- MCP 服务器（安装 / 维护） ----
  mcpServers: (project: string | null) =>
    request<McpConfigResponse>(`/api/mcp${project ? `?project=${encodeURIComponent(project)}` : ""}`),
  setMcpProjectPrefs: (project: string, enabled: string[]) =>
    request<{ ok: boolean; results: McpOpResult[]; enabled: string[]; note?: string }>("/api/mcp/project", {
      method: "PUT",
      body: JSON.stringify({ project, enabled }),
    }),
  addMcpServer: (body: McpServerPayload & { project?: string | null }) =>
    request<{ ok: boolean; server: McpServerInfo; results: McpOpResult[]; adopted?: string[] }>("/api/mcp/servers", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateMcpServer: (body: McpServerPayload) =>
    request<{ ok: boolean; server: McpServerInfo; results: McpOpResult[] }>("/api/mcp/servers", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteMcpServer: (name: string) =>
    request<{ ok: boolean; results: McpOpResult[] }>("/api/mcp/servers", {
      method: "DELETE",
      body: JSON.stringify({ name }),
    }),
  testMcpServer: (body: McpServerPayload | { name: string }) =>
    request<McpTestResult>("/api/mcp/test", { method: "POST", body: JSON.stringify(body) }),
  importMcpServers: (json: string, project?: string | null) =>
    request<McpImportResult>("/api/mcp/import", { method: "POST", body: JSON.stringify({ json, project }) }),
  reconnectMcp: (project: string | null, name?: string) =>
    request<{ ok: boolean; results: McpOpResult[] }>(
      `/api/mcp/reconnect${project ? `?project=${encodeURIComponent(project)}` : ""}`,
      { method: "POST", body: JSON.stringify(name ? { name } : {}) }
    ),
  version: () => request<{ webui: string; thincoder: string | null; boot: string }>("/api/version"),
  /** 内核（npm 包 thincoder）最新版检查——服务端带 TTL 缓存，失败时 latest=null 且带 error */
  kernelUpdate: () =>
    request<{
      installed: string | null
      latest: string | null
      source: string | null
      checkedAt: number
      error: string | null
      outdated: boolean
    }>("/api/kernel-update"),
  /** WebUI 自身最新版检查（公开 GitHub 仓 main 分支 package.json）——缓存策略同 kernelUpdate */
  webuiUpdate: () =>
    request<{
      installed: string
      latest: string | null
      source: string | null
      checkedAt: number
      error: string | null
      outdated: boolean
    }>("/api/webui-update"),
  /** 一键半自动更新：触发服务端编排（拉取公开仓 → 装依赖 → 重建 → 换入）；运行中重复触发 409 */
  webuiApplyUpdate: () => request<{ ok: boolean }>("/api/webui-apply-update", { method: "POST", body: "{}" }),
  /** 当前/最近一次更新任务状态 + 日志尾部（刷新页面后恢复进度显示用） */
  webuiUpdateStatus: () =>
    request<{
      state: "idle" | "running" | "ok" | "failed"
      current: { step: string; status: string; line?: string } | null
      result: { version: string; at: number; skip?: boolean; message?: string } | null
      failure: { step: string; message: string } | null
      logTail: string[]
      logTotal: number
      startedAt: number | null
      finishedAt: number | null
    }>("/api/webui-update-status"),
  /** 斜线命令：服务端执行内核 TUI 处理器，返回其输出行（见 lib/commands.ts） */
  command: (project: string, command: string, args: string[] = []) =>
    request<{ ok: boolean; lines: string[] }>("/api/command", {
      method: "POST",
      body: JSON.stringify({ project, command, args }),
    }),
  /** 一轮结束后自动生成的追问建议（服务端旁路小调用；失败/无内容返回空数组） */
  suggest: (project: string, payload: { user: string; assistant: string; planMode?: boolean }) =>
    request<{ suggestions: string[] }>("/api/suggest", {
      method: "POST",
      body: JSON.stringify({ project, ...payload }),
    }),
  /** 思考程度：读当前状态 + 当前模型的档位枚举 */
  thinking: (project: string) =>
    request<ThinkingInfo>(`/api/thinking?project=${encodeURIComponent(project)}`),
  /** 设思考档：auto=切换 Auto-think / off=关思考 / effort+level=具体档位 */
  setThinking: (project: string, action: "auto" | "off" | "effort", level?: string) =>
    request<{ ok: boolean; after: ThinkingInfo }>("/api/thinking", {
      method: "POST",
      body: JSON.stringify({ project, action, level }),
    }),
}
