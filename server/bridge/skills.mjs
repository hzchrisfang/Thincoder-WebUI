/**
 * bridge/skills.mjs — 技能（skill）管理适配面：两层技能的 列出 / 读取 / 新建 / 保存 / 重命名 / 删除
 *
 * 内核契约（@thincoder/core/skills.mjs；内核 import 全部收敛在 bridge/thincoder.mjs，本模块只经
 * loadThincoder().skills 取核函数）：
 * - 两个层级（skills.mjs:93-94）：项目层 <projectDir>/.thincoder/skills/、用户层 ~/.thincoder/skills/
 * - 两种格式（skills.mjs:66-83）：扁平 <name>.md、子目录 <name>/SKILL.md；**子目录优先**——同名扁平
 *   文件被 `added` 短路（skills.mjs:74-80），它仍在磁盘上，但内核从此永不读它
 * - 名字白名单 NAME_RE=^[a-zA-Z0-9_-]+$（skills.mjs:18）：不合规条目**被内核静默忽略**。
 *   静默正是本模块的存在理由——用户放错的文件/目录在内核侧毫无声息（清单里凭空少一条，
 *   用户只会看到「我明明建了它，agent 却说没有」）。管理页必须把这类条目显式报出来（ignored 面）。
 * - 合并（skills.mjs:92-110）：项目层优先，用户层同名跳过
 * - 按名寻址的顺序就是上面第 3 条（子目录优先）；管理页按**物理落点**寻址时用可选 format 参数指定
 *   （dir → <name>/SKILL.md，flat → <name>.md）：给了就只认那一个落点（不存在 → 404），没给保持内核
 *   顺序——影子扁平行（被同名子目录短路掉的那个文件）靠它才变得可寻址
 * - 描述（skills.mjs:28-39）：正文前 400 字符内第一个「trim 后非空、非 # 开头、不在 --- frontmatter 内」的行，截 120 字
 *
 * **零重实现纪律**：清单/描述/合并/遮蔽一律取内核 loadSkills 的输出，本模块只做两件事——
 * ① 按物理归属分桶（内核结果里的 path 落在哪一层）② 文件系统原语（读 / 原子写 / rename / unlink）。
 * 自算描述必与内核漂移：那份数据同时喂 system prompt（core/agent/setup.mjs:231-235）——管理页显示的
 * 与 agent 看到的不一致，用户就被自己的管理面骗了（这正是本页要消灭的东西）。
 *
 * 生效时机：内核每轮组装 system prompt 时现读（setup.mjs:231-235）⇒ 本模块的写操作**下一轮即生效，
 * 无需重启**；因此路由不为写技能设 busy 门（对照 /api/command：/plan /eng 翻转 agent 运行时状态，
 * 跑一半翻会撕裂该轮语义，才需要 409。技能文件不碰 config/session/agent 运行时）。
 */

import { readdir, readFile, mkdir, open, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { loadThincoder } from "./thincoder.mjs"

/** 技能名白名单（与内核 skills.mjs:18 同源）。内核不认的名字这里也不认——否则管理面能建出
 *  内核永远看不见的文件（假状态）。 */
const NAME_RE = /^[a-zA-Z0-9_-]+$/

/** 合法层级（路由与桥接层共用口径；前端 SkillLayer 类型与此对齐） */
const LAYERS = ["project", "user"]

/** 带 HTTP 状态的技能操作错误：路由直接取 status 回码，message 是中文、可直接展示给用户 */
export class SkillError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
    this.name = "SkillError"
  }
}

// ================= 路径与文件原语 =================

/** abs 是否落在 dir 之内（`relative` 精确式：拒 `""`=目标就是目录本身 / `..` / `..`+sep 开头 / 绝对路径——
 *  **禁用裸 startsWith("..")**，会误杀 `..config` 这类合法名，AGENTS.md F 条）。写路径的越界断言与
 *  「这个内核结果属于哪一层」的分桶共用这一个口径。 */
export function insideLayer(dir, abs) {
  const r = relative(dir, abs)
  return r !== "" && r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r)
}

/** 落盘前的归属断言：写路径必须是「层目录 + 已过正则的名字 + 后缀」，越界即拒。名字已过 NAME_RE
 *  （不含分隔符）⇒ 这里恒真，属第二道防线；discipline 同 /api/file 的穿越判据（routes.mjs:263-266）。 */
function assertInside(dir, abs) {
  if (!insideLayer(dir, abs)) throw new SkillError(400, "路径越界")
  return abs
}

const isFileAt = async (p) => {
  try { return (await stat(p)).isFile() } catch { return false }
}

/** 落点上是否已有**任何**存在物（普通文件或目录都算）——rename 目标占用判据用：
 *  无 SKILL.md 的目录 / 无后缀的裸文件都不是「技能」，但 rename 会把它们顶掉（空目录）或报 ENOTEMPTY。 */
const existsAt = async (p) => {
  try { await stat(p); return true } catch { return false }
}

const statOf = async (p) => {
  try {
    const st = await stat(p)
    return { size: st.size, mtime: st.mtimeMs }
  } catch {
    return { size: 0, mtime: 0 } // 竞态（文件在扫描间隙被删/不可读）——不编造大小
  }
}

/** stat 容错版：不存在/不可读 → null（copySkillEntry 判断源条目是文件还是目录用） */
const statOrNull = async (p) => {
  try { return await stat(p) } catch { return null }
}

/**
 * 目标层里 name 的占用情况（导入面「冲突」列与 applyImport 的服务端自带拦截**共用这一个判据**）：
 *   <name>.md       → { kind: "file" }（扁平落点被占）
 *   <name>/SKILL.md → { kind: "name" }（子目录落点被占）
 *   <name>/         → { kind: "dir" }（裸目录：不是技能，但目录写入 / 改名会被它顶住）
 * 三种都算冲突，顺序即优先级；无占用 → null。
 */
export async function conflictAt(dir, name) {
  const flat = join(dir, name + ".md")
  if (await isFileAt(flat)) return { kind: "file", path: flat }
  const skillMd = join(dir, name, "SKILL.md")
  if (await isFileAt(skillMd)) return { kind: "name", path: skillMd }
  const bare = join(dir, name)
  if (await existsAt(bare)) return { kind: "dir", path: bare }
  return null
}

/**
 * 原子写（临时文件 → rename 换入；同 store/mcp-prefs.mjs:34-41 的思路，**不复用它的函数**：
 * 那个 save() 绑死 mcp-prefs.json 的配置语义）。临时文件留在同目录（同一文件系统 rename 才原子），
 * 失败路径清理 tmp——残骸会以「内核只识别 .md 文件」的形式出现在 ignored 里，等于自己给用户造噪音。
 *
 * POSIX：rename 本身即可原子上覆盖，**完全不 unlink**。无条件 unlink 会开出「文件瞬时不存在」的窗口：
 * 并发的 loadSkills 会漏读这条技能；中途中断则用户手写的正文已经丢了，盘上只剩内核不认的 .tmp 残骸。
 * Windows：rename 覆盖已存在目标会 EPERM ⇒ 必须先 unlink；此时 unlink 的失败只允许 ENOENT（目标
 * 本就不存在 = 新建的正常路径），其余（EPERM/EBUSY 等占用类）如实报 409——绝不吞掉。
 */
/** fs 原语的 errno → 中文 SkillError：界面文案一律中文可展示（同 writeAtomic 的 win32 分支口径）——
 *  否则删除 / 重命名遇到「被占用 / 没权限」时会直接露出英文 errno 原文，用户读不懂也看不出下一步做什么。
 *  非本模块认得的 errno 原样交回，由路由的 skillsFail 兜底（绝不把出错原因换成一个泛泛的 400 文案）。 */
function fsError(e, what) {
  if (e instanceof SkillError) return e
  const code = e?.code
  if (code === "ENOENT") return new SkillError(404, `${what}不存在（可能已被删除）`)
  if (code === "EPERM" || code === "EBUSY" || code === "EACCES" || code === "EROFS") {
    return new SkillError(409, `${what}被占用或没有权限（请关闭占用它的程序后重试）`)
  }
  // 形态冲突（目标同位置已是目录 / 非目录，如 rename 到已存在的目录上）：文案要说清是「落点形状」不对，
  // 否则用户会去关程序。这三种 errno 以前会原样冒到界面（英文原文），与本模块的中文口径不符。
  if (code === "EEXIST" || code === "ENOTDIR" || code === "EISDIR") {
    return new SkillError(409, `${what}落点形态冲突（目标同位置已是目录或文件，无法按原样写入）`)
  }
  return e
}

async function writeAtomic(abs, data) {
  const tmp = `${abs}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    await writeFile(tmp, data, "utf8")
  } catch (e) {
    throw fsError(e, "技能文件")
  }
  try {
    if (process.platform === "win32") {
      try {
        await unlink(abs)
      } catch (e) {
        if (e?.code !== "ENOENT") throw new SkillError(409, "目标文件被其它程序占用，保存失败（请关闭占用它的程序后重试）")
      }
    }
    await rename(tmp, abs)
  } catch (e) {
    try { await unlink(tmp) } catch { /* 清理失败也不能吞掉原错 */ }
    throw fsError(e, "技能文件")
  }
}

/**
 * 复制一个技能条目到 destRoot 之下（源 = 扁平 .md 文件，或子目录整目录递归）：
 * **符号链接一律跳过、绝不跟随**——技能目录里的软链可能把写入指到别处；导入面第一次接触的是
 * 不受信任的内容，跟随软链等于把「写到哪」的决定权交给源（用 withFileTypes + isSymbolicLink 判定，
 * 不 stat 跟随——stat 会解析软链，把源外的内容当成条目内容）。
 *  返回 { files, bytes } = 将写入的文件数与总字节数（候选清单的 files / size 由此而来）。
 *
 * 两处复制**共用本函数**（跨模块单源）：导入面的「源 → <tmp> 暂存」与 applyImport 的「暂存 → 目标层」。
 * 逐条目标路径都过 assertInside（第二道防线；名字已过 NAME_RE，源侧结构也已被逐级校验）。
 */
export async function copySkillEntry(srcPath, destPath, destRoot) {
  const st = await statOrNull(srcPath)
  if (!st) throw new SkillError(404, `源条目不存在：${srcPath}`)
  if (st.isFile()) {
    const buf = await readFile(srcPath)
    await writeAtomic(assertInside(destRoot, destPath), buf)
    return { files: 1, bytes: buf.length }
  }
  if (!st.isDirectory()) return { files: 0, bytes: 0 } // 其余类型（fifo/socket…）没有可写内容
  await mkdir(assertInside(destRoot, destPath), { recursive: true })
  let files = 0
  let bytes = 0
  // 排序与内核同比较器（skills.mjs:59）：复制顺序确定，同源多个条目的落盘顺序不随文件系统漂移
  const entries = await readdir(srcPath, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const r = await copySkillEntry(join(srcPath, entry.name), join(destPath, entry.name), destRoot)
    files += r.files
    bytes += r.bytes
  }
  return { files, bytes }
}

// ================= 层级 / 内核面 =================

/** 层目录（与内核 skills.mjs:93-94 同源拼接；用户层用 homedir()——Windows 无 HOME 环境变量，AGENTS.md F 条） */
export function layerDirFor(layer, projectDir) {
  if (!LAYERS.includes(layer)) throw new SkillError(400, `层级参数无效（只支持 project 或 user）：${String(layer)}`)
  if (layer === "user") return join(homedir(), ".thincoder", "skills")
  if (!projectDir) throw new SkillError(400, "项目层操作需要 project 参数")
  return join(projectDir, ".thincoder", "skills")
}

/** 赢家条目属于哪一层：既然它是赢家，先在项目层目录里找（同名时项目层优先），否则归用户层——
 *  内核合并结果里的 path 只可能出自这两层目录。归属判定用 insideLayer（精确式，非 startsWith）。 */
function winnerLayer(projectDir, abs) {
  const p = resolve(abs)
  return projectDir && insideLayer(layerDirFor("project", projectDir), p) ? "project" : "user"
}

/** 赢家的物理格式：以 SKILL.md 结尾 = 子目录格式，其余（<name>.md）= 扁平格式 */
const winnerFormat = (abs) => (abs.endsWith("SKILL.md") ? "dir" : "flat")

/** 内核技能面（旧内核缺 core/skills.mjs → null；路由据此回 501，不拖垮其余功能） */
async function coreApi() {
  const t = await loadThincoder()
  if (!t.skills) throw new SkillError(501, "当前内核不支持技能管理（缺 core/skills.mjs）")
  return t.skills
}

/**
 * 内核视角的三张表（全模块唯一的内核口径来源）：
 * - merged：内核合并结果 = 注入 system prompt 的那份（项目层优先，用户层同名跳过）→ 顶层 effective
 * - own：**用户层自身的扫描**（无遮蔽视角）。projectDir 存在时用 loadSkills(homedir()) 取——该调用的
 *   「项目层」恰是用户层目录（skills.mjs:93-94 两层同路径），去重后就是用户层全量，于是被项目层遮蔽的
 *   用户技能也能拿到内核给它的描述（merged 里没有它）。无项目时 merged 本身就是用户层全量，直接复用。
 * - recognized：按 path 查内核结果的索引（merged ∪ own——只用于取描述，**不用于判生效**）
 * - mergedPaths：生效判据（只来自 merged）；mergedByName：同名赢家（遮蔽原因 shadowedBy 的唯一来源）
 */
async function kernelView(projectDir) {
  const api = await coreApi()
  const merged = await api.loadSkills(projectDir ?? homedir())
  const own = projectDir ? await api.loadSkills(homedir()) : merged
  const recognized = new Map()
  for (const s of [...merged, ...own]) recognized.set(resolve(s.path), s)
  return {
    api, merged,
    recognized,
    // 生效判据只看 merged（内核的合并结果）；recognized 更宽但**不得**用于判 effective——
    // 被项目层遮蔽的用户技能在 own 里有、在 merged 里没有，拿它判 effective 就会把遮蔽说成生效
    mergedPaths: new Set(merged.map((s) => resolve(s.path))),
    // 合并结果按名字索引 = 同名赢家（分桶判 shadowed / shadowedBy 用）
    mergedByName: new Map(merged.map((s) => [s.name, s])),
    projectDir: projectDir ?? null,
  }
}

// ================= 扫描（单层） =================

/** ignored 的 reason 文案（人类可读中文；与内核的静默忽略逐条对应） */
const REASON = {
  dirName: "目录名含非法字符（内核只识别字母、数字、下划线、连字符）",
  noSkillMd: "子目录里没有 SKILL.md",
  skillMdNotFile: "SKILL.md 不是可读的普通文件（内核会跳过它）",
  notMd: "内核只识别 .md 文件",
  fileName: "文件名含非法字符（内核只识别字母、数字、下划线、连字符）",
}

/** 只读文件头这么多字节：frontmatter 可能很长（实测一条真实技能 451 字符），够覆盖到围栏结束 */
const HEAD_BYTES = 8192

/**
 * 读文件开头 frontmatter 块里的字段（只认首行 `---` 围栏；**不引 YAML 依赖**，也不解嵌套结构）。
 * 行内值 `key: value`（去引号）与块标量 `key: >` / `key: |`（拼后续缩进行）都支持。
 * 用途：**作者自述**（frontmatter `description:`）——技能列表与导入候选都显示它
 * （用户裁定 2026-09-27：自述优先，没写自述才显示内核那句）。
 * 全仓**只此一套** frontmatter 解析（导入模块也复用这个）。
 */
export const declaredMeta = (text) => {
  const lines = String(text ?? "").replace(/^\uFEFF/, "").split("\n")
  if ((lines[0] ?? "").trim() !== "---") return { name: null, description: null }
  const out = { name: null, description: null }
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim()
    if (t === "---") break
    const m = t.match(/^(name|description)\s*:\s*(.*)$/i)
    if (!m) continue
    const key = m[1].toLowerCase()
    let val = m[2].trim()
    if (/^[>|][-+]?$/.test(val)) {
      const block = []
      for (let j = i + 1; j < lines.length; j++) {
        const raw = lines[j]
        if (raw.trim() === "") { block.push(""); i = j; continue } // 块内空行：保留，继续看下一行还缩不缩进
        if (!/^\s/.test(raw)) break // 非缩进行 ⇒ 块结束
        block.push(raw.replace(/^\s+/, ""))
        i = j
      }
      val = block.join("\n").trim()
    }
    val = val.replace(/^["']|["']$/g, "").trim()
    if (val && !out[key]) out[key] = val
  }
  return out
}

/** 读一条技能文件头部的作者自述（读不到/没写 ⇒ null）。用真 HEAD 读，不整文件读——列表刷新按条扫 */
async function declaredOf(path) {
  let fh = null
  try {
    fh = await open(path, "r")
    const buf = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0)
    return declaredMeta(buf.subarray(0, bytesRead).toString("utf8")).description
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => {})
  }
}

/** 单个条目 → Entry。description / effective **只信内核**：内核结果里有同 path 的条目才算生效。
 *  内核没读过的（如被同名子目录短路的扁平文件）不给自造描述——如实标 (no description)。
 *  `declaredDescription` 是另一回事：作者在 frontmatter 里写的自述，**只供列表显示**；
 *  两值都在响应里（不藏事实 —— 要核对「agent 实际看到哪句」时看 `description` 即可）。 */
async function entryOf(name, path, format, ctx) {
  const key = resolve(path)
  const effective = ctx.mergedPaths.has(key)
  const hit = ctx.recognized.get(key)
  // 本行不是赢家 ⇒ 从合并结果里取同名赢家：遮蔽**原因**（赢家在哪层、哪种格式）由数据决定，不由
  // 本行的层级猜——猜就必然说出「子目录行被同名子目录技能遮蔽」这类自指错话
  const winner = effective ? null : ctx.mergedByName.get(name)
  return {
    name,
    description: hit ? hit.description : "(no description)",
    declaredDescription: await declaredOf(path), // 作者自述（frontmatter description:）：列表显示以它优先
    path,
    format,
    ...(await statOf(path)),
    effective,
    // 未被内核采用，但合并结果里已有同名条目 ⇒ 被遮蔽（用户层被项目层遮蔽 / 同层扁平被同名子目录短路）
    shadowed: Boolean(winner),
    shadowedBy: winner
      ? { layer: winnerLayer(ctx.projectDir, winner.path), path: winner.path, format: winnerFormat(winner.path) }
      : null,
  }
}

/**
 * 扫一层目录：产出该层「内核会认的技能」+「内核不认的条目（ignored）」。
 * 识别规则逐条照抄内核 loadSkillsFromDir（skills.mjs:52-85）：Pass1 子目录（名字过正则 + SKILL.md 存在）
 * → Pass2 扁平 .md；Pass2 里被 Pass1 同名短路的文件仍要列出来（否则用户看不见自己那份文件的去向）。
 */
async function scanLayer(layer, dir, ctx) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return { layer, dir, exists: false, skills: [], ignored: [] } // 目录不存在 = 该层为空（内核同判据）
  }
  // 排序与内核同比较器（skills.mjs:59）：管理页顺序 = 注入清单顺序
  entries.sort((a, b) => a.name.localeCompare(b.name))

  const skills = []
  const ignored = []

  for (const entry of entries) {
    if (!entry.isDirectory()) continue // 非目录/非普通文件（符号链接等）内核同样跳过，不入 ignored
    if (!NAME_RE.test(entry.name)) {
      ignored.push({ entry: entry.name, kind: "dir", reason: REASON.dirName })
      continue
    }
    const p = join(dir, entry.name, "SKILL.md")
    if (!(await isFileAt(p))) {
      // 两种「内核不认」分开说：真没有 SKILL.md，还是**有但不是可读的普通文件**（被建成同名目录 /
      // 懒得看权限）。内核 tryReadSkill 对两者都是静默 null（core/skills.mjs:23-44），但页面要是把后者
      // 也说成「没有 SKILL.md」，用户会照着自己的文件系统反复确认——说错原因比不说更坏。
      ignored.push({
        entry: entry.name,
        kind: "dir",
        reason: (await existsAt(p)) ? REASON.skillMdNotFile : REASON.noSkillMd,
      })
      continue
    }
    skills.push(await entryOf(entry.name, p, "dir", ctx))
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue
    const m = entry.name.match(/^([a-zA-Z0-9_-]+)\.md$/)
    if (!m) {
      ignored.push({
        entry: entry.name,
        kind: "file",
        reason: entry.name.endsWith(".md") ? REASON.fileName : REASON.notMd,
      })
      continue
    }
    const name = m[1]
    // 被同名子目录短路的扁平文件照样列出（内核 Pass2 的 added 短路会跳过它，core/skills.mjs:74-80）——
    // 用户得知道自己那份文件的去向。**不在这里写死 shadowed / effective**：两者都由 entryOf 从内核结果
    // 派生，写死会造出两种失真：① 子目录 SKILL.md「可 stat 不可读」时内核 tryReadSkill 返回 null
    // （core/skills.mjs:23-44），会**回退采用这个扁平文件**，写死却说它未被采用——与 agent 所见相反，
    // 正是本页最不该出的错；② shadowed:true 配 shadowedBy:null，前端会渲染出一个没有原因的空白徽标。
    skills.push(await entryOf(name, join(dir, entry.name), "flat", ctx))
  }

  return { layer, dir, exists: true, skills, ignored }
}

// ================= 对外：列出 =================

/** 可选 format 参数归一：缺省 / 空串 → undefined（退回内核解析顺序，旧行为零变化）；"flat"|"dir" → 原值；
 *  其余非空值 → 400（不猜、不兜底）。 */
function requireFormat(format) {
  if (format === undefined || format === null || format === "") return undefined
  if (format === "flat" || format === "dir") return format
  throw new SkillError(400, "格式参数无效（只支持 flat 或 dir）")
}

/** 该层里 name 的物理落点。没给 format ⇒ 同内核 skills.mjs:139-150 的解析顺序（子目录优先 → 扁平）；
 *  给了 format ⇒ **只认那一个物理落点**（不存在 → null，调用方回 404）。 */
async function resolveInLayer(dir, name, format) {
  const candidates = format
    ? [{ path: format === "dir" ? join(dir, name, "SKILL.md") : join(dir, name + ".md"), format }]
    : [
        { path: join(dir, name, "SKILL.md"), format: "dir" },
        { path: join(dir, name + ".md"), format: "flat" },
      ]
  for (const c of candidates) if (await isFileAt(c.path)) return c
  return null
}

/**
 * 「内核认得、本页没扫到」的路径（两个入参都是路径集合/数组，纯函数，便于单测）。
 * 本页的发现规则（NAME_RE / Pass1 子目录 → Pass2 扁平 / 排序）是内核 loadSkillsFromDir 的**镜像副本**：
 * 内核哪天改了规则，本页不会跟着变——那份差异只表现为「清单里少一条，而 effective 仍把它计入」。
 * listSkills 用这个差值把差异如实写进 note（绝不静默丢一条）。
 */
export function unscannedPaths(scannedPaths, mergedPaths) {
  const scanned = new Set([...(scannedPaths ?? [])].map((p) => resolve(p)))
  const out = []
  for (const p of mergedPaths ?? []) if (!scanned.has(resolve(p))) out.push(p)
  return out
}

/**
 * 技能全景：两层各自的「已识别 / 未识别」+ 内核合并后的生效清单。
 * 固定顺序 project → user；未打开项目（projectDir=null）时项目层给空壳（dir:null）+ note 说明，
 * effective 退化为用户层全量（此时不可能有跨层遮蔽）。
 * note 可同时承载两件事（`；` 合并，绝不静默丢一条）：未打开项目 / 发现规则自检的差值（见 unscannedPaths）。
 */
export async function listSkills({ projectDir = null } = {}) {
  const proj = projectDir ?? null
  const view = await kernelView(proj)
  const { merged } = view
  const ctx = view // scanLayer 要的整张表（recognized / mergedPaths / mergedByName / projectDir）

  const layers = [
    proj
      ? await scanLayer("project", layerDirFor("project", proj), ctx)
      : { layer: "project", dir: null, exists: false, skills: [], ignored: [] },
    await scanLayer("user", layerDirFor("user", proj), ctx),
  ]

  // 发现规则自检：本页扫到的路径 与 内核认得的路径 求差，非空说明内核发现规则可能已变
  const missed = unscannedPaths(layers.flatMap((l) => l.skills.map((s) => s.path)), merged.map((s) => s.path))
  const notes = [
    ...(proj ? [] : ["未打开项目，仅显示用户级技能"]),
    ...(missed.length
      ? [`内核认得但本页未扫描到 ${missed.length} 条技能（内核发现规则可能已变）：${missed.join(", ")}`]
      : []),
  ]

  // effective 的条目**复用层里的同 path 对象**（不再手裁字段），两个理由：
  // ① 把 declaredDescription 一并带上（用户 2026-09-28：对话「调用技能」二级菜单的描述要与技能管理页一致）；
  // ② 一处条目对象两处显示 ⇒ 不可能出现两套口径（手裁字段那版就把 declaredDescription 裁掉了，
  //    于是同一个技能在两处的描述不一样）。
  const entryByPath = new Map(layers.flatMap((l) => l.skills.map((s) => [s.path, s])))

  return {
    layers,
    effective: merged.map((s) => entryByPath.get(s.path) ?? { name: s.name, description: s.description, path: s.path }),
    note: notes.length ? notes.join("；") : null,
  }
}

// ================= 对外：读 / 建 / 存 / 改名 / 删 =================

function requireName(name) {
  const s = typeof name === "string" ? name : ""
  if (!NAME_RE.test(s)) throw new SkillError(400, "技能名只能包含字母、数字、下划线、连字符")
  return s
}

function requireContent(content) {
  if (typeof content !== "string") throw new SkillError(400, "content 必须是字符串")
  return content
}

/** 读某层某技能正文（层级内解析，不看别的层——管理页按层给行，读的必须是行上那个文件）。
 *  可选 format 指定物理落点：同层同时有 <name>/SKILL.md 与 <name>.md 时，按名解析必先命中子目录，
 *  扁平那条只有带上 format:"flat" 才读得到。 */
export async function readSkillFile({ projectDir = null, layer, name, format } = {}) {
  const dir = layerDirFor(layer, projectDir)
  const hit = await resolveInLayer(dir, requireName(name), requireFormat(format))
  if (!hit) throw new SkillError(404, `技能不存在：${name}`)
  let text
  try {
    text = await readFile(hit.path, "utf8")
  } catch (e) {
    throw fsError(e, "技能文件") // 读不到（权限 / 被占用 / 并发删除）也走中文口吻，不把 errno 原文丢给界面
  }
  // size 走 statOf（不裸 stat）：文件在两侧之间被并发删掉时不能把原始 ENOENT 抛给用户（那是 500 类噪音，不是本接口的语义）
  return { text, path: hit.path, format: hit.format, ...(await statOf(hit.path)) }
}

/** 另一层里的同名技能（跨层遮蔽预警用） */
async function otherLayerHit(layer, projectDir, name) {
  if (layer === "user") return projectDir ? resolveInLayer(layerDirFor("project", projectDir), name) : null
  return resolveInLayer(layerDirFor("user", projectDir), name)
}

/**
 * 新建：该层不存在同名技能时才建，一律**扁平格式**（<name>.md）。
 * 另一层已有同名 → 不算冲突（两个文件各归各层），但必须如实预警遮蔽关系——否则用户建完发现不生效。
 */
export async function createSkill({ projectDir = null, layer, name, content } = {}) {
  const dir = layerDirFor(layer, projectDir)
  const skillName = requireName(name)
  const body = requireContent(content)
  if (await resolveInLayer(dir, skillName)) throw new SkillError(409, `同名技能已存在：${skillName}`)

  const target = assertInside(dir, join(dir, skillName + ".md"))
  await mkdir(dir, { recursive: true })
  await writeAtomic(target, body)

  const warnings = []
  if (await otherLayerHit(layer, projectDir, skillName)) {
    warnings.push(
      layer === "user"
        ? "项目层已有同名技能，它会遮蔽这条用户技能"
        : "用户层已有同名技能，本项目将优先使用项目层这条"
    )
  }
  return { ok: true, path: target, format: "flat", name: skillName, layer, warnings, ...(await listSkills({ projectDir })) }
}

/**
 * 保存：**必须命中该层已存在的物理文件**（子目录 SKILL.md 或扁平 .md），一个都没有 → 404。
 * 「找不到就新建」被明确禁止——那会造出被同名条目遮蔽的影子文件：内核跳过它（skills.mjs:74-80 /
 * 92-110），用户却以为保存成功了（同一份内容在另一层/另一格式下早就生效）。宁可报错让用户看清现状。
 *  可选 format：只写那一个物理落点（影子扁平行必须带 format:"flat" 才写到它身上——不给就落到子目录那条）。
 */
export async function saveSkill({ projectDir = null, layer, name, content, format } = {}) {
  const dir = layerDirFor(layer, projectDir)
  const skillName = requireName(name)
  const body = requireContent(content)
  const hit = await resolveInLayer(dir, skillName, requireFormat(format))
  if (!hit) throw new SkillError(404, `技能不存在：${skillName}`)

  const target = assertInside(dir, hit.path)
  await writeAtomic(target, body)
  // 命中子目录格式就写回 SKILL.md，**绝不**顺手生成 <name>.md——那是一个新的影子文件
  return { ok: true, path: target, format: hit.format, name: skillName, layer, ...(await listSkills({ projectDir })) }
}

/** 重命名：子目录格式整目录改名（SKILL.md 与资源文件一起走），扁平格式改文件名。目标已存在 → 409。
 *  可选 format：**源**按它解析（影子扁平行只有 format:"flat" 才寻址得到）；目标沿用源的格式推导。 */
export async function renameSkill({ projectDir = null, layer, name, to, format } = {}) {
  const dir = layerDirFor(layer, projectDir)
  const from = requireName(name)
  const target = requireName(to)
  const hit = await resolveInLayer(dir, from, requireFormat(format))
  if (!hit) throw new SkillError(404, `技能不存在：${from}`)
  // 同名（前端已禁按钮，直连 API 也可能来）：回现状即可——同路径 rename 在 Windows 上的语义不保证
  if (target === from) {
    return { ok: true, path: hit.path, format: hit.format, name: from, layer, ...(await listSkills({ projectDir })) }
  }

  const dest = hit.format === "dir"
    ? assertInside(dir, join(dir, target))
    : assertInside(dir, join(dir, target + ".md"))
  // 目标名被占：既看「同层已有同名技能」（dir / flat 两种格式都算），也看落点本身是否被任何东西占着
  // ——没 SKILL.md 的目录不是技能，但整目录 rename 会把它顶掉（空目录）或报 ENOTEMPTY（非空）
  if (await resolveInLayer(dir, target)) throw new SkillError(409, `同名技能已存在：${target}`)
  if (await existsAt(dest)) throw new SkillError(409, `目标名已被占用：${target}`)

  // 子目录格式改的是**目录本身**（SKILL.md 与其资源文件一起走）——拿 hit.path（SKILL.md）当源
  // 会把 SKILL.md 改成一个无后缀的裸文件，原目录反而留在盘上（内核看不见它，用户以为改完了）
  const src = hit.format === "dir" ? join(dir, from) : hit.path
  try {
    await rename(src, dest)
  } catch (e) {
    throw fsError(e, "技能") // 目标被占用 / 权限不足时给中文原因（同 win32 写路径口径）
  }
  return { ok: true, path: dest, format: hit.format, name: target, layer, ...(await listSkills({ projectDir })) }
}

/**
 * 删除：扁平 → 删文件；子目录 → **先删 SKILL.md，再看目录还剩什么**——子目录技能常带资源文件
 * （脚本/模板/示例），整目录 rm 会连资源一起抹掉（设计裁定：绝不整目录删）。目录空了才 rmdir，
 * 还有东西就保留目录并把剩下的如实写进 note。
 *  可选 format：只删那一个物理落点（影子扁平行带上 format:"flat" 才删得到它）。
 */
export async function deleteSkill({ projectDir = null, layer, name, format, whole = false } = {}) {
  const dir = layerDirFor(layer, projectDir)
  const skillName = requireName(name)
  const hit = await resolveInLayer(dir, skillName, requireFormat(format))
  if (!hit) throw new SkillError(404, `技能不存在：${skillName}`)

  const target = assertInside(dir, hit.path)
  try {
    await unlink(target)
  } catch (e) {
    throw fsError(e, "技能文件") // ENOENT = 在解析与删除之间被并发删掉（报 404 比原样丢 errno 更贴事实）
  }
  let removed = hit.path
  let note = null

  if (hit.format === "dir") {
    const dirPath = join(dir, skillName)
    if (whole) {
      // 用户裁定 2026-09-28：连**整个目录**一起删（含资源文件）。
      // 目标先过归属断言——递归删不可逆，路径必须确定在层目录内（assertInside 与写路径同一套判据）。
      assertInside(dir, dirPath)
      const entries = await readdir(dirPath).catch(() => [])
      try {
        await rm(dirPath, { recursive: true, force: true })
      } catch (e) {
        throw fsError(e, "技能目录")
      }
      removed = dirPath
      note = `整个目录已删除（含 ${entries.length} 个同级条目）`
    } else {
      let rest = []
      try { rest = await readdir(dirPath) } catch { /* 目录已被并发删除 */ }
      if (rest.length) {
        note = `目录保留（还有 ${rest.length} 个文件：${rest.join(", ")}）`
      } else {
        try { await rmdir(dirPath); removed = dirPath } catch { /* 已被并发删除 */ }
      }
    }
  }

  const state = await listSkills({ projectDir })
  // 本次操作的提示优先于 listSkills 的「未打开项目」提示（两者都成立时合并，绝不静默丢一条）
  const mergedNote = [state.note, note].filter(Boolean).join("；")
  return { ok: true, removed, name: skillName, layer, ...state, ...(mergedNote ? { note: mergedNote } : {}) }
}

// ================= 对外：导入落盘 =================

/**
 * 技能导入的落盘面（导入 v1 的第二步；取源/扫描在 bridge/skills-import.mjs，那边**不碰任何技能目录**）。
 *
 * 为什么不信任入参（逐条都是真实攻击面，不是形式主义）：
 * - 暂存目录里的条目名是**外部内容**（clone 来的/用户指的目录）——`requireName` 逐条重验，名字非法
 *   （如 `../../evil`）该条 failed；**绝不整批中断**：一批里一条坏名字不该让其余条目白扫一次。
 * - `items` 是前端拼的，`action` 也只信「恰好等于 overwrite」——服务端自己拦「目标已存在」，
 *   不把「默认不覆盖」交给前端保证（前端有 bug 就会静默覆盖用户已有的技能）。
 * - 暂存目录可能已被 TTL / DELETE 清掉：`stagingDir` 必须存在且是目录，否则 400。
 *
 * v1 边界（写进这份注释，落地时就照它办）：dir 格式只写 SKILL.md 与暂存里的资源文件，
 * **绝不删目标目录里已有的其它文件**（那是 deleteSkill 的语义，不是导入的）。
 */
export async function applyImport({ projectDir = null, layer, stagingDir, items } = {}) {
  const dir = layerDirFor(layer, projectDir)
  const rootSt = await statOrNull(typeof stagingDir === "string" && stagingDir.trim() ? stagingDir : null)
  // 暂存根必须存在且是目录（已过期 / 已被 DELETE 收走 / 入参直接是垃圾）——三种都如实说「重新扫描」
  if (!rootSt?.isDirectory()) throw new SkillError(400, "导入暂存已失效（可能已过期或已放弃），请重新扫描")
  if (!Array.isArray(items)) throw new SkillError(400, "items 必须是数组")
  const staged = join(stagingDir, ".thincoder", "skills")

  const results = []
  for (const item of items) {
    const rawName = item?.name
    const action = item?.action === "overwrite" ? "overwrite" : "skip"
    try {
      const name = requireName(rawName) // 非法名 / 名字类型不对 → 本项 failed（SkillError 由下面 catch 收）
      // 源定位与内核 skills.mjs:70-81 同优先级（子目录 SKILL.md 优先 → 扁平 .md）
      const srcDir = join(staged, name)
      const srcFlat = join(staged, name + ".md")
      const format = (await existsAt(srcDir)) ? "dir" : (await isFileAt(srcFlat)) ? "flat" : null
      if (!format) throw new SkillError(404, `暂存里已不存在：${name}（可能已过期，请重新扫描）`)

      // 服务端自带拦截：目标层任何形态被占（与 plan 的冲突列同一判据）且未显式要求覆盖 → 跳过
      if ((await conflictAt(dir, name)) && action !== "overwrite") {
        results.push({ name, action, status: "skipped" })
        continue
      }
      await mkdir(dir, { recursive: true })
      // 跨格式覆盖的真相要说在前面：内核子目录优先（core/skills.mjs:74-80 的 added 短路），所以「另一种形态」
      // 的条目决定谁真正生效。但**判据不能只看存在性**：子目录的 SKILL.md「可 stat 不可读」时内核
      // tryReadSkill 返回 null（core/skills.mjs:23-44，本模块 entryOf 的注释也记了这条）、会**回退采用
      // 扁平文件**——那种情况下 flat 候选这次写入其实会生效，说「不会生效」就是把话说反了。
      const other = format === "flat" ? join(dir, name, "SKILL.md") : join(dir, name + ".md")
      const otherAdopted = format === "flat"
        ? (await isFileAt(other)) && (await readFile(other).then(() => true).catch(() => false))
        : await isFileAt(other)
      const shadowNote = otherAdopted
        ? format === "flat"
          ? `本次写入的 ${name}.md 被同名子目录技能遮蔽，不会生效（内核子目录优先）`
          : `目标原有的 ${name}.md 仍在，已被同名子目录遮蔽（内核子目录优先）`
        : null
      if (format === "flat") {
        const target = assertInside(dir, join(dir, name + ".md"))
        await writeAtomic(target, await readFile(srcFlat))
      } else {
        // 目标同名位置是**文件**时无法写成目录（v1 不做改名冲突动作）：如实报失败，
        // 不让 ENOTDIR/EEXIST 这类 errno 原文丢给界面
        if (await isFileAt(join(dir, name))) {
          throw new SkillError(409, `目标已有同名文件：${name}（无扩展名，写不成同名目录；请先删除或改名后再导入）`)
        }
        await copySkillEntry(srcDir, join(dir, name), dir)
      }
      results.push({ name, action, status: "written", ...(shadowNote ? { note: shadowNote } : {}) })
    } catch (e) {
      // 任何一项失败都不带动其余项：errno 归类走本模块 fsError 的中文口吻（EACCES/EPERM 等）
      const err = fsError(e, "技能")
      results.push({ name: typeof rawName === "string" ? rawName : null, action, status: "failed", error: err?.message ?? String(err) })
    }
  }
  return { ok: true, results, ...(await listSkills({ projectDir })) }
}

