import { useCallback, useEffect, useState } from "react"
import { api } from "../lib/api"
import type { Preset, ProvidersConfig } from "../lib/types"
import LanQR from "./LanQR"

/** 设置页 —— 供应商管理 / embedding / 安全 */
export default function SettingsPage({ onProviderChanged }: { onProviderChanged: () => void }) {
  const [cfg, setCfg] = useState<ProvidersConfig | null>(null)
  const [presets, setPresets] = useState<Preset[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // 表单
  const [editing, setEditing] = useState<string | null>(null) // null=收起, ""=新增, 其他=编辑该名称
  const [form, setForm] = useState({ name: "", baseURL: "", apiKey: "", model: "" })
  const [testResult, setTestResult] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  // embedding
  const [embedKey, setEmbedKey] = useState("")

  // 安全
  const [host, setHostState] = useState<string | null>(null)
  const [port, setPort] = useState<number | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [lanAddresses, setLanAddresses] = useState<{ name: string; address: string }[]>([])

  const load = useCallback(() => {
    api
      .providersConfig()
      .then((c) => {
        setCfg(c)
        onProviderChanged()
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
    api.presets().then((r) => setPresets(r.presets)).catch(() => {})
    api.hostInfo().then((h) => {
      setHostState(h.host)
      setPort(h.port)
      setLanAddresses(h.lanAddresses ?? [])
    })
    api.tokenInfo().then((t) => setToken(t.token)).catch(() => {})
  }, [onProviderChanged])

  useEffect(load, [load])

  const flash = (msg: string) => {
    setNotice(msg)
    setTimeout(() => setNotice(null), 4000)
  }

  const startAdd = () => {
    const first = presets[0]
    setEditing("")
    setForm({ name: first?.name ?? "", baseURL: first?.baseURL ?? "", apiKey: "", model: first?.model ?? "" })
  }

  const startEdit = (name: string) => {
    const p = cfg?.providers.find((x) => x.name === name)
    if (!p) return
    setEditing(name)
    setForm({ name: p.name, baseURL: p.baseURL, apiKey: "", model: p.model })
  }

  const saveForm = async () => {
    if (!form.name.trim() || !form.baseURL.trim() || !form.model.trim()) {
      setErr("名称 / baseURL / 模型为必填")
      return
    }
    setBusy(true)
    setErr(null)
    try {
      if (editing === "") {
        if (!form.apiKey.trim()) {
          setErr("新增供应商必须填写 API key")
          return
        }
        await api.saveProvider({ ...form, apiKey: form.apiKey.trim() })
      } else {
        await api.upsertProvider({
          name: form.name,
          baseURL: form.baseURL,
          model: form.model,
          apiKey: form.apiKey.trim() || undefined, // 留空 = 保留原 key
        })
      }
      setEditing(null)
      setForm({ name: "", baseURL: "", apiKey: "", model: "" })
      flash("已保存")
      load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (name: string) => {
    if (!window.confirm(`删除供应商「${name}」？`)) return
    try {
      await api.deleteProvider(name)
      flash("已删除")
      load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const activate = async (name: string) => {
    try {
      await api.setActiveProvider(name)
      // 乐观更新激活标记，不等回读；随后 load() 再与服务端对齐
      setCfg((c) => (c ? { ...c, activeProvider: name } : c))
      flash(`已切换到 ${name}`)
      load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const test = async (name: string) => {
    setTestResult((r) => ({ ...r, [name]: "测试中…" }))
    try {
      const r = await api.testProvider(name)
      setTestResult((prev) => ({
        ...prev,
        [name]: r.ok ? `✓ 连接成功，发现 ${r.models?.length ?? 0} 个模型` : `✗ ${r.error}`,
      }))
    } catch (e) {
      setTestResult((prev) => ({ ...prev, [name]: `✗ ${e instanceof Error ? e.message : String(e)}` }))
    }
  }

  const saveEmbed = async () => {
    setBusy(true)
    try {
      const r = await api.saveEmbedding(embedKey.trim())
      flash(r.configured ? "embedding 已启用" : "embedding 已停用")
      setEmbedKey("")
      load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const switchHost = async (h: string) => {
    if (h === host) return
    if (h === "0.0.0.0" && !window.confirm("开放局域网访问？持有 token 的设备可完全操作本服务（含 shell）。")) return
    try {
      await api.setHost(h)
      setHostState(h)
      flash(h === "127.0.0.1" ? "已切换为仅本机（连接即将重建）" : "已开放局域网（连接即将重建）")
      // 服务端会重建监听，稍后重新拉一次主机信息（端口/网卡可能变化）
      setTimeout(() => {
        api.hostInfo().then((info) => {
          setHostState(info.host)
          setPort(info.port)
          setLanAddresses(info.lanAddresses ?? [])
        }).catch(() => {})
      }, 1200)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto px-8 py-8">
      <h1 className="mb-6 text-xl font-semibold tracking-[-0.01em] text-t1">设置</h1>

      {err && (
        <div className="mb-4 rounded-xl border border-red-900 bg-red-950 px-3.5 py-2.5 text-xs text-red-300">
          {err}
          <button className="ml-2 underline" onClick={() => setErr(null)}>
            关闭
          </button>
        </div>
      )}
      {notice && (
        <div className="mb-4 rounded-xl border border-emerald-900 bg-emerald-950 px-3.5 py-2.5 text-xs text-emerald-300">
          {notice}
        </div>
      )}

      {/* ================= 供应商 ================= */}
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-t1">模型供应商</h2>
          <p className="mt-0.5 text-xs text-t4">写入 ~/.thincoder/config.json</p>
        </div>
        <button onClick={startAdd} className="btn-primary px-3.5 py-1.5 text-xs">
          ＋ 添加
        </button>
      </div>

      {cfg && (
        <div className="mb-4 overflow-hidden rounded-xl border border-line">
          {cfg.providers.length === 0 && (
            <div className="px-4 py-4 text-xs text-t4">尚未配置任何供应商</div>
          )}
          {cfg.providers.map((p) => {
            const active = cfg.activeProvider === p.name
            return (
              <div key={p.name} className={`border-t border-line px-4 py-3 first:border-t-0 ${active ? "bg-accent-soft/40" : ""}`}>
                <div className="flex items-center gap-2.5">
                  <input
                    type="radio"
                    name="active-provider"
                    checked={active}
                    onChange={() => activate(p.name)}
                    title="设为激活"
                    className="accent-accent"
                  />
                  <span className="text-sm font-medium text-t1">{p.name}</span>
                  {active && (
                    <span className="rounded-full bg-emerald-950 px-2 py-0.5 text-xs font-medium text-emerald-300">
                      激活
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-t4" title={p.baseURL}>
                    {p.model} · {p.baseURL}
                  </span>
                  <span className={`shrink-0 text-xs ${p.hasKey ? "text-emerald-400" : "text-red-400"}`}>
                    {p.hasKey ? `key ····${p.keyTail}` : "无 key"}
                  </span>
                  <button onClick={() => test(p.name)} className="btn-ghost shrink-0 px-2.5 py-1 text-xs">
                    测试
                  </button>
                  <button onClick={() => startEdit(p.name)} className="btn-ghost shrink-0 px-2.5 py-1 text-xs">
                    编辑
                  </button>
                  <button
                    onClick={() => remove(p.name)}
                    className="shrink-0 rounded-lg border border-red-900 px-2.5 py-1 text-xs text-red-300 transition-colors hover:bg-red-950"
                  >
                    删除
                  </button>
                </div>
                {testResult[p.name] && <div className="mt-1.5 pl-6 text-xs text-t3">{testResult[p.name]}</div>}
              </div>
            )
          })}
        </div>
      )}

      {/* 添加/编辑表单 */}
      {editing !== null && (
        <div className="mb-7 rounded-xl border border-line bg-surface px-4 py-4 shadow-sm">
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs text-t3">{editing === "" ? "新增（可从预设开始）：" : `编辑 ${editing}：`}</span>
            {presets.map((ps) => (
              <button
                key={ps.name}
                onClick={() => setForm((f) => ({ ...f, name: ps.name, baseURL: ps.baseURL, model: ps.model }))}
                className={`rounded-full px-2.5 py-1 text-xs transition-colors ${
                  form.name === ps.name
                    ? "bg-accent text-white"
                    : "border border-line2 text-t3 hover:border-accent hover:text-t1"
                }`}
              >
                {ps.desc}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="名称"
              className="field px-3 py-2 text-xs"
            />
            <input
              value={form.model}
              onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
              placeholder="模型（如 deepseek-chat）"
              className="field px-3 py-2 text-xs"
            />
            <input
              value={form.baseURL}
              onChange={(e) => setForm((f) => ({ ...f, baseURL: e.target.value }))}
              placeholder="baseURL（OpenAI 兼容）"
              className="field px-3 py-2 text-xs sm:col-span-2"
            />
            <input
              type="password"
              value={form.apiKey}
              onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
              placeholder={editing === "" ? "API key" : "API key（留空 = 保留原 key）"}
              className="field px-3 py-2 text-xs sm:col-span-2"
            />
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button onClick={() => setEditing(null)} className="btn-ghost px-3.5 py-1.5 text-xs">
              取消
            </button>
            <button onClick={saveForm} disabled={busy} className="btn-primary px-4 py-1.5 text-xs">
              {busy ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      )}

      {/* ================= embedding ================= */}
      <h2 className="mb-3 text-sm font-medium text-t1">向量检索（embedding，可选）</h2>
      <div className="mb-7 rounded-xl border border-line bg-surface px-4 py-3.5">
        <div className="mb-2.5 text-xs text-t3">
          状态：
          {cfg ? (
            cfg.embedding.configured ? (
              <span className="text-emerald-400">已启用</span>
            ) : (
              <span className="text-t3">未启用（纯文本检索）</span>
            )
          ) : (
            "…"
          )}
          {cfg?.embedding.model && <span className="ml-2 font-mono text-xs text-t4">{cfg.embedding.model}</span>}
        </div>
        <div className="flex gap-2">
          <input
            type="password"
            value={embedKey}
            onChange={(e) => setEmbedKey(e.target.value)}
            placeholder="SiliconFlow 等 /v1/embeddings 的 key（清空并保存 = 停用）"
            className="field min-w-0 flex-1 px-3 py-2 text-xs"
          />
          <button onClick={saveEmbed} disabled={busy} className="btn-ghost shrink-0 px-3.5 py-2 text-xs">
            保存
          </button>
        </div>
      </div>

      {/* ================= 安全 ================= */}
      <h2 className="mb-3 text-sm font-medium text-t1">安全</h2>
      <div className="rounded-xl border border-line bg-surface px-4 py-4">
        <div className="mb-3.5 rounded-lg border border-amber-900 bg-amber-950 px-3.5 py-2.5 text-xs leading-relaxed text-amber-300">
          持有访问 token 的设备可以完全操作本服务——包括通过 agent 执行命令、修改文件。请只在可信网络内开放局域网访问。
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="text-xs text-t3">
            监听：<span className="font-mono text-t2">{host ?? "…"}:{port ?? "…"}</span>
            {host === "0.0.0.0" && (
              <span className="ml-2 rounded-full bg-amber-950 px-2 py-0.5 text-xs text-amber-300">局域网可访问</span>
            )}
          </div>
          <div className="seg">
            <button data-on={host === "127.0.0.1"} onClick={() => switchHost("127.0.0.1")}>
              仅本机
            </button>
            <button data-on={host === "0.0.0.0"} onClick={() => switchHost("0.0.0.0")}>
              局域网
            </button>
          </div>
        </div>
        {token && (
          <div className="mt-3.5 text-xs leading-relaxed text-t4">
            访问 token：<code className="rounded bg-surface3 px-1.5 py-0.5 font-mono text-t2">{token}</code>
            <span className="ml-2">（其他设备用 /login?token=… 登录；文件：~/.thincoder-webui/token）</span>
          </div>
        )}

        {/* 局域网二维码：仅在开放局域网时展示 */}
        {host === "0.0.0.0" && (
          <div className="mt-4 border-t border-line pt-4">
            <div className="mb-1 text-xs font-medium text-t1">局域网访问</div>
            <LanQR port={port} token={token} addresses={lanAddresses} />
          </div>
        )}
      </div>
    </div>
  )
}
