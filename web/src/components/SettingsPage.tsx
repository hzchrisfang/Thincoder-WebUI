import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "../lib/api"
import type { Preset, ProvidersConfig, ConsultModelEntry, ConsultModelsConfig, SubagentModelsConfig } from "../lib/types"
import { SUBAGENT_ROLES, roleLabel } from "../lib/subagentRoles"
import LanQR from "./LanQR"
import ModelSelect from "./ModelSelect"
import Tooltip, { FloatingTooltip } from "./Tooltip"

/** 设置页 —— 供应商管理 / 子代理模型 / 会诊模型 / embedding / 性能（超时控制）/ 安全 */
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

  // 会诊模型（多模型会诊）：清单 + 二级菜单打开态（哪一行开着菜单 / 菜单里哪个渠道展开）。
  // 形态与「子代理模型」区块同款：一级渠道 → 二级模型清单，**点选即落盘**（无草稿值、无提交按钮——
  // 服务端只收「完整的一条」，二级菜单天然只会产出完整条目，半成品不可能存在）。
  // 菜单行号：-1 = 「＋ 添加模型」那一行（渲染在清单末尾）。
  const [consult, setConsult] = useState<ConsultModelsConfig | null>(null)
  const [consultMenu, setConsultMenu] = useState<number | null>(null)
  const [consultExpand, setConsultExpand] = useState<string | null>(null)
  // 清单「读到了吗」：读失败 ≠ 没配置——读失败时不得渲染空态口径，更不得让「＋ 添加模型」落盘
  // （PUT 是整表写入，会把磁盘上的真实条目覆盖成本地这份空清单）。
  const [consultErr, setConsultErr] = useState(false)

  // 模型清单缓存（testProvider = listModels 面，8s 超时）——供应商行「模型」下拉、子代理二级菜单、
  // 会诊行二级菜单三处共用；loadingOpen = 正在拉哪个渠道（打开态由调用方自持，各入口互不干扰）
  const [modelsCache, setModelsCache] = useState<Record<string, { ok: boolean; list?: string[]; error?: string; reason?: string }>>({})
  const [modelsOpen, setModelsOpen] = useState<string | null>(null)
  const [loadingOpen, setLoadingOpen] = useState<Set<string>>(new Set())

  // 安全
  const [host, setHostState] = useState<string | null>(null)
  const [port, setPort] = useState<number | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [lanAddresses, setLanAddresses] = useState<{ name: string; address: string }[]>([])

  // 性能：超时控制（停滞自动中止）开关（null = 还没读到；服务端默认开）
  const [watchdog, setWatchdog] = useState<boolean | null>(null)

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
    api.getWatchdog().then((w) => setWatchdog(w.enabled)).catch(() => {})
    api.subagentModels().then(setSubModels).catch(() => {})
    api.consultModels()
      .then((r) => { setConsult(r); setConsultErr(false) })
      // 读失败：除亮失败态，还要**收起已打开的菜单**——否则草稿行/行菜单会带着「本地空清单」
      // 的上下文继续对着屏幕，用户一点选就是一次整表 PUT（「在此之前不会写入」得是硬保证）。
      .catch(() => { setConsultErr(true); setConsultMenu(null); setConsultExpand(null) })
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
      // 指向被删渠道的子代理模型由服务端级联回退「跟随主线」、会诊模型由服务端级联移除
      // （见 DELETE /api/config/providers）——两类如实告知，不静默
      const back = (r.reverted ?? []).map((k) => roleLabel(k) ?? k).join("、")
      const dropped = (r.droppedConsult ?? []).join("、")
      const notes = []
      if (back) notes.push(`子代理模型「${back}」已回退为跟随主线`)
      if (dropped) notes.push(`会诊模型「${dropped}」已一并移除`)
      flash(notes.length ? `已删除；${notes.join("；")}` : "已删除")
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

  // ---- 会诊模型（即选即存：整表提交） ----
  /** 提交整张清单（服务端 PUT 是「数组 = 全量写入」），成功即用回显重建本地清单。
   *  **档位（effort）不随请求发出**：设置页没有档位控件（用户裁定 2026-09-26：会诊区块不配思考
   *  深度）——那它凭什么写这个字段？服务端 `mergeConsultEffort`（`server/routes.mjs`）按
   *  「同 `provider:model` 沿用磁盘档位、新条目不带」补齐 ⇒ **同模型重选保住档位、换模型丢掉**
   *  （档位是模型特定的，带过去正是坑 91 的静默丢弃陷阱）。
   *  关键是那个效据源：它取自**写盘时刚新鲜读到的磁盘值**，而不是本页打开时的快照 ⇒ 别处
   *  （CLI `/config → consult/escalate pool menu`、另一个标签页、终端手改 config）改过的档位
   *  不会被本页静默写回。早先版本在这里「照抄本地快照的 effort」，那个跨进程窗口已关。 */
  const saveConsult = async (next: ConsultModelEntry[], note?: string) => {
    setBusy(true)
    setErr(null)
    try {
      const r = await api.putConsultModels({
        // **不发 effort**（见上方注释：本页不持有档位意图，档位由服务端按磁盘对齐）
        models: next.map((m) => ({ provider: m.provider, model: m.model })),
      })
      setConsult({ models: r.models, max: r.max })
      flash(note || "已保存，从下一次对话回合起生效")
      return true
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  const removeConsultRow = (i: number) => saveConsult((consult?.models ?? []).filter((_, idx) => idx !== i), "已移除该会诊模型")

  /** 点选某个模型（二级菜单的最末一层）= **唯一落盘入口**：`slot < 0` 追加，否则替换该行。
   *  本页**不决定也不携带档位**（没有控件就没有意图）：只声明 provider + model，档位由服务端按
   *  磁盘上同款条目的值补齐——见 `saveConsult` 上方注释。本地构造的条目 effort 一律 `null`，
   *  落盘后由响应回显拉正（列表本身就是服务端状态的镜像）。 */
  const pickConsultModel = (slot: number, provider: string, model: string) => {
    setConsultMenu(null)
    setConsultExpand(null)
    // 读失败态下 `list` 只可能是空（consult 停在 null）——此时落盘 = 用空清单覆盖磁盘上的真实条目。
    // 渲染层已把草稿行/菜单收掉（见 `!consultErr` 两处），这是第二道闸：防「失败态在菜单打开
    // 之后才翻转」的那条缝（load() 的 catch 会收菜单，但状态更新与点击可能在同一帧里交错）。
    if (consultErr) return Promise.resolve(false)
    const list = consult?.models ?? []
    const next =
      slot < 0
        ? [...list, { provider, model, effort: null, efforts: [] }]
        : list.map((m, i) => (i === slot ? { provider, model, effort: null, efforts: [] } : m))
    return saveConsult(next, slot < 0 ? "已添加会诊模型" : "已更新会诊模型")
  }

  // ---- 模型清单拉取（供应商行「模型」下拉 / 子代理二级菜单 / 会诊行二级菜单共用；成功结果缓存，
  //      不重复发请求。**失败不当缓存**（用户裁定 2026-09-26）：只有 ok 的结果算「已拉过」——否则
  //      一次瞬时失败会让该渠道**到刷新页面为止**都选不了模型（菜单形态没有重拉按钮，展开即自动重试
  //      是唯一退路）。调用点全在事件处理器里，无 effect 依赖 ⇒ 不会成重拉循环。
  //      不设「忽略缓存重拉」参数：三处调用点都只要「没拉过就拉」——真要重拉时再加，别留死参。） ----
  const ensureModels = async (name: string) => {
    const cached = modelsCache[name]
    if (loadingOpen.has(name) || (cached && cached.ok)) return
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

  /** 超时控制（停滞自动中止）开关：点即落盘（热生效，运行中的回合也不受影响——服务端每跳重读） */
  const toggleWatchdog = async (enabled: boolean) => {
    setErr(null)
    try {
      await api.setWatchdog(enabled)
      setWatchdog(enabled)
      flash(enabled ? "已开启超时控制" : "已关闭超时控制——不再有任何提前中止")
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

  const consultModels = consult?.models ?? []
  const consultMax = consult?.max ?? 5
  // 「＋ 添加模型」那一行（菜单行号 -1）只是菜单的锚点，不是清单里的条目 —— 是否已达上限只看已保存条数
  const consultFull = consultModels.length >= consultMax

  /** 一行会诊模型的控件（已保存行与「＋ 添加模型」行共用；作为**函数调用**内联而不是组件——
   *  包成组件会因组件标识每次渲染都变而整棵重挂载，菜单滚动位置会当场丢失）。
   *  `slot`：已保存行 = 下标；-1 = 「＋ 添加模型」行。
   *  与「子代理模型」区块同款二级菜单（一级渠道 → 二级模型清单、点选即落盘），三处**有意的差别**：
   *  ⓵ 无「跟随主线」（会诊每条必须指向具体模型，没有继承语义）；⓶ 无思考档位控件（不提供配置入口；
   *  已存在的 effort 原样保留，见 saveConsult）；⓷ 无手输兜底与「重新拉取」按钮（用户裁定
   *  2026-09-26：清单拉不到时该渠道在菜单里就是选不了——与子代理区块同一取舍；拉取失败**不当缓存**，
   *  重新展开即自动重试，失败行里也写明这句退路）。 */
  const renderConsultRow = (o: { key: string; slot: number; provider: string; model: string }) => {
    const menuOpen = consultMenu === o.slot
    const current = o.provider && o.model ? `${o.provider}:${o.model}` : null
    return (
      <div key={o.key} className="flex flex-wrap items-center gap-2">
        <span className="w-4 shrink-0 text-xs tabular-nums text-t4">{o.slot < 0 ? "＋" : o.slot + 1}</span>
        <div className="relative min-w-0 max-w-xs flex-1">
          <button
            onClick={() => {
              setConsultExpand(null)
              setConsultMenu(menuOpen ? null : o.slot)
            }}
            disabled={busy}
            className="field flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs"
          >
            <FloatingTooltip label={current ?? undefined} className="min-w-0">
              <span className={`block w-full truncate ${current ? "font-mono" : "text-t3"}`}>{current ?? "选择模型"}</span>
            </FloatingTooltip>
            <span className="shrink-0 text-t4">▾</span>
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => { setConsultMenu(null); setConsultExpand(null) }} />
              <div className="absolute left-0 top-full z-50 mt-1.5 max-h-72 w-64 overflow-y-auto rounded-xl border border-line bg-surface shadow-lg">
                <div className="sticky top-0 border-b border-line bg-surface px-3.5 py-2 text-xs text-t4">选择渠道 → 模型</div>
                {cfg?.providers.map((pv) => {
                  const expanded = consultExpand === `${o.slot}:${pv.name}`
                  const picked = Boolean(current?.startsWith(`${pv.name}:`))
                  // 渠道行右侧展示（纯显示派生，零刷新机制）：本行当前所选就在该渠道 → 显示所选模型；
                  // 否则显示该渠道的默认模型
                  const rowModel = picked ? (current ?? "").slice(pv.name.length + 1) : pv.model
                  return (
                    <div key={pv.name} className="border-t border-line/60 first:border-t-0">
                      <button
                        onClick={async () => {
                          if (expanded) { setConsultExpand(null); return }
                          setConsultExpand(`${o.slot}:${pv.name}`)
                          await ensureModels(pv.name) // 共享缓存；失败不当缓存 ⇒ 再次展开即重试
                        }}
                        className={`flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs transition-colors hover:bg-hover ${picked ? "text-accent" : "text-t2"}`}
                      >
                        <span className={`w-3.5 shrink-0 ${picked ? "" : "invisible"}`}>✓</span>
                        <span className="shrink-0 font-medium">{pv.name}</span>
                        <FloatingTooltip label={rowModel} className="min-w-0"><span className="block w-full truncate font-mono text-t4">{rowModel}</span></FloatingTooltip>
                        <span className="ml-auto shrink-0 text-t4">{expanded ? "▾" : "▸"}</span>
                      </button>
                      {expanded && (
                        <div className="bg-surface2/40 pb-1">
                          {loadingOpen.has(pv.name) && (
                            <div className="px-3.5 py-1.5 pl-9 text-xs text-t4">拉取模型清单中…</div>
                          )}
                          {modelsCache[pv.name] && !modelsCache[pv.name].ok && !loadingOpen.has(pv.name) && (
                            <div className="px-3.5 py-1.5 pl-9 text-xs text-red-300">
                              拉取失败：{modelsCache[pv.name].reason ?? modelsCache[pv.name].error}——重新展开即重试
                            </div>
                          )}
                          {modelsCache[pv.name]?.list?.map((m) => (
                            <button
                              key={m}
                              onClick={() => void pickConsultModel(o.slot, pv.name, m)}
                              className={`flex w-full items-center gap-2 py-1.5 pl-9 pr-3.5 text-left text-xs transition-colors hover:bg-hover ${current === `${pv.name}:${m}` ? "text-accent" : "text-t2"}`}
                            >
                              <span className={`w-3.5 shrink-0 ${current === `${pv.name}:${m}` ? "" : "invisible"}`}>✓</span>
                              <FloatingTooltip label={m} className="min-w-0"><span className="block w-full truncate font-mono">{m}</span></FloatingTooltip>
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
        {/* 菜单开着时铺了一层 `fixed inset-0 z-40` 的点闭合膜；本行 ✕ 必须抬到它之上，
            否则首击被当成「点了别处」（只关菜单、不删行）——得点两下才删得掉。 */}
        {o.slot >= 0 && (
          <button
            onClick={() => removeConsultRow(o.slot)}
            disabled={busy}
            className={`ml-auto shrink-0 rounded-lg px-2 py-1.5 text-xs text-t3 transition-colors hover:bg-hover hover:text-red-300${menuOpen ? " relative z-50" : ""}`}
          >
            ✕
          </button>
        )}
      </div>
    )
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
                  {/* 摘要串会先被截断（渠道模型名普遍很长），而 baseURL 不是用户要读的东西
                      （用户裁定 2026-09-27：baseURL 不需要显示）⇒ 浮层只给**完整模型名**。 */}
                  <FloatingTooltip label={p.model} className="min-w-0 flex-1">
                    <span className="block w-full truncate font-mono text-xs text-t4">
                      {p.model} · {p.baseURL}
                    </span>
                  </FloatingTooltip>
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
                          {modelsCache[p.name] && !modelsCache[p.name].ok && !loadingOpen.has(p.name) && (
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
                                <FloatingTooltip label={m} className="min-w-0"><span className="block w-full truncate font-mono">{m}</span></FloatingTooltip>
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
                      <FloatingTooltip label={current ?? undefined} className="min-w-0">
                        <span className={`block w-full truncate ${current ? "font-mono" : "text-t3"}`}>{current ?? "跟随主线"}</span>
                      </FloatingTooltip>
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
                                  <FloatingTooltip label={rowModel} className="min-w-0"><span className="block w-full truncate font-mono text-t4">{rowModel}</span></FloatingTooltip>
                                  <span className="ml-auto shrink-0 text-t4">{expanded ? "▾" : "▸"}</span>
                                </button>
                                {expanded && (
                                  <div className="bg-surface2/40 pb-1">
                                    {loadingOpen.has(pv.name) && (
                                      <div className="px-3.5 py-1.5 pl-9 text-xs text-t4">拉取模型清单中…</div>
                                    )}
                                    {modelsCache[pv.name] && !modelsCache[pv.name].ok && !loadingOpen.has(pv.name) && (
                                      <div className="px-3.5 py-1.5 pl-9 text-xs text-red-300">拉取失败：{modelsCache[pv.name].error}</div>
                                    )}
                                    {modelsCache[pv.name]?.list?.map((m) => (
                                      <button
                                        key={m}
                                        onClick={() => { setSubMenuOpen(null); setSubProvOpen(null); saveSubModel(role.key, `${pv.name}:${m}`) }}
                                        className={`flex w-full items-center gap-2 py-1.5 pl-9 pr-3.5 text-left text-xs transition-colors hover:bg-hover ${current === `${pv.name}:${m}` ? "text-accent" : "text-t2"}`}
                                      >
                                        <span className={`w-3.5 shrink-0 ${current === `${pv.name}:${m}` ? "" : "invisible"}`}>✓</span>
                                        <FloatingTooltip label={m} className="min-w-0"><span className="block w-full truncate font-mono">{m}</span></FloatingTooltip>
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

      {/* ================= 会诊模型 ================= */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-t1">会诊模型</h2>
          <p className="mt-0.5 text-xs text-t4">
            模型卡壳时，或你输入「会诊」时，几个模型顾问会同时独立分析同一问题，结论自动回到对话。
          </p>
        </div>
        <button
          onClick={() => {
            setConsultExpand(null)
            setConsultMenu(consultMenu === -1 ? null : -1)
          }}
          disabled={busy || consultFull || !cfg || cfg.providers.length === 0 || consultErr}
          className="btn-primary shrink-0 px-3.5 py-1.5 text-xs disabled:opacity-40"
        >
          ＋ 添加模型
        </button>
      </div>
      <div className="mb-7 rounded-xl border border-line bg-surface px-4 py-3.5">
        {cfg && cfg.providers.length === 0 ? (
          <div className="text-xs text-t4">先在上方「模型供应商」配置渠道，才能配置会诊模型。</div>
        ) : (
          <div className="flex flex-col gap-3">
            {consultErr && (
              <div className="text-xs text-red-300">
                会诊模型清单读取失败——刷新页面重试；在此之前不会写入，以免覆盖已有条目。
              </div>
            )}
            {!consultErr && consultModels.length === 0 && consultMenu !== -1 && (
              <div className="text-xs text-t4">尚未配置——配置 1 个即可启用，配置 2 个以上才能互相印证。</div>
            )}
            {consultModels.map((row, i) =>
              renderConsultRow({ key: `row-${i}`, slot: i, provider: row.provider, model: row.model }),
            )}
            {/* 「＋ 添加模型」那一行：只是给菜单一个锚点，点选模型后立即追加（固定 key，不与已有行冲突） */}
            {!consultErr && consultMenu === -1 && renderConsultRow({ key: "draft", slot: -1, provider: "", model: "" })}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-line/60 pt-2.5 text-xs text-t4">
              <span>{consultErr ? "清单未读到" : `已配置 ${consultModels.length} / ${consultMax}`}</span>
              {consultFull && !consultErr && <span className="text-amber-400">已达上限——删除一个才能再加</span>}
              <span className="ml-auto">改动从下一次对话回合起生效，运行中的不变 · Plan 模式下无法发起会诊</span>
            </div>
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

      {/* ================= 性能（超时控制） ================= */}
      <h2 className="mb-3 text-sm font-medium text-t1">性能</h2>
      <div className="mb-7 rounded-xl border border-line bg-surface px-4 py-4">
        <label className="flex w-fit cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            role="switch"
            // 与服务端同一条口径：**只有显式 false 才算关**——读到之前（null）不谎报成「关」
            aria-checked={watchdog !== false}
            checked={watchdog !== false}
            disabled={watchdog === null}
            onChange={(e) => toggleWatchdog(e.target.checked)}
            className="accent-accent"
          />
          <span className="text-xs font-medium text-t1">超时控制</span>
        </label>
        <div className="mt-2 text-xs leading-relaxed text-t4">
          无任何事件达阈值即自动中止本轮（基线 3 分钟；挂起期 10 分钟；定时任务 30 分钟；execute / bash / git / 上下文压缩按各自预算放宽）
        </div>
        {watchdog === false && (
          <div className="mt-2 text-xs leading-relaxed text-t4">
            关闭后不再有任何提前中止，一切交回内核的超时设置——但内核的上下文压缩与上游 LLM 请求都没有超时设置，真卡住时该项目会一直处于忙时状态，届时只能重启服务。
          </div>
        )}
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
