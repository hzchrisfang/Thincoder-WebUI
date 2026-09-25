import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "../lib/api"
import type { Preset, ProvidersConfig, SubagentModelsConfig } from "../lib/types"
import { SUBAGENT_ROLES, roleLabel } from "../lib/subagentRoles"
import LanQR from "./LanQR"
import ModelSelect from "./ModelSelect"
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

  // 表单「模型」字段的清单探针（新增/编辑供应商表单专用；供应商行下拉走 modelsCache，两者互不干扰）
  // key = 发起请求那一刻的「渠道身份」快照——只有 key 匹配当前表单时才把清单交给控件
  const [formModels, setFormModels] = useState<{ key: string; ok: boolean; list?: string[]; error?: string; reason?: string } | null>(null)
  const [formLoading, setFormLoading] = useState(false)
  const probeSeq = useRef(0) // 探针序号：并发/重拉时只认最后一次的结果

  // embedding
  const [embedKey, setEmbedKey] = useState("")

  // 子代理模型（探索/编码/审阅）：三类当前值 + 二级菜单打开态（哪一类展开 / 哪个渠道展开）
  const [subModels, setSubModels] = useState<SubagentModelsConfig | null>(null)
  const [subMenuOpen, setSubMenuOpen] = useState<"explore" | "coder" | "advisor" | null>(null)
  const [subProvOpen, setSubProvOpen] = useState<string | null>(null)

  // 模型清单缓存（testProvider = listModels 面，8s 超时）——供应商行「模型」下拉与子代理二级菜单共用；
  // loadingOpen = 正在拉哪个渠道（打开态由调用方自持，两处入口互不干扰）
  const [modelsCache, setModelsCache] = useState<Record<string, { ok: boolean; list?: string[]; error?: string; reason?: string }>>({})
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

  /** 改表单字段：顺手清掉过期的错误横幅——错误是「上一次操作」的结论，字段一动就该了结
   *  （否则「拉取清单需要先填 baseURL 与 API key」会一直挂到用户手动关闭或保存为止） */
  const updateForm = (patch: Partial<typeof form>) => {
    setForm((f) => ({ ...f, ...patch }))
    setErr(null)
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

  // 表单「渠道身份」快照——清单只在 key 匹配时才算当前渠道的清单（编辑渠道 A 拉回的清单、
  // 或改了 name/baseURL/key 之后的旧清单，不得冒充当前渠道；状态在该了结的地方了结）
  const formKey = `${editing ?? ""}|${form.name}|${form.baseURL}|${form.apiKey}`

  /** 拉模型清单：清空旧清单 + 置 loading → 结果与「发请求那一刻的 formKey」一起落盘。
   *  只认最后一次探针的结果（seq）——先发后到的旧结果连 loading 一起作废，
   *  不让旧请求把新请求的「拉取中」状态抹掉 */
  const probeForm = useCallback(
    async (spec: { name?: string; baseURL?: string; apiKey?: string }) => {
      const key = formKey // 发请求那一刻的渠道身份快照
      const seq = ++probeSeq.current
      setFormModels(null)
      setFormLoading(true)
      try {
        const r = await api.probeModels(spec)
        if (seq === probeSeq.current) setFormModels({ key, ok: r.ok, list: r.models, error: r.error, reason: r.reason })
      } catch (e) {
        if (seq === probeSeq.current) setFormModels({ key, ok: false, error: e instanceof Error ? e.message : String(e) })
      } finally {
        if (seq === probeSeq.current) setFormLoading(false)
      }
    },
    [formKey]
  )

  // 进入编辑态（非空名称）时自动探针一次；新增模式改由 key 输入框失焦触发（见下方 onBlur）
  useEffect(() => {
    if (editing) probeForm({ name: editing })
    // 依赖只有 editing：probeForm 随表单输入变化，入依赖会退化成逐键探针
  }, [editing])

  /** 手动拉取 / 重新拉取清单：编辑模式传 name（baseURL 走存量，新填的 key 覆盖存量）；
   *  新增模式必须自己给全 baseURL + key——缺哪项就明说到缺哪项，不静默不给按钮 */
  const reloadFormModels = () => {
    if (editing) {
      probeForm({ name: form.name, apiKey: form.apiKey.trim() || undefined })
      return
    }
    const baseURL = form.baseURL.trim()
    const apiKey = form.apiKey.trim()
    if (!baseURL || !apiKey) {
      setErr("拉取清单需要先填 baseURL 与 API key")
      return
    }
    probeForm({ baseURL, apiKey })
  }

  const saveForm = async () => {
    // trim 只去前后空白，**绝不改大小写**——渠道对模型名大小写敏感度不一，错大小写 → 运行期 400/404
    const model = form.model.trim()
    if (!form.name.trim() || !form.baseURL.trim() || !model) {
      setErr("名称 / baseURL / 模型为必填")
      return
    }
    // 软校验：只在「拿到了非空清单」时对照（空清单 = 渠道没给候选，不算用户填错）；
    // 命中判定精确大小写敏感（includes），不得 lowercased 比较
    const cached = formModels?.key === formKey && formModels.ok ? formModels.list ?? null : null
    const list = cached && cached.length ? cached : null
    if (list && !list.includes(model)) {
      if (!window.confirm(`「${model}」不在渠道清单中（清单 ${list.length} 项），可能拼写有误。仍要保存？`)) return
    }
    setBusy(true)
    setErr(null)
    try {
      if (editing === "") {
        if (!form.apiKey.trim()) {
          setErr("新增供应商必须填写 API key")
          return
        }
        await api.saveProvider({ ...form, model, apiKey: form.apiKey.trim() })
      } else {
        await api.upsertProvider({
          name: form.name,
          baseURL: form.baseURL,
          model,
          apiKey: form.apiKey.trim() || undefined, // 留空 = 保留原 key
        })
      }
      setEditing(null)
      setForm({ name: "", baseURL: "", apiKey: "", model: "" })
      flash(list ? "已保存" : "已保存；未能拉取渠道清单，已按所填模型名原样保存（部分渠道区分大小写）")
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
      const r = await api.deleteProvider(name)
      // 指向被删渠道的子代理模型由服务端级联回退「跟随主线」（见 DELETE /api/config/providers）——如实告知，不静默
      const back = (r.reverted ?? []).map((k) => roleLabel(k) ?? k).join("、")
      flash(back ? `已删除；子代理模型「${back}」已回退为跟随主线` : "已删除")
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
      setModelsCache((c) => ({ ...c, [name]: { ok: r.ok, list: r.models, error: r.error, reason: r.reason } }))
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
                  <input
                    type="radio"
                    name="active-provider"
                    checked={active}
                    onChange={() => activate(p.name)}
                    className="accent-accent"
                  />
                  <span className="text-sm font-medium text-t1">{p.name}</span>
                  {active && (
                    <span className="rounded-full bg-emerald-950 px-2 py-0.5 text-xs font-medium text-emerald-300">
                      激活
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-t4">
                    {p.model} · {p.baseURL}
                  </span>
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
                            <div className="px-3.5 py-2 text-xs text-red-300">{modelsCache[p.name].reason ?? "无法拉取清单"}</div>
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
                onClick={() => updateForm({ name: ps.name, baseURL: ps.baseURL, model: ps.model })}
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
              onChange={(e) => updateForm({ name: e.target.value })}
              placeholder="名称"
              className="field px-3 py-2 text-xs"
            />
            <ModelSelect
              value={form.model}
              onChange={(v) => updateForm({ model: v })}
              // 只有「清单身份 === 当前表单身份」时才把清单交下去，过期清单一律按未拉取处理
              list={formModels?.key === formKey ? formModels : null}
              loading={formLoading}
              onReload={reloadFormModels}
              placeholder="模型（如 deepseek-chat）"
            />
            <input
              value={form.baseURL}
              onChange={(e) => updateForm({ baseURL: e.target.value })}
              placeholder="baseURL（OpenAI 兼容）"
              className="field px-3 py-2 text-xs sm:col-span-2"
            />
            <input
              type="password"
              value={form.apiKey}
              onChange={(e) => updateForm({ apiKey: e.target.value })}
              // 新增模式：baseURL 是合法 http(s) 地址且 key 非空时，失焦即探针一次（保存前就能拿到清单）
              onBlur={() => {
                if (editing === "" && /^https?:\/\//.test(form.baseURL) && form.apiKey.trim()) {
                  probeForm({ baseURL: form.baseURL, apiKey: form.apiKey.trim() })
                }
              }}
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
