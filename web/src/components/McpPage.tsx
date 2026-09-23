import { useCallback, useEffect, useState } from "react"
import { api } from "../lib/api"
import type {
  McpImportGroup,
  McpImportResult,
  McpOpResult,
  McpPreset,
  McpServerInfo,
  McpStatus,
} from "../lib/types"

interface Props {
  project: string | null
  running: boolean
  refreshTick: number
}

type Transport = "stdio" | "http"

interface FormState {
  name: string
  transport: Transport
  command: string
  argsText: string
  url: string
  headersText: string
}

const emptyForm: FormState = { name: "", transport: "stdio", command: "npx", argsText: "", headersText: "", url: "" }

const JSON_EXAMPLE = `{
  "mcpServers": {
    "blender": {
      "command": "/opt/homebrew/bin/mcp-blender-launcher",
      "args": ["--port", "9876"]
    }
  }
}`

const parseLines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean)

const parseHeaders = (text: string) =>
  parseLines(text).map((line) => {
    const i = line.indexOf(":")
    return i < 0 ? { key: line, value: "" } : { key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() }
  })

const short = (p: string) => p.split("/").filter(Boolean).pop() ?? p

/** 实例池应用结果 → 一行人类可读文本 */
function resultText(results: McpOpResult[]): string {
  if (!results.length) return "已写入配置（暂无已加载项目，下次打开项目时生效）"
  return results
    .map((r) =>
      r.deferred
        ? `${short(r.project)}：运行中，本轮结束后自动应用`
        : r.ok
          ? `${short(r.project)}：已连接${r.tools?.length ? `（${r.tools.length} 个工具）` : ""}`
          : `${short(r.project)}：连接失败 —— ${r.error}`
    )
    .join("；")
}

/** MCP 页 —— 安装（stdio/HTTP + 模板）/ 状态与工具 / 连接测试 / 热重连 / 编辑与移除 */
export default function McpPage({ project, running, refreshTick }: Props) {
  const [servers, setServers] = useState<McpServerInfo[]>([])
  const [presets, setPresets] = useState<McpPreset[]>([])
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [enabled, setEnabled] = useState<string[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const [editing, setEditing] = useState<string | null>(null) // null=收起, ""=新增, 名称=编辑
  const [form, setForm] = useState<FormState>(emptyForm)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string; hint?: string } | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  // 粘贴 JSON 导入
  const [jsonText, setJsonText] = useState("")
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<McpImportResult | null>(null)

  const load = useCallback(() => {
    api
      .mcpServers(project)
      .then((r) => {
        setServers(r.servers)
        setPresets(r.presets)
        setStatus(r.status)
        setEnabled(r.enabled ?? [])
        setErr(null)
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [project])

  useEffect(load, [load, refreshTick])

  const flash = (msg: string) => {
    setNotice(msg)
    setTimeout(() => setNotice(null), 5000)
  }

  const openAdd = () => {
    setEditing("")
    setForm(emptyForm)
    setTestResult(null)
    setImportResult(null)
  }

  const openEdit = (s: McpServerInfo) => {
    setEditing(s.name)
    setForm({
      name: s.name,
      transport: s.transport,
      command: s.command,
      argsText: s.args.join("\n"),
      url: s.url,
      // 只回填 Key，值留空 = 保留原值（与后端约定一致）；删掉整行即移除该请求头
      headersText: s.headers.map((h) => `${h.key}: `).join("\n"),
    })
    setTestResult(null)
  }

  const payload = () => ({
    name: form.name.trim(),
    transport: form.transport,
    ...(form.transport === "http"
      ? { url: form.url.trim(), headers: parseHeaders(form.headersText) }
      : { command: form.command.trim(), args: parseLines(form.argsText) }),
  })

  const applyPreset = (ps: McpPreset) => {
    setForm((f) => ({
      ...f,
      name: ps.id,
      transport: ps.transport,
      command: ps.command ?? f.command,
      argsText: (ps.args ?? []).join("\n"),
      url: ps.url ?? "",
    }))
    setTestResult(null)
  }

  const importJson = async () => {
    setImporting(true)
    setImportResult(null)
    setErr(null)
    try {
      const r = await api.importMcpServers(jsonText)
      setImportResult(r)
      flash(`导入完成：新增 ${r.installed.length}，重名跳过 ${r.skipped.length}，失败 ${r.failed.length}`)
      if (r.installed.length) setJsonText("")
      load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setImporting(false)
    }
  }

  /** 导入结果里单个 server 的文案（按实例池应用结果聚合） */
  const importGroupLabel = (g: McpImportGroup): { bad: boolean; text: string } => {
    const okd = g.results.filter((r) => r.ok === true)
    const bad = g.results.filter((r) => r.ok === false)
    if (bad.length && !okd.length) return { bad: true, text: `已写入配置，连接失败 —— ${bad[0].error}` }
    if (!okd.length) {
      return {
        bad: false,
        text: g.results.some((r) => r.deferred) ? "已写入配置（项目运行中，本轮结束后应用）" : "已写入配置（暂无已加载项目）",
      }
    }
    const n = okd[0].tools?.length
    return { bad: false, text: `已连接${n ? `（${n} 个工具）` : ""}${bad.length ? `；${bad.length} 个项目连接失败` : ""}` }
  }

  const save = async () => {
    setBusy(true)
    setErr(null)
    try {
      const p = payload()
      const r = editing === "" ? await api.addMcpServer(p) : await api.updateMcpServer(p)
      setEditing(null)
      setTestResult(null)
      flash(`${editing === "" ? "已安装" : "已保存"}：${resultText(r.results)}`)
      load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (name: string) => {
    if (!window.confirm(`移除 MCP server「${name}」？将从配置删除并断开连接。`)) return
    try {
      const r = await api.deleteMcpServer(name)
      flash(`已移除 ${name}：${resultText(r.results)}`)
      load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const test = async (name?: string) => {
    setTesting(true)
    setTestResult(null)
    try {
      const r = name ? await api.testMcpServer({ name }) : await api.testMcpServer(payload())
      if (r.ok) {
        setTestResult({
          ok: true,
          text: `✓ 连接成功（${(r.elapsedMs / 1000).toFixed(1)}s）· 发现 ${r.tools?.length ?? 0} 个工具`,
          hint: r.tools?.length ? r.tools.join("、") : undefined,
        })
      } else {
        setTestResult({
          ok: false,
          text: `✗ ${r.error}`,
          hint: r.commandFound ? undefined : `未在本机 PATH 找到命令「${form.command}」，需要先安装对应运行时（如 Node.js 的 npx、Python 的 uv/uvx）`,
        })
      }
    } catch (e) {
      setTestResult({ ok: false, text: `✗ ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setTesting(false)
    }
  }

  const reconnect = async (name?: string) => {
    try {
      const r = await api.reconnectMcp(project, name)
      flash(`重连：${resultText(r.results)}`)
      load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  /** 按项目启用/停用（写 WebUI 偏好；运行中的项目本轮结束后自动对齐） */
  const toggleProject = async (name: string, enable: boolean) => {
    if (!project) return
    const next = enable ? [...new Set([...enabled, name])] : enabled.filter((n) => n !== name)
    setEnabled(next) // 乐观更新，失败时 load() 回滚
    try {
      const r = await api.setMcpProjectPrefs(project, next)
      flash(`${enable ? "已为本项目启用" : "已为本项目停用"} ${name}${r.note ? `（${r.note}）` : ""}`)
      load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      load()
    }
  }

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto px-8 py-8">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-[-0.01em] text-t1">MCP 服务器</h1>
          <p className="mt-1 text-xs text-t4">
            写入内核 <code className="rounded bg-surface3 px-1 py-0.5 font-mono">~/.thincoder/config.json</code> 的{" "}
            <code className="rounded bg-surface3 px-1 py-0.5 font-mono">mcp.servers[]</code>
            ，与终端 TUI 的 <code className="rounded bg-surface3 px-1 py-0.5 font-mono">/mcp</code> 双向兼容；改动即刻热更新已加载的项目 agent。
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button onClick={() => reconnect()} className="btn-ghost px-3 py-1.5 text-xs" title="按最新配置重连全部 server">
            全部重连
          </button>
          <button onClick={openAdd} className="btn-primary px-3.5 py-1.5 text-xs">
            ＋ 安装
          </button>
        </div>
      </div>

      {err && (
        <div className="mb-4 rounded-xl border border-red-900 bg-red-950 px-3.5 py-2.5 text-xs text-red-300">
          {err}
          <button className="ml-2 underline" onClick={() => setErr(null)}>
            关闭
          </button>
        </div>
      )}
      {notice && (
        <div className="mb-4 rounded-xl border border-emerald-900 bg-emerald-950 px-3.5 py-2.5 text-xs text-emerald-300">{notice}</div>
      )}

      {running && (
        <div className="mb-4 rounded-xl border border-amber-900 bg-amber-950 px-3.5 py-2.5 text-xs text-amber-300">
          当前项目运行中：MCP 变更会在本轮结束后自动应用（不打断正在执行的工具调用）。
        </div>
      )}

      {status && status.warnings.length > 0 && (
        <div className="mb-4 rounded-xl border border-amber-900 bg-amber-950 px-3.5 py-2.5 text-xs leading-relaxed text-amber-300">
          上次加载的连接警告：
          {status.warnings.map((w, i) => (
            <div key={i} className="mt-1 font-mono">
              {w}
            </div>
          ))}
        </div>
      )}

      {/* ================= 已安装列表 ================= */}
      <div className="mb-3 flex items-center justify-between">
        <div className="text-xs text-t4">
          状态来源：
          {project ? (
            <span className="font-mono text-t3">{short(project)}</span>
          ) : (
            "未选择项目（只显示配置）"
          )}
          <span className="ml-2">· 每行「本项目」勾选 = 该 server 是否加载到当前项目（新项目默认全不勾选，按需启用，互不影响）</span>
          {status?.dirty && <span className="ml-2 text-amber-400">有变更待本轮结束后应用</span>}
        </div>
      </div>

      <div className="mb-7 overflow-hidden rounded-xl border border-line">
        {servers.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-t4">
            尚未安装任何 MCP server —— 点右上角「＋ 安装」，从官方/社区模板开始
          </div>
        )}
        {servers.map((s) => {
          const st = status?.servers[s.name]
          const connected = Boolean(st?.connected)
          const isOff = !enabled.includes(s.name)
          const desc = s.transport === "http" ? s.url : `${s.command} ${s.args.join(" ")}`.trim()
          return (
            <div key={s.name} className={`border-t border-line px-4 py-3 first:border-t-0 ${isOff ? "opacity-70" : ""}`}>
              <div className="flex items-center gap-2.5">
                <span className="text-sm font-medium text-t1">{s.name}</span>
                <span className="rounded-full border border-line2 px-2 py-0.5 text-xs text-t4">
                  {s.transport === "http" ? "HTTP" : "stdio"}
                </span>
                {isOff ? (
                  <span className="rounded-full border border-line2 px-2 py-0.5 text-xs text-t4">本项目已停用</span>
                ) : status?.materialized ? (
                  connected ? (
                    <span className="rounded-full bg-emerald-950 px-2 py-0.5 text-xs font-medium text-emerald-300">
                      已连接 · {st?.tools.length} 工具
                    </span>
                  ) : (
                    <span className="rounded-full bg-red-950 px-2 py-0.5 text-xs font-medium text-red-300">未连接</span>
                  )
                ) : (
                  <span className="rounded-full border border-line2 px-2 py-0.5 text-xs text-t4">未加载</span>
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-t4" title={desc}>
                  {desc}
                  {s.headers.length > 0 && ` · ${s.headers.map((h) => h.key).join(", ")}`}
                </span>
                <label
                  className="flex shrink-0 items-center gap-1 text-xs text-t4"
                  title={project ? "控制当前项目是否加载此 server（其它项目不受影响）" : "先选择一个项目"}
                >
                  <input
                    type="checkbox"
                    className="accent-accent"
                    checked={!isOff}
                    disabled={!project}
                    onChange={(e) => toggleProject(s.name, e.target.checked)}
                  />
                  本项目
                </label>
                {connected && !isOff && st && st.tools.length > 0 && (
                  <button
                    onClick={() => setExpanded(expanded === s.name ? null : s.name)}
                    className="btn-ghost shrink-0 px-2.5 py-1 text-xs"
                  >
                    {expanded === s.name ? "收起工具" : "查看工具"}
                  </button>
                )}
                <button onClick={() => test(s.name)} disabled={testing} className="btn-ghost shrink-0 px-2.5 py-1 text-xs">
                  {testing ? "测试中…" : "测试"}
                </button>
                <button onClick={() => reconnect(s.name)} className="btn-ghost shrink-0 px-2.5 py-1 text-xs">
                  重连
                </button>
                <button onClick={() => openEdit(s)} className="btn-ghost shrink-0 px-2.5 py-1 text-xs">
                  编辑
                </button>
                <button
                  onClick={() => remove(s.name)}
                  className="shrink-0 rounded-lg border border-red-900 px-2.5 py-1 text-xs text-red-300 transition-colors hover:bg-red-950"
                >
                  移除
                </button>
              </div>
              {expanded === s.name && st && (
                <div className="mt-2 pl-1 font-mono text-xs leading-relaxed text-t3">
                  {st.tools.map((t) => (
                    <div key={t}>{t}</div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* ================= 安装 / 编辑表单 ================= */}
      {editing !== null && (
        <div className="mb-7 rounded-xl border border-line bg-surface px-4 py-4 shadow-sm">
          {editing === "" && (
            <>
              {/* 粘贴 JSON 导入：Claude Desktop / Cursor 的 mcpServers 可直接用 */}
              <div className="mb-4 rounded-lg border border-line2 bg-surface2 px-3.5 py-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-medium text-t3">粘贴 JSON 导入</span>
                  <button onClick={() => setJsonText(JSON_EXAMPLE)} className="text-xs text-t4 underline transition-colors hover:text-t2">
                    填入示例
                  </button>
                </div>
                <textarea
                  value={jsonText}
                  onChange={(e) => setJsonText(e.target.value)}
                  rows={6}
                  spellCheck={false}
                  placeholder={JSON_EXAMPLE}
                  className="field w-full px-3 py-2 font-mono text-xs"
                />
                <div className="mt-2 flex items-center justify-between gap-3">
                  <span className="text-xs leading-relaxed text-t4">
                    支持 mcpServers（Claude/Cursor）、servers 数组或单个对象；含 env 自动包装为 sh -c；同名跳过
                  </span>
                  <button
                    onClick={importJson}
                    disabled={importing || !jsonText.trim()}
                    className="btn-primary shrink-0 px-4 py-1.5 text-xs"
                  >
                    {importing ? "导入中…" : "解析并安装"}
                  </button>
                </div>
                {importResult && (
                  <div className="mt-2.5 space-y-1 border-t border-line pt-2.5 text-xs">
                    {importResult.installed.map((g) => {
                      const label = importGroupLabel(g)
                      return (
                        <div key={g.name} className={label.bad ? "text-red-400" : "text-emerald-400"}>
                          {label.bad ? "✗" : "✓"} {g.name}：{label.text}
                          {g.wrapped && <span className="ml-1 text-amber-400">（env 已包装为 sh -c）</span>}
                        </div>
                      )
                    })}
                    {importResult.skipped.map((s) => (
                      <div key={s.name} className="text-t4">
                        － {s.name}：{s.reason}
                      </div>
                    ))}
                    {importResult.failed.map((f) => (
                      <div key={f.name} className="text-red-400">
                        ✗ {f.name}：{f.error}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="mb-2 text-xs text-t4">或手动填写 / 从模板开始：</div>
            </>
          )}
          {editing === "" && (
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-xs text-t3">模板：</span>
              {presets.map((ps) => (
                <button
                  key={ps.id}
                  onClick={() => applyPreset(ps)}
                  title={ps.hint}
                  className={`rounded-full px-2.5 py-1 text-xs transition-colors ${
                    form.name === ps.id ? "bg-accent text-white" : "border border-line2 text-t3 hover:border-accent hover:text-t1"
                  }`}
                >
                  {ps.desc}
                </button>
              ))}
            </div>
          )}

          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              disabled={editing !== ""}
              placeholder="名称（如 filesystem，工具前缀用）"
              className="field px-3 py-2 text-xs disabled:opacity-60"
            />
            <div className="seg">
              <button data-on={form.transport === "stdio"} onClick={() => setForm((f) => ({ ...f, transport: "stdio" }))}>
                stdio（命令）
              </button>
              <button data-on={form.transport === "http"} onClick={() => setForm((f) => ({ ...f, transport: "http" }))}>
                HTTP（URL）
              </button>
            </div>

            {form.transport === "stdio" ? (
              <>
                <input
                  value={form.command}
                  onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
                  placeholder="命令（如 npx / uvx / node）"
                  className="field px-3 py-2 font-mono text-xs"
                />
                <textarea
                  value={form.argsText}
                  onChange={(e) => setForm((f) => ({ ...f, argsText: e.target.value }))}
                  placeholder={"参数（每行一个）\n-y\n@modelcontextprotocol/server-memory"}
                  rows={3}
                  className="field px-3 py-2 font-mono text-xs sm:col-span-2"
                />
              </>
            ) : (
              <>
                <input
                  value={form.url}
                  onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                  placeholder="https://example.com/mcp"
                  className="field px-3 py-2 font-mono text-xs sm:col-span-2"
                />
                <textarea
                  value={form.headersText}
                  onChange={(e) => setForm((f) => ({ ...f, headersText: e.target.value }))}
                  placeholder={"请求头（每行一个 Key: Value，值留空 = 保留原值）\nAuthorization: Bearer …"}
                  rows={2}
                  className="field px-3 py-2 font-mono text-xs sm:col-span-2"
                />
                {editing !== "" && servers.find((s) => s.name === editing)?.headers.length ? (
                  <div className="text-xs text-t4 sm:col-span-2">
                    已存请求头：
                    {servers
                      .find((s) => s.name === editing)
                      ?.headers.map((h) => `${h.key} ····${h.tail}`)
                      .join("，")}
                  </div>
                ) : null}
              </>
            )}
          </div>

          {testResult && (
            <div className={`mt-3 text-xs ${testResult.ok ? "text-emerald-400" : "text-red-400"}`}>
              {testResult.text}
              {testResult.hint && <div className="mt-1 text-t4">{testResult.hint}</div>}
            </div>
          )}

          <div className="mt-3 flex items-center justify-between">
            <button onClick={() => test()} disabled={testing} className="btn-ghost px-3.5 py-1.5 text-xs">
              {testing ? "测试中…（首次 npx 下载可能较慢）" : "测试连接"}
            </button>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setEditing(null)
                  setTestResult(null)
                }}
                className="btn-ghost px-3.5 py-1.5 text-xs"
              >
                取消
              </button>
              <button onClick={save} disabled={busy} className="btn-primary px-4 py-1.5 text-xs">
                {busy ? "保存中…" : editing === "" ? "安装" : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ================= 说明 ================= */}
      <div className="rounded-xl border border-line bg-surface px-4 py-3.5 text-xs leading-relaxed text-t4">
        <div className="mb-1 font-medium text-t3">说明</div>
        <ul className="list-disc space-y-1 pl-4">
          <li>服务器由本服务在本机拉起（stdio）或直连（HTTP）；stdio 命令以服务进程权限运行，等同于终端执行。</li>
          <li>
            内核暂不支持按 server 配置环境变量：粘贴 JSON 导入时含 <code className="rounded bg-surface3 px-1 py-0.5 font-mono">env</code>{" "}
            的条目会自动包装成 <code className="rounded bg-surface3 px-1 py-0.5 font-mono">sh -c "K=V exec …"</code>
            ；手动填写可用同样写法（macOS/Linux）。
          </li>
          <li>连接初始化超时 30 秒：npx 首次下载较大的包可能超时，可先在终端跑一次预热。</li>
          <li>“测试连接”是真实拉起进程验证（initialize + tools/list），测完即断开，不影响已加载项目。</li>
        </ul>
      </div>
    </div>
  )
}
