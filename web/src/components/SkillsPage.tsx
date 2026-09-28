import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { marked } from "marked"
import { api } from "../lib/api"
import DirPicker from "./DirPicker"
import { FloatingTooltip } from "./Tooltip"
import type {
  SkillEntry,
  SkillFormat,
  SkillIgnored,
  SkillImportCandidate,
  SkillImportItemResult,
  SkillImportKind,
  SkillImportPlan,
  SkillImportResult,
  SkillLayer,
  SkillLayerState,
  SkillOpResponse,
  SkillsResponse,
} from "../lib/types"

// marked 全局选项与 DocPanel.tsx:6 同源（同一份正文在两处渲染结果必须一致）
marked.setOptions({ gfm: true, breaks: true })

/** 与内核 skills.mjs:18 的 NAME_RE 同源：内核不认的名字**静默忽略**（清单里凭空少一条），
 *  前端先拦住并把原因说清——否则用户写完保存成功、agent 却永远看不见它 */
const NAME_RE = /^[a-zA-Z0-9_-]+$/
const NAME_HINT = "只能字母、数字、下划线、连字符"

const rowKey = (layer: SkillLayer, name: string) => `${layer}:${name}`
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 层级记忆（新建技能表单与导入面板**共用同一个键**）：记住用户上次选的那一层，下次开面板直接用它 */
const LAYER_KEY = "tcw-skills-layer"
function readLayerMemory(): SkillLayer | null {
  try {
    const v = localStorage.getItem(LAYER_KEY)
    return v === "project" || v === "user" ? v : null // 值非法（手改 / 旧版本残留）即忽略，绝不猜
  } catch {
    return null // 隐私模式等读不了 localStorage：退回缺省，不打断操作
  }
}
function writeLayerMemory(l: SkillLayer) {
  try {
    localStorage.setItem(LAYER_KEY, l)
  } catch { /* 写不了 = 只是不记忆，不是错误 */ }
}
/** 打开表单/面板时的默认层：记忆值优先；未打开项目 ⇒ 强制「用户」（且**不改写**存储值——项目层无从谈起） */
const defaultLayer = (project: string | null): SkillLayer => (project ? (readLayerMemory() ?? "project") : "user")

/** 新建骨架：首行标题（内核取描述时跳过 # 行），次行写描述 */
const skeleton = (name: string) => `# ${name || "技能名"}\n\n一句话描述这个技能做什么。\n`
/** 描述提取规则的内核原句（**只在表单页脚用**）。空态自 2026-09-27 用户裁定改为一句引导语，不再罗列格式与描述规则；
 *  原来的 `FORMAT_HINT`（`name.md` / `name/SKILL.md` 两种物理格式）随之失去 UI 落点，已删——
 *  格式口径仍记在项目手动清单第 11 节里（内部文档，不随公仓发布）。 */
const DESC_HINT = "描述取自正文前 400 字符里、跳过 --- frontmatter 与 # 标题行后的第一个非空行（≤120 字）"
/** 空态：用户裁定（2026-09-27）只要一句引导语 */
const EMPTY_HINT = "还没有安装技能，请点击「＋ 导入」安装新技能。"

/** 遮蔽徽标文案：由数据（赢家在哪层、哪种格式）决定，不由本行层级猜——猜就会说出
 *  「子目录行被同名子目录技能遮蔽」这类自指错话 */
function shadowHint(layer: SkillLayer, by: SkillEntry["shadowedBy"]): string {
  if (!by) return ""
  if (by.layer !== layer) return by.layer === "project" ? "被项目层同名技能遮蔽" : "被用户层同名技能遮蔽"
  return by.format === "dir" ? "被同名子目录技能遮蔽" : "被同层同名文件遮蔽"
}

interface Props {
  project: string | null
  onActivate: (name: string) => void
}

interface FormState {
  mode: "create" | "edit"
  layer: SkillLayer
  name: string
  /** 编辑态：打开的是哪个物理落点（存档时必须原路写回）；新建态无此值（新建一律扁平） */
  format?: SkillFormat
}

/** 行内操作回执（去掉这堆 prop 会把四个子组件拧成一团） */
interface RowOps {
  renaming: string | null
  renameTo: string
  confirming: string | null
  busy: boolean
  onActivate: (name: string) => void
  onEdit: (layer: SkillLayer, name: string, format: SkillFormat) => void
  onStartRename: (k: string, layer: SkillLayer, name: string, format: SkillFormat) => void
  onRenameTo: (v: string) => void
  onRenameOk: (layer: SkillLayer, name: string, format: SkillFormat) => void
  onStartDelete: (key: string) => void
  onDeleteOk: (layer: SkillLayer, name: string, format: SkillFormat, whole?: boolean) => void
  onCancel: () => void
}

const errBar = "mb-4 rounded-xl border border-red-900 bg-red-950 px-3.5 py-2.5 text-xs text-red-300"
const noticeBar = "mb-4 rounded-xl border border-emerald-900 bg-emerald-950 px-3.5 py-2.5 text-xs text-emerald-300"
/** 行内图标按钮（载入到对话 / 更多）：与 NavRail 的图标按钮同尺寸口径 */
const iconBtn =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-t3 transition-colors hover:bg-hover hover:text-t1 disabled:cursor-not-allowed disabled:opacity-60"

/** 技能页 —— 内核 skill 系统的管理面：两层列表（含内核不认的条目）、新建/编辑/重命名/删除、载入到对话 */
export default function SkillsPage({ project, onActivate }: Props) {
  const [data, setData] = useState<SkillsResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [form, setForm] = useState<FormState | null>(null)
  const [importing, setImporting] = useState(false)
  const [fContent, setFContent] = useState("")
  const [fDirty, setFDirty] = useState(false) // 用户动过正文 ⇒ 不再跟着名字重生骨架
  const [fPreview, setFPreview] = useState(false)

  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameTo, setRenameTo] = useState("")
  const [confirming, setConfirming] = useState<string | null>(null)

  const load = useCallback(() => {
    api
      .skills(project)
      .then((r) => {
        setData(r)
        setErr(null)
      })
      .catch((e) => setErr(errMsg(e)))
  }, [project])

  useEffect(load, [load])

  /** 写操作统一收尾：响应里的全景直接替换本地数据（页面显示 = 服务端 = 内核所见），
   *  warnings/note 进 notice 条，错误进 err 条（服务端文案是中文、可直接展示） */
  const apply = (r: SkillOpResponse) => {
    // note 只走绿条（本次操作的结果），不再留在 data.note 里——否则同一条提示会**同时**出现在
    // 琥珀色数据条与绿条上（用户 2026-09-28 报的「整个目录已删除…」红绿两条同样内容，就是这个重复）
    setData({ ...r, note: null })
    const notes = [...(r.warnings ?? []), ...(r.note ? [r.note] : [])]
    setNotice(notes.length ? notes.join("；") : null)
  }

  const run = async (fn: () => Promise<SkillOpResponse>) => {
    setBusy(true)
    setErr(null)
    try {
      apply(await fn())
      return true
    } catch (e) {
      setErr(errMsg(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  /** 新建入口：**当前界面不暴露**（用户裁定界面简化，见头部按钮处的注释）——能力保留，供将来恢复入口用 */
  const openCreate = () => {
    setErr(null)
    setNotice(null)
    setImporting(false) // 一次只开一个面板
    // 层级取记忆值（未打开项目 → 强制用户层）：与导入面板共用同一个键
    setForm({ mode: "create", layer: defaultLayer(project), name: "" })
    setFContent(skeleton(""))
    setFDirty(false)
    setFPreview(false)
  }

  /** 导入面板：同样先收起另一个面板（导入用完的暂存由面板自己放弃/TTL 兜底） */
  const openImport = () => {
    setErr(null)
    setNotice(null)
    setForm(null)
    setImporting(true)
  }

  /** 编辑：读的必须是该行对应的那个物理文件——同层同名时按名读会读到另一条 */
  const openEdit = async (layer: SkillLayer, name: string, format: SkillFormat) => {
    setErr(null)
    setNotice(null)
    setBusy(true)
    try {
      const f = await api.skillFile(project, layer, name, format)
      setForm({ mode: "edit", layer, name, format: f.format })
      setFContent(f.text)
      setFDirty(true)
      setFPreview(false)
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const changeName = (v: string) => {
    setForm((f) => (f ? { ...f, name: v } : f))
    if (!fDirty) setFContent(skeleton(v))
  }

  const save = async () => {
    if (!form) return
    // 编辑态带上 form.format：只写当初打开的那个落点（同层同名时否则会打到另一条身上）
    const p = { project, layer: form.layer, name: form.name, content: fContent, ...(form.format ? { format: form.format } : {}) }
    const done = form.mode === "create" ? await run(() => api.createSkill(p)) : await run(() => api.saveSkill(p))
    if (done) setForm(null)
  }

  const startRename = (k: string, layer: SkillLayer, name: string) => {
    setConfirming(null)
    setErr(null)
    setRenaming(k)
    setRenameTo(name)
  }

  const doRename = async (layer: SkillLayer, name: string, format: SkillFormat) => {
    const to = renameTo.trim()
    if (!NAME_RE.test(to)) return
    if (await run(() => api.renameSkill({ project, layer, name, to, format }))) setRenaming(null)
  }

  const doDelete = async (layer: SkillLayer, name: string, format: SkillFormat, whole = false) => {
    if (await run(() => api.deleteSkill({ project, layer, name, format, ...(whole ? { whole: true } : {}) }))) setConfirming(null)
  }

  const ops: RowOps = {
    renaming,
    renameTo,
    confirming,
    busy,
    onActivate,
    onEdit: openEdit,
    onStartRename: startRename,
    onRenameTo: setRenameTo,
    onRenameOk: doRename,
    onStartDelete: (k) => {
      setRenaming(null)
      setErr(null)
      setConfirming(k)
    },
    onDeleteOk: doDelete,
    onCancel: () => {
      setRenaming(null)
      setConfirming(null)
    },
  }

  const previewHtml = useMemo(() => {
    try {
      return marked.parse(fContent, { async: false }) as string
    } catch {
      return ""
    }
  }, [fContent])

  const nameOk = form ? NAME_RE.test(form.name) : false

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto px-8 py-8">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-[-0.01em] text-t1">技能</h1>
          <p className="mt-1 text-xs leading-relaxed text-t4">
            技能 = 可复用的指令，Agent 按需载入（对话里可以说「加载技能 名称」）。创建或编辑技能后会在下一轮对话中生效，无需重启。
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button onClick={load} className="btn-ghost px-3 py-1.5 text-xs">
            刷新
          </button>
          <button data-import="open" onClick={openImport} className="btn-primary px-3.5 py-1.5 text-xs">
            ＋ 导入
          </button>
          {/* 「＋ 新建技能」入口按用户裁定（2026-09-27）从界面移除、**能力保留**：openCreate 与 SkillForm
              原样留在本文件、服务端 POST /api/skills 也未动——要恢复入口，把本注释换回上面那三行按钮。 */}
        </div>
      </div>

      {err && (
        <div data-skills-err className={errBar}>
          {err}
          <button className="ml-2 underline" onClick={() => setErr(null)}>
            关闭
          </button>
        </div>
      )}
      {notice && (
        <div data-skills-notice className={noticeBar}>
          {notice}
          <button className="ml-2 underline" onClick={() => setNotice(null)}>
            关闭
          </button>
        </div>
      )}
      {data?.note && (
        <div className="mb-4 rounded-xl border border-amber-900 bg-amber-950 px-3.5 py-2.5 text-xs text-amber-300">{data.note}</div>
      )}
      {data && data.effective.length > 3 && (
        <div className="mb-4 text-xs text-t4">
          系统清单只列前 3 条，其余 agent 可按名载入（当前 {data.effective.length} 条生效）
        </div>
      )}

      {/* 导入面板与新建表单同理：层级选择写进同一个记忆键 */}
      {importing && (
        <SkillImportPanel
          project={project}
          onClose={() => setImporting(false)}
          onError={setErr}
          onNotice={setNotice}
          onApplied={(r) => apply(r)}
        />
      )}

      {form && (
        <SkillForm
          form={form}
          project={project}
          content={fContent}
          preview={fPreview}
          previewHtml={previewHtml}
          nameOk={nameOk}
          busy={busy}
          onChangeName={changeName}
          // 层级选择同时写进记忆键：下次开表单/导入面板默认就是它（未打开项目时表单根本切不到项目层）
          onChangeLayer={(l) => {
            writeLayerMemory(l)
            setForm((f) => (f ? { ...f, layer: l } : f))
          }}
          onChangeContent={(v) => {
            setFContent(v)
            setFDirty(true)
          }}
          onTogglePreview={() => setFPreview((v) => !v)}
          onSubmit={save}
          onCancel={() => setForm(null)}
        />
      )}

      {(data?.layers ?? []).map((l) => (
        <LayerBlock key={l.layer} state={l} project={project} ops={ops} />
      ))}

      <div className="rounded-xl border border-line bg-surface px-4 py-3.5 text-xs leading-relaxed text-t4">
        <div className="mb-1 font-medium text-t3">说明</div>
        <ul className="list-disc space-y-1 pl-4">
          <li>项目技能只对当前项目可见；用户技能（全局）在你所有项目里都可见。</li>
          <li>同名时项目层优先：用户层那条被遮蔽，不会进 agent 的清单（本页会用徽标标出来）。</li>
          <li>子目录技能可以带资源文件（脚本、模板）；删除时只删 SKILL.md，目录里还有东西就保留。</li>
        </ul>
      </div>
    </div>
  )
}

/** 新建 / 编辑表单（编辑时层级与名字只读：改名走「重命名」，一次操作只一种语义） */
function SkillForm(props: {
  form: FormState
  project: string | null
  content: string
  preview: boolean
  previewHtml: string
  nameOk: boolean
  busy: boolean
  onChangeName: (v: string) => void
  onChangeLayer: (l: SkillLayer) => void
  onChangeContent: (v: string) => void
  onTogglePreview: () => void
  onSubmit: () => void
  onCancel: () => void
}) {
  const { form, project, content, preview, previewHtml, nameOk, busy } = props
  const editing = form.mode === "edit"
  return (
    <div className="mb-7 rounded-xl border border-line bg-surface px-4 py-4 shadow-sm">
      <div className="mb-3 text-sm font-medium text-t2">{editing ? `编辑技能：${form.name}` : "新建技能"}</div>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <input
          value={form.name}
          onChange={(e) => props.onChangeName(e.target.value)}
          disabled={editing}
          placeholder="技能名（字母、数字、下划线、连字符）"
          className="field px-3 py-2 font-mono text-xs disabled:opacity-60"
        />
        <div className="seg">
          <button
            data-form-layer="project"
            data-on={form.layer === "project"}
            onClick={() => props.onChangeLayer("project")}
            disabled={editing || !project}
            title={project ? undefined : "未打开项目"}
          >
            项目
          </button>
          <button data-form-layer="user" data-on={form.layer === "user"} onClick={() => props.onChangeLayer("user")} disabled={editing}>
            用户
          </button>
        </div>
      </div>
      {!nameOk && <div className="mt-1.5 text-xs text-red-400">名称{NAME_HINT}</div>}
      {editing && (
        <div className="mt-1.5 text-xs text-t4">
          层级与名称不可改：改名用该行的「重命名」（层目录：<span className="font-mono">{form.layer}</span> 层）
        </div>
      )}

      <div className="mt-3 mb-1.5 flex items-center justify-between">
        <span className="text-xs text-t3">正文（Markdown）</span>
        <div className="seg">
          <button data-on={!preview} onClick={() => preview && props.onTogglePreview()}>
            正文
          </button>
          <button data-on={preview} onClick={() => !preview && props.onTogglePreview()}>
            预览
          </button>
        </div>
      </div>
      {preview ? (
        // 渲染容器约束与 DocPanel 的 Markdown 视图一致（同一 .md 样式），不引入新依赖
        <div className="max-h-80 overflow-y-auto rounded-lg border border-line2 bg-surface2">
          <div className="md px-3 py-3" dangerouslySetInnerHTML={{ __html: previewHtml }} />
        </div>
      ) : (
        <textarea
          value={content}
          onChange={(e) => props.onChangeContent(e.target.value)}
          rows={10}
          spellCheck={false}
          className="field w-full px-3 py-2 font-mono text-xs"
        />
      )}

      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-t4">{DESC_HINT}</span>
        <div className="flex gap-2">
          <button onClick={props.onCancel} className="btn-ghost px-3.5 py-1.5 text-xs">
            取消
          </button>
          <button onClick={props.onSubmit} disabled={busy || !nameOk} className="btn-primary px-4 py-1.5 text-xs">
            {busy ? "保存中…" : editing ? "保存" : "新建"}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 一层区块：标题 + 层目录 + 条目 + 内核不认的条目 */
function LayerBlock({ state, project, ops }: { state: SkillLayerState; project: string | null; ops: RowOps }) {
  const isProject = state.layer === "project"
  const blocked = isProject && !project // 未打开项目 ⇒ 项目层无从谈起
  return (
    <div className="mb-7">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-sm font-medium text-t2">{isProject ? "项目技能" : "用户技能"}</h2>
        <span className="min-w-0 truncate font-mono text-xs text-t4">{state.dir ?? "（未打开项目）"}</span>
        {!isProject && <span className="text-xs text-t4">全局：你所有项目都可见</span>}
      </div>
      <div className="overflow-hidden rounded-xl border border-line">
        {blocked ? (
          <div className="px-4 py-6 text-center text-xs text-t4">未打开项目</div>
        ) : state.skills.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs leading-relaxed text-t4">{EMPTY_HINT}</div>
        ) : (
          // 行键用物理路径（唯一），不用 layer:name：同层「子目录 + 同名扁平」会产出两条同名条目
          // （内核只采用子目录那条），用名字当键会让两行撞键、操作串到对方身上。行上每个操作都带上
          // 自己的 format ⇒ 两条同名行各归各的物理文件，谁都不会打到对方身上。
          state.skills.map((s) => (
            <SkillRow key={s.path} entry={s} layer={state.layer} ops={ops} canActivate={project !== null} />
          ))
        )}
        {!blocked && state.ignored.length > 0 && <IgnoredList items={state.ignored} />}
      </div>
    </div>
  )
}

/** 内核不认的条目：内核静默忽略它们，这里单独列出来把原因说清（否则用户查不出「为什么不生效」） */
function IgnoredList({ items }: { items: SkillIgnored[] }) {
  return (
    <div className="border-t border-line bg-surface2 px-4 py-2.5">
      <div className="mb-1.5 text-xs font-medium text-t4">未被内核识别（{items.length}）</div>
      {items.map((g) => (
        <div key={g.entry} className="flex flex-wrap items-baseline gap-x-2 py-0.5 text-xs text-t4">
          <span className="font-mono text-t3">{g.entry}</span>
          <span className="rounded-full border border-line2 px-1.5 text-xs">未被内核识别</span>
          <span className="min-w-0 truncate">{g.reason}</span>
        </div>
      ))}
    </div>
  )
}

/** 单个技能行：名字 + 描述 + 格式徽标 + 操作（遮蔽条目置灰、不给「载入到对话」） */
function SkillRow(props: {
  entry: SkillEntry
  layer: SkillLayer
  ops: RowOps
  /** 项目未打开时不能载入（载入要在对话里进行）——按钮置灰；原因由页面顶部与提示条承担
   *  （用户裁定 2026-09-27：这一行不要悬停气泡） */
  canActivate: boolean
}) {
  const { entry, layer, ops, canActivate } = props
  const k = entry.path // 行内表单的开合键：用路径（唯一），不用名字（同层同名会撞）
  const formOpen = ops.renaming === k || ops.confirming === k
  /** 「更多」菜单（重命名 / 删除 / 编辑收进这里，用户裁定 2026-09-28） */
  const [menu, setMenu] = useState(false)
  /** 菜单坐标（fixed 定位，量出来才有值；未量到前用 visibility:hidden 占位） */
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const desc = entry.declaredDescription ?? entry.description

  // 菜单用 **fixed** 定位而不是 absolute：它落在滚动容器里，absolute 会被容器裁掉半截——
  // 用户 2026-09-28 报的「菜单显示不完整」就是这个。量按钮与菜单盒子，下方不够就上翻（同 FloatingTooltip 的做法）。
  const placeMenu = useCallback(() => {
    const btn = moreRef.current
    const box = menuRef.current
    if (!btn || !box) return
    const r = btn.getBoundingClientRect()
    const h = box.offsetHeight
    const w = box.offsetWidth
    const top = window.innerHeight - r.bottom - 8 >= h + 4 ? r.bottom + 4 : Math.max(8, r.top - 4 - h)
    const left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8)
    setMenuPos({ left, top })
  }, [])

  useLayoutEffect(() => {
    if (menu) placeMenu()
  }, [menu, placeMenu])

  useEffect(() => {
    if (!menu) return
    window.addEventListener("scroll", placeMenu, true)
    window.addEventListener("resize", placeMenu)
    return () => {
      window.removeEventListener("scroll", placeMenu, true)
      window.removeEventListener("resize", placeMenu)
    }
  }, [menu, placeMenu])
  return (
    <div
      // data-skill = 物理路径（唯一，操作断言用）；data-skill-name = 层:名（同名两行的分组断言用）
      data-skill={entry.path}
      data-skill-name={rowKey(layer, entry.name)}
      className={`border-t border-line px-4 py-3 first:border-t-0 ${entry.shadowed ? "opacity-60" : ""}`}
    >
      <div className="flex items-center gap-2.5">
        <span className={`shrink-0 text-sm font-medium ${entry.effective ? "text-t1" : "text-t3"}`}>{entry.name}</span>
        {entry.shadowed && (
          <span className="shrink-0 rounded-full border border-amber-900 bg-amber-950 px-2 py-0.5 text-xs text-amber-300">
            {shadowHint(layer, entry.shadowedBy)}
          </span>
        )}
        {/* 描述：截断显示 + 悬停看全文（列表在滚动容器里 ⇒ 用 FloatingTooltip；文本没被截断就不弹） */}
        <FloatingTooltip label={desc} className="min-w-0 flex-1">
          <span className="block truncate text-xs text-t4">{desc}</span>
        </FloatingTooltip>
        {!formOpen && (
          <>
            {entry.effective && (
              <FloatingTooltip label={canActivate ? "载入到对话" : "先打开一个项目：载入要在对话里进行"} always>
                <button
                  data-row-act="load"
                  onClick={() => ops.onActivate(entry.name)}
                  disabled={!canActivate}
                  aria-label="载入到对话"
                  className={iconBtn}
                >
                  {/* 字形含义 = 执行 / 运行 / 使用（用户 2026-09-28 明确：右箭头容易被读成「展开」） */}
                  <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5.6 3.8l6.6 4.2-6.6 4.2z" />
                  </svg>
                </button>
              </FloatingTooltip>
            )}
            <div className="relative shrink-0">
              {/* 菜单开着时不再弹提示（否则浮层压在菜单上） */}
              <FloatingTooltip label={menu ? undefined : "更多操作"} always>
                <button ref={moreRef} data-row-act="more" onClick={() => setMenu((v) => !v)} aria-label="更多操作" className={iconBtn}>
                  ⋯
                </button>
              </FloatingTooltip>
              {menu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setMenu(false)} />
                  <div
                    ref={menuRef}
                    data-row-menu
                    style={menuPos ? { left: menuPos.left, top: menuPos.top } : { left: 0, top: 0, visibility: "hidden" }}
                    className="fixed z-50 w-28 overflow-hidden rounded-xl border border-line2 bg-surface2 py-1 shadow-lg"
                  >
                    <button
                      data-row-item="edit"
                      onClick={() => {
                        setMenu(false)
                        ops.onEdit(layer, entry.name, entry.format)
                      }}
                      className="block w-full px-3 py-1.5 text-left text-xs text-t2 transition-colors hover:bg-hover"
                    >
                      编辑
                    </button>
                    <button
                      data-row-item="rename"
                      onClick={() => {
                        setMenu(false)
                        ops.onStartRename(k, layer, entry.name, entry.format)
                      }}
                      className="block w-full px-3 py-1.5 text-left text-xs text-t2 transition-colors hover:bg-hover"
                    >
                      重命名
                    </button>
                    <button
                      data-row-item="delete"
                      onClick={() => {
                        setMenu(false)
                        ops.onStartDelete(k)
                      }}
                      className="block w-full px-3 py-1.5 text-left text-xs text-red-300 transition-colors hover:bg-red-950"
                    >
                      删除
                    </button>
                  </div>
                </>
              )}
            </div>
          </>
        )}
      </div>

      {ops.renaming === k && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            value={ops.renameTo}
            onChange={(e) => ops.onRenameTo(e.target.value)}
            className="field px-2.5 py-1.5 font-mono text-xs"
            placeholder="新名称"
          />
          <button
            onClick={() => ops.onRenameOk(layer, entry.name, entry.format)}
            disabled={ops.busy || !NAME_RE.test(ops.renameTo.trim()) || ops.renameTo.trim() === entry.name}
            className="btn-primary px-3 py-1.5 text-xs"
          >
            确认重命名
          </button>
          <button onClick={ops.onCancel} className="btn-ghost px-3 py-1.5 text-xs">
            取消
          </button>
          {!NAME_RE.test(ops.renameTo.trim()) && <span className="text-xs text-red-400">新名称{NAME_HINT}</span>}
          {NAME_RE.test(ops.renameTo.trim()) && ops.renameTo.trim() === entry.name && (
            <span className="text-xs text-t4">名称未变化</span>
          )}
        </div>
      )}

      {ops.confirming === k && (
        <div className="mt-2 text-xs">
          {/* 提示与警告排在一起（用户裁定 2026-09-28），下面单独一排放三个按钮 */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-red-300">确认删除？</span>
            {layer === "user" && <span className="text-amber-300">这是全局技能，删除会影响你所有项目</span>}
            {entry.format === "dir" && <span className="text-t4">默认只删 SKILL.md，目录里的其它文件保留</span>}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              onClick={() => ops.onDeleteOk(layer, entry.name, entry.format)}
              disabled={ops.busy}
              className="rounded-lg border border-red-900 px-2.5 py-1 text-xs text-red-300 transition-colors hover:bg-red-950"
            >
              确认删除
            </button>
            {entry.format === "dir" && (
              <button
                data-row-act="delete-whole"
                onClick={() => ops.onDeleteOk(layer, entry.name, entry.format, true)}
                disabled={ops.busy}
                className="rounded-lg border border-red-900 px-2.5 py-1 text-xs text-red-300 transition-colors hover:bg-red-950"
              >
                删除整个目录
              </button>
            )}
            <button onClick={ops.onCancel} className="btn-ghost px-3 py-1.5 text-xs">
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ================= 导入面板（两段式：扫描只读 → 导入才写） =================

/** 每行候选的选择态：checked = 本次是否导入；action = 目标已存在时怎么办（跳过 / 覆盖） */
interface ImportPick {
  checked: boolean
  action: "skip" | "overwrite"
}

const pickOf = (m: Record<string, ImportPick>, name: string): ImportPick => m[name] ?? { checked: false, action: "skip" }

const resultText = (r: SkillImportItemResult): string => {
  const label = r.status === "written" ? "已写入" : r.status === "skipped" ? "已跳过（目标已存在，未覆盖）" : `失败（${r.error ?? "未知原因"}）`
  return `${r.name ?? "（无名）"}：${label}${r.note ? ` — ${r.note}` : ""}`
}

const conflictLabel = (kind: "name" | "file" | "dir") =>
  kind === "file" ? "目标已有同名文件" : kind === "name" ? "目标已有同名子目录技能" : "目标已有同名目录"

/**
 * 导入面板：源类型二选一 → 扫描（只读，落到 os.tmpdir() 暂存并出候选）→ 勾选/冲突动作 → 导入 N 项。
 * 层级、源类型、冲突动作**全是可点选项，不给自由文本**（自由文本只出现在路径 / URL / 子目录 / ref 这些
 * 真正开放的位置上）。扫描出的候选描述直接来自内核，前端不再自算。
 */
function SkillImportPanel(props: {
  project: string | null
  onClose: () => void
  onError: (msg: string | null) => void
  onNotice: (msg: string | null) => void
  onApplied: (r: SkillImportResult) => void
}) {
  const { project } = props
  const [kind, setKind] = useState<SkillImportKind>("dir")
  const [srcPath, setSrcPath] = useState("")
  const [url, setUrl] = useState("")
  const [subpath, setSubpath] = useState("")
  const [ref, setRef] = useState("")
  /** 默认层取记忆值；未打开项目强制「用户」（此时不改写存储值——项目层根本不可选） */
  const [layer, setLayer] = useState<SkillLayer>(() => defaultLayer(project))
  const [plan, setPlan] = useState<SkillImportPlan | null>(null)
  const [picks, setPicks] = useState<Record<string, ImportPick>>({})
  const [previewOpen, setPreviewOpen] = useState<Record<string, boolean>>({})
  const [results, setResults] = useState<SkillImportItemResult[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [applying, setApplying] = useState(false)
  const [pickingDir, setPickingDir] = useState(false)
  /** 这份计划是**为哪个项目 / 哪一层**扫出来的：apply 前比对，不一致就不写
   *  （切层后不复用旧计划——否则表上显示的冲突与实际落盘目标对不上） */
  const [planCtx, setPlanCtx] = useState<{ project: string | null; layer: SkillLayer } | null>(null)

  const busy = scanning || applying

  // 面板被**任何**路径卸载（点关闭 / 切到新建表单 / 离开技能页）都要放弃暂存——不能把临时目录留给 TTL 兜底
  const planRef = useRef<SkillImportPlan | null>(null)
  const aliveRef = useRef(true)
  /** 上一次扫过的源键（同一份源不重复扫：输入框 blur 与 Enter 会连着触发） */
  const lastScan = useRef("")
  useEffect(() => { planRef.current = plan }, [plan])
  useEffect(() => () => {
    aliveRef.current = false
    if (planRef.current) void api.importDrop(planRef.current.id).catch(() => { /* 已过期或已放弃 */ })
  }, [])

  // project 变了（切换 / 关闭项目）：层默认值重读 + 面板里那份计划作废——它的冲突列是按旧项目算的，
  // 拿它去写新项目等于「表上显示的和实际落盘的对不上」。项目为空时强制回用户层（项目层此刻非法）。
  useEffect(() => {
    const stale = planRef.current
    if (stale) void api.importDrop(stale.id).catch(() => { /* 已过期或已放弃 */ })
    setLayer(defaultLayer(project))
    setPlanCtx(null)
    setPlan(null)
    setPicks({})
    setResults(null)
  }, [project])

  /** 放弃暂存（服务端 TTL 只是兜底）：重新扫描前 / 关面板时调；id 已过期→404 也无所谓，不打扰用户 */
  const dropPlan = (p: SkillImportPlan | null) => {
    if (p) void api.importDrop(p.id).catch(() => { /* 已过期或已放弃 */ })
  }

  const close = () => {
    dropPlan(plan)
    props.onClose()
  }

  /** 层切换：候选的冲突列是按层算出来的，换层就必须重扫——否则表上显示的冲突与实际落盘目标对不上 */
  const changeLayer = (l: SkillLayer) => {
    if (l === layer) return
    writeLayerMemory(l)
    setLayer(l)
    dropPlan(plan)
    setPlan(null)
    setPlanCtx(null)
    setPicks({})
    setResults(null)
    props.onNotice(null)
  }

  const scan = async (over?: { path?: string; url?: string }) => {
    const path = over?.path ?? srcPath
    const u = over?.url ?? url
    lastScan.current = scanKey(path, u)
    setScanning(true)
    props.onError(null)
    props.onNotice(null)
    setResults(null)
    try {
      const p = await api.importPlan({
        project,
        layer,
        kind,
        ...(kind === "dir"
          ? { path }
          : { url: u, ...(subpath.trim() ? { subpath: subpath.trim() } : {}), ...(ref.trim() ? { ref: ref.trim() } : {}) }),
      })
      dropPlan(plan) // 上一轮的暂存不留在服务端（TTL 只是兜底）
      // 扫描途中面板被关掉：这份计划永远不会有人持有它（setPlan 已无意义），当场放弃——
      // 否则它会一直等到 TTL 才清（用户关了面板，/tmp 里却躺着一个暂存）
      if (!aliveRef.current) {
        void api.importDrop(p.id).catch(() => { /* 已过期或已放弃 */ })
        return
      }
      setPlan(p)
      setPlanCtx({ project, layer })
      const next: Record<string, ImportPick> = {}
      // 缺省全选；冲突项缺省「跳过」（要覆盖得自己点）——服务端 apply 里还有第二道同样的拦截
      for (const c of p.candidates) next[c.name] = { checked: true, action: "skip" }
      setPicks(next)
      setPreviewOpen({})
      props.onNotice(p.note ?? null)
    } catch (e) {
      dropPlan(plan)
      setPlan(null)
      setPicks({})
      props.onError(errMsg(e))
    } finally {
      setScanning(false)
    }
  }

  const checked = plan ? plan.candidates.filter((c) => pickOf(picks, c.name).checked) : []

  /** 扫描键：同一份源不重复扫（输入框的 blur 与 Enter 会连着触发）——换层 / 换项目 / 换源则在键里 */
  const scanKey = (path: string, u: string) => `${kind}|${project ?? ""}|${layer}|${kind === "dir" ? path : u}`
  /** 用户裁定 2026-09-28：不再要「扫描」按钮——选好源（浏览选目录 / 填完链接）就自动扫 */
  const scanIfChanged = (over?: { path?: string; url?: string }) => {
    const p = over?.path ?? srcPath
    const u = over?.url ?? url
    if (kind === "dir" ? !p.trim() : !u.trim()) return
    if (scanKey(p, u) === lastScan.current) return
    void scan(over)
  }

  const doApply = async () => {
    if (!plan || !checked.length) return
    // 纪律：这份计划必须仍属于当前项目 / 当前层（切层 / 换项目都会作废它）——服务端 apply 会重算冲突，
    // 但「表上显示的冲突 = 实际落盘目标」是这一页的底线，不能靠服务端兜。
    if (!planCtx || planCtx.layer !== layer || planCtx.project !== project) {
      props.onError("层级或项目已变化：请重新扫描后再导入")
      return
    }
    setApplying(true)
    props.onError(null)
    try {
      const r = await api.importApply({
        project,
        layer,
        id: plan.id,
        items: checked.map((c) => ({ name: c.name, action: pickOf(picks, c.name).action })),
      })
      setResults(r.results)
      props.onApplied(r) // 响应自带最新全景：列表直接用它刷新（显示 = 服务端 = 内核所见）
      // 用户裁定 2026-09-28：**全成功就自动收起面板回列表**（列表已由 onApplied 的最新全景刷新）；
      // 有 failed 项则留在面板里让人看见原因——失败路径不静默关闭
      if (!r.results.some((x) => x.status === "failed")) {
        const w = r.results.filter((x) => x.status === "written").length
        const s = r.results.filter((x) => x.status === "skipped").length
        props.onNotice(`已导入 ${w} 项${s ? `（另有 ${s} 项已跳过）` : ""}`)
        props.onClose()
      }
    } catch (e) {
      props.onError(errMsg(e))
    } finally {
      setApplying(false)
    }
  }

  const anyFailed = Boolean(results?.some((r) => r.status === "failed"))

  return (
    <div data-import="panel" data-import-scan={scanning ? "busy" : "idle"} className="mb-7 rounded-xl border border-line bg-surface px-4 py-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-t2">导入技能</span>
        <button data-import="close" onClick={close} className="btn-ghost px-3 py-1.5 text-xs">
          关闭
        </button>
      </div>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <div className="seg">
          <button data-import-kind="dir" data-on={kind === "dir"} onClick={() => setKind("dir")}>
            本地目录
          </button>
          <button data-import-kind="git" data-on={kind === "git"} onClick={() => setKind("git")}>
            Git 仓库
          </button>
        </div>
        <div className="seg">
          <button
            data-import-layer="project"
            data-on={layer === "project"}
            onClick={() => changeLayer("project")}
            disabled={busy || !project}
            title={project ? undefined : "未打开项目"}
          >
            项目
          </button>
          <button data-import-layer="user" data-on={layer === "user"} onClick={() => changeLayer("user")} disabled={busy}>
            用户
          </button>
        </div>
      </div>

      {kind === "dir" ? (
        <div className="mt-2.5 flex gap-2">
          <input
            data-import-input="path"
            value={srcPath}
            onChange={(e) => setSrcPath(e.target.value)}
            onBlur={() => scanIfChanged()}
            onKeyDown={(e) => {
              if (e.key === "Enter") scanIfChanged()
            }}
            placeholder="本地目录（含 SKILL.md ⇒ 整目录当一个技能）"
            className="field px-3 py-2 font-mono text-xs"
          />
          <button data-import="browse" onClick={() => setPickingDir(true)} className="btn-ghost shrink-0 px-3 py-2 text-xs">
            浏览
          </button>
        </div>
      ) : (
        <div className="mt-2.5 grid grid-cols-1 gap-2.5">
          <input
            data-import-input="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => scanIfChanged()}
            onKeyDown={(e) => {
              if (e.key === "Enter") scanIfChanged()
            }}
            placeholder="Git 仓库（https:// / http:// / ssh:// / file:// / git@host:path / 本地路径）"
            className="field px-3 py-2 font-mono text-xs"
          />
          {/* 子目录 / 分支输入按用户裁定（2026-09-27）从界面移除、**能力保留**：subpath/ref 的 state 与
              请求构造原样留在本组件（服务端 plan 接口照收这两个字段）——恢复入口就把本注释换回两个 input。 */}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="min-w-0 text-xs text-t4">
          选好源就自动扫描（只把源读进临时暂存，不动任何技能目录；10 分钟未使用自动清理）
        </span>
        {scanning && <span className="shrink-0 text-xs text-t4">扫描中…</span>}
      </div>

      {plan && (
        <div className="mt-3 overflow-hidden rounded-xl border border-line" data-plan-id={plan.id}>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-4 py-2.5 text-xs text-t4">
            <span className="min-w-0 break-all font-mono text-t3">{plan.source.label}</span>
            {plan.source.ref && <span>ref：<span className="font-mono">{plan.source.ref}</span></span>}
            {plan.source.commit && <span>commit：<span className="font-mono">{plan.source.commit}</span></span>}
            <span>共 {plan.candidates.length} 个候选</span>
          </div>

          {plan.candidates.length === 0 ? (
            <div className="border-t border-line px-4 py-6 text-center text-xs text-t4">源里没有可导入的技能</div>
          ) : (
            plan.candidates.map((c) => (
              <ImportCandidateRow
                key={c.name}
                c={c}
                pick={pickOf(picks, c.name)}
                preview={Boolean(previewOpen[c.name])}
                onToggle={() => setPicks((m) => ({ ...m, [c.name]: { ...pickOf(m, c.name), checked: !pickOf(m, c.name).checked } }))}
                onAction={(a) => setPicks((m) => ({ ...m, [c.name]: { ...pickOf(m, c.name), action: a } }))}
                onPreview={() => setPreviewOpen((m) => ({ ...m, [c.name]: !m[c.name] }))}
              />
            ))
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3">
            <span className="text-xs text-t4">
              装入 {layer === "project" ? "项目层" : "用户层"}：已选 {checked.length} 项
            </span>
            <button
              data-import="apply"
              onClick={doApply}
              disabled={busy || checked.length === 0}
              className="btn-primary px-4 py-1.5 text-xs"
            >
              {applying ? "导入中…" : `导入 ${checked.length} 项`}
            </button>
          </div>

          {results && (
            <div data-import="results" className={`border-t px-4 py-2.5 text-xs ${anyFailed ? "border-red-900 bg-red-950 text-red-300" : "border-emerald-900 bg-emerald-950 text-emerald-300"}`}>
              {results.map(resultText).join("；")}
            </div>
          )}
        </div>
      )}

      {/* 目录浏览复用既有 DirPicker（dir 模式）——不另造一个浏览器 */}
      {pickingDir && (
        <DirPicker
          onClose={() => setPickingDir(false)}
          onPick={(p) => {
            setSrcPath(p)
            setPickingDir(false)
            void scan({ path: p }) // 重新浏览选一次就是「我要重扫」的明确意图 ⇒ 不走去重（用户裁定 2026-09-28）
          }}
        />
      )}
    </div>
  )
}

/** 一行候选：勾选框 + 名字 + 格式徽标 + 描述 + 将写入文件数 + 冲突列（跳过/覆盖）+ 预览 */
function ImportCandidateRow(props: {
  c: SkillImportCandidate
  pick: ImportPick
  preview: boolean
  onToggle: () => void
  onAction: (a: "skip" | "overwrite") => void
  onPreview: () => void
}) {
  const { c, pick, preview } = props
  return (
    <div data-import-candidate={c.name} className="border-t border-line px-4 py-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <input
          type="checkbox"
          data-import-check={c.name}
          checked={pick.checked}
          onChange={props.onToggle}
          className="h-3.5 w-3.5 shrink-0 accent-[var(--accent)]"
        />
        <span className="shrink-0 text-sm font-medium text-t1">{c.name}</span>
        <span className="shrink-0 rounded-full border border-line2 px-2 py-0.5 font-mono text-xs text-t4">
          {c.format === "dir" ? `${c.name}/SKILL.md` : `${c.name}.md`}
        </span>
        <FloatingTooltip label={c.declaredDescription ?? c.description} className="min-w-0 flex-1">
          <span className="block truncate text-xs text-t4">{c.declaredDescription ?? c.description}</span>
        </FloatingTooltip>
        <span className="shrink-0 text-xs text-t4">将写入 {c.files} 个文件</span>
        {c.conflict ? (
          <span className="seg">
            <button data-import-opt="skip" data-on={pick.action === "skip"} onClick={() => props.onAction("skip")}>
              跳过
            </button>
            <button data-import-opt="overwrite" data-on={pick.action === "overwrite"} onClick={() => props.onAction("overwrite")}>
              覆盖
            </button>
          </span>
        ) : (
          <span className="shrink-0 text-xs text-t4">无冲突</span>
        )}
        <button data-import-preview={c.name} onClick={props.onPreview} className="btn-ghost shrink-0 px-2.5 py-1 text-xs">
          预览
        </button>
      </div>

      {c.conflict && (
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 text-xs text-amber-300">
          <span>{conflictLabel(c.conflict.kind)}</span>
          <span className="min-w-0 break-all font-mono text-t4">{c.conflict.path}</span>
        </div>
      )}

      {preview && (
        <pre
          data-import-preview-body={c.name}
          className="mt-2 max-h-56 overflow-auto rounded-lg border border-line2 bg-surface2 px-3 py-2 font-mono text-xs leading-relaxed text-t3"
        >
          {c.preview}
        </pre>
      )}
    </div>
  )
}
