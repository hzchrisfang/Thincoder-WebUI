import { useCallback, useEffect, useState } from "react"
import { api } from "../lib/api"
import type { Preset, ProvidersConfig, SubagentModelsConfig } from "../lib/types"
import { SUBAGENT_ROLES } from "../lib/subagentRoles"
import LanQR from "./LanQR"
import Tooltip from "./Tooltip"

/** 设置页 —— 供应商管理 / 子代理模型 / embedding / 安全 */
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

  // 子代理模型（探索/编码/审阅）：三类当前值 + 二级菜单打开态（哪一类展开 / 哪个渠道展开）
  const [subModels, setSubModels] = useState<SubagentModelsConfig | null>(null)
  const [subMenuOpen, setSubMenuOpen] = useState<"explore" | "coder" | "advisor" | null>(null)
  const [subProvOpen, setSubProvOpen] = useState<string | null>(null)

  // 模型清单缓存（testProvider = listModels 面，8s 超时）——供应商行「模型」下拉与子代理二级菜单共用；
  // loadingOpen = 正在拉哪个渠道（打开态由调用方自持，两处入口互不干扰）
  const [modelsCache, setModelsCache] = useState<Record<string, { ok: boolean; list?: string[]; error?: string }>>({})
  const [modelsOpen, setModelsOpen] = useState<string | null>(null)
  const [loadingOpen, setLoadingOpen] = useState<Set<string>>(new Set())

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
    api.subagentModels().then(setSubModels).catch(() => {})
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

  // ---- 子代理模型（即选即存；PUT 部分补丁只传当前类） ----
  const saveSubModel = async (kind: "explore" | "coder" | "advisor", ref: string | null) => {
    setBusy(true)
    setErr(null)
    try {
      const r = await api.setSubagentModel(kind, ref)
      setSubModels({ explore: r.explore, coder: r.coder, advisor: r.advisor })
      flash(ref ? "已保存，对之后派发的子任务生效" : "已恢复跟随主线")
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  // ---- 模型清单拉取（供应商行「模型」下拉与子代理二级菜单共用；结果缓存，已拉过不发请求） ----
  const ensureModels = async (name: string) => {
    if (modelsCache[name] || loadingOpen.has(name)) return
    setLoadingOpen((s) => new Set(s).add(name))
    try {
      const r = await api.testProvider(name)
      setModelsCache((c) => ({ ...c, [name]: { ok: r.ok, list: r.models, error: r.error } }))
    } catch (e) {
      setModelsCache((c) => ({ ...c, [name]: { ok: false, error: e instanceof Error ? e.message : String(e) } }))
    } finally {
      setLoadingOpen((s) => { const n = new Set(s); n.delete(name); return n })
    }
  }

  // 供应商行「模型」下拉开关（拉清单复用 ensureModels）
  const toggleModels = (name: string) => {
    if (modelsOpen === name) {
      setModelsOpen(null)
      return
    }
    setModelsOpen(name)
    ensureModels(name)
  }

  const setMain = async (name: string, model?: string) => {
    setModelsOpen(null)
    setErr(null)
    try {
      await api.setActiveProvider(name, model)
      flash(`主线已切换：${name}${model ? ` · ${model}` : "（渠道当前模型）"}`)
      load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
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

      {/* 供应商列表容器不用 overflow-hidden：会把「模型」下拉裁剪在容器内（与 0.8.6 目录菜单同族问题）；圆角改由首末行各自负责 */}
      {cfg && (
        <div className="mb-4 rounded-xl border border-line [&>*:first-child]:rounded-t-xl [&>*:last-child]:rounded-b-xl">
          {cfg.providers.length === 0 && (
            <div className="px-4 py-4 text-xs text-t4">尚未配置任何供应商</div>
          )}
          {cfg.providers.map((p) => {
            const active = cfg.activeProvider === p.name
            return (
              <div key={p.name} className={`border-t border-line px-4 py-3 first:border-t-0 ${active ? "bg-accent-soft/40" : ""}`}>
                <div className="flex items-center gap-2.5">
                  <Tooltip label="设为激活" side="right">
                    <input
                      type="radio"
                      name="active-provider"
                      checked={active}
                      onChange={() => activate(p.name)}
                      className="accent-accent"
                    />
                  </Tooltip>
                  <span className="text-sm font-medium text-t1">{p.name}</span>
                  {active && (
                    <span className="rounded-full bg-emerald-950 px-2 py-0.5 text-xs font-medium text-emerald-300">
                      激活
                    </span>
                  )}
                  <Tooltip label={p.baseURL} side="right" className="min-w-0 flex-1">
                    <span className="min-w-0 w-full block truncate font-mono text-xs text-t4">
                      {p.model} · {p.baseURL}
                    </span>
                  </Tooltip>
                  <span className={`shrink-0 text-xs ${p.hasKey ? "text-emerald-400" : "text-red-400"}`}>
                    {p.hasKey ? `key ····${p.keyTail}` : "无 key"}
                  </span>
                  <button onClick={() => test(p.name)} className="btn-ghost shrink-0 px-2.5 py-1 text-xs">
                    测试
                  </button>
                  {/* 模型下拉：同一供应商的任意模型设为主线（defaultModel 复合值，不限于渠道默认） */}
                  <div className="relative shrink-0">
                    <button onClick={() => toggleModels(p.name)} className="btn-ghost px-2.5 py-1 text-xs">
                      模型
                    </button>
                    {modelsOpen === p.name && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setModelsOpen(null)} />
                        <div className="absolute right-0 top-full z-50 mt-1.5 w-64 max-h-72 overflow-y-auto rounded-xl border border-line bg-surface shadow-lg">
                          <div className="sticky top-0 border-b border-line bg-surface px-3.5 py-2 text-xs text-t4">
                            选择模型（{p.name}）
                          </div>
                          <button
                            onClick={() => setMain(p.name)}
                            className={`flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs transition-colors hover:bg-hover ${cfg.activeProvider === p.name && (!cfg.activeModel || cfg.activeModel === p.model) ? "text-accent" : "text-t2"}`}
                          >
                            <span className={`w-3.5 shrink-0 ${cfg.activeProvider === p.name && (!cfg.activeModel || cfg.activeModel === p.model) ? "" : "invisible"}`}>✓</span>
                            <span className="font-mono">{p.model}</span>
                            <span className="ml-auto shrink-0 text-t4">当前</span>
                          </button>
                          {loadingOpen.has(p.name) && <div className="px-3.5 py-2 text-xs text-t4">拉取模型清单中…</div>}
                          {modelsCache[p.name] && !modelsCache[p.name].ok && (
                            <div className="px-3.5 py-2 text-xs text-red-300">拉取失败：{modelsCache[p.name].error}</div>
                          )}
                          {modelsCache[p.name]?.list
                            ?.filter((m) => m !== p.model)
                            .map((m) => (
                              <button
                                key={m}
                                onClick={() => setMain(p.name, m)}
                                className={`flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs transition-colors hover:bg-hover ${cfg.activeProvider === p.name && cfg.activeModel === m ? "text-accent" : "text-t2"}`}
                              >
                                <span className={`w-3.5 shrink-0 ${cfg.activeProvider === p.name && cfg.activeModel === m ? "" : "invisible"}`}>✓</span>
                                <span className="min-w-0 truncate font-mono">{m}</span>
                              </button>
                            ))}
                          {modelsCache[p.name]?.list && modelsCache[p.name].list!.filter((m) => m !== p.model).length === 0 && (
                            <div className="px-3.5 py-2 text-xs text-t4">清单里没有其他模型</div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
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

      {/* ================= 子代理模型 ================= */}
      <h2 className="mb-0.5 text-sm font-medium text-t1">子代理模型</h2>
      <p className="mb-3 text-xs text-t4">为不同类型的子任务指定模型；默认跟随主线。对之后派发的子任务生效，运行中的不变。</p>
      <div className="mb-7 rounded-xl border border-line bg-surface px-4 py-3.5">
        {cfg && cfg.providers.length === 0 ? (
          <div className="text-xs text-t4">先在上方「模型供应商」配置渠道，才能为子任务指定模型。</div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {SUBAGENT_ROLES.map((role) => {
              const current = subModels?.[role.key] ?? null
              const menuOpen = subMenuOpen === role.key
              return (
                <div key={role.key} className="flex flex-wrap items-center gap-2">
                  <span className="w-14 shrink-0 text-xs font-medium text-t1">{role.label}</span>
                  <Tooltip label={role.hint} side="right">
                    <span className="cursor-help text-xs text-t4">ⓘ</span>
                  </Tooltip>
                  {/* 二级菜单：一级选渠道，二级拉该渠道模型清单（与供应商行「模型」按钮同源同缓存） */}
                  <div className="relative min-w-0 max-w-xs flex-1">
                    <button
                      onClick={() => setSubMenuOpen(menuOpen ? null : role.key)}
                      disabled={busy}
                      className="field flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs"
                    >
                      <span className={`min-w-0 truncate ${current ? "font-mono" : "text-t3"}`}>{current ?? "跟随主线"}</span>
                      <span className="shrink-0 text-t4">▾</span>
                    </button>
                    {menuOpen && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setSubMenuOpen(null)} />
                        <div className="absolute left-0 top-full z-50 mt-1.5 max-h-72 w-64 overflow-y-auto rounded-xl border border-line bg-surface shadow-lg">
                          <div className="sticky top-0 border-b border-line bg-surface px-3.5 py-2 text-xs text-t4">跟随主线，或选渠道指定模型</div>
                          <button
                            onClick={() => { setSubMenuOpen(null); saveSubModel(role.key, null) }}
                            className={`flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs transition-colors hover:bg-hover ${current ? "text-t2" : "text-accent"}`}
                          >
                            <span className={`w-3.5 shrink-0 ${current ? "invisible" : ""}`}>✓</span>
                            <span>跟随主线</span>
                          </button>
                          {cfg?.providers.map((pv) => {
                            const expanded = subProvOpen === `${role.key}:${pv.name}`
                            // 渠道行模型显示跟随本类选择（用户裁定 2026-09-25）：该渠道正是本类当前所选
                            // → 显示所选模型；否则显示渠道当前模型（主线语境）。纯显示派生，零刷新机制。
                            const rowModel = current?.startsWith(`${pv.name}:`) ? current.slice(pv.name.length + 1) : pv.model
                            return (
                              <div key={pv.name} className="border-t border-line/60 first:border-t-0">
                                <button
                                  onClick={async () => {
                                    if (expanded) { setSubProvOpen(null); return }
                                    setSubProvOpen(`${role.key}:${pv.name}`)
                                    await ensureModels(pv.name) // 拉清单（共享缓存，已拉过不发请求；不动供应商行的打开态）
                                  }}
                                  className={`flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs transition-colors hover:bg-hover ${current?.startsWith(`${pv.name}:`) ? "text-accent" : "text-t2"}`}
                                >
                                  <span className={`w-3.5 shrink-0 ${current?.startsWith(`${pv.name}:`) ? "" : "invisible"}`}>✓</span>
                                  <span className="shrink-0 font-medium">{pv.name}</span>
                                  <span className="min-w-0 truncate font-mono text-t4">{rowModel}</span>
                                  <span className="ml-auto shrink-0 text-t4">{expanded ? "▾" : "▸"}</span>
                                </button>
                                {expanded && (
                                  <div className="bg-surface2/40 pb-1">
                                    {loadingOpen.has(pv.name) && (
                                      <div className="px-3.5 py-1.5 pl-9 text-xs text-t4">拉取模型清单中…</div>
                                    )}
                                    {modelsCache[pv.name] && !modelsCache[pv.name].ok && (
                                      <div className="px-3.5 py-1.5 pl-9 text-xs text-red-300">拉取失败：{modelsCache[pv.name].error}</div>
                                    )}
                                    {modelsCache[pv.name]?.list?.map((m) => (
                                      <button
                                        key={m}
                                        onClick={() => { setSubMenuOpen(null); setSubProvOpen(null); saveSubModel(role.key, `${pv.name}:${m}`) }}
                                        className={`flex w-full items-center gap-2 py-1.5 pl-9 pr-3.5 text-left text-xs transition-colors hover:bg-hover ${current === `${pv.name}:${m}` ? "text-accent" : "text-t2"}`}
                                      >
                                        <span className={`w-3.5 shrink-0 ${current === `${pv.name}:${m}` ? "" : "invisible"}`}>✓</span>
                                        <span className="min-w-0 truncate font-mono">{m}</span>
                                      </button>
                                    ))}
                                    {modelsCache[pv.name]?.ok && modelsCache[pv.name].list?.length === 0 && (
                                      <div className="px-3.5 py-1.5 pl-9 text-xs text-t4">清单为空</div>
                                    )}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

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
