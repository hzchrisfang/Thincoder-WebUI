/**
 * bridge/skills-import.mjs — 技能导入 v1 的**取源面**：把「本地目录 / Git 仓库」里的技能条目抓到
 * os.tmpdir() 下的暂存区，产出候选清单。**全程不碰任何技能目录**——落盘是 skills.applyImport 的事
 * （两段式：plan 只读、apply 才写；用户看清楚要装什么再决定装什么）。
 *
 * 零重实现纪律（与 bridge/skills.mjs 同一条）：
 * - 「内核认不认」「描述是什么」一律取内核 `loadSkills`：把暂存布局造成 `<workDir>/.thincoder/skills/`，
 *   于是 `loadSkills(<workDir>)` 的**项目层**恰好就是暂存区——复用内核的发现规则与描述提取
 *   （core/skills.mjs:23-44 / 52-85），本模块一行都不自算描述。
 *   代价是内核同时会读真用户层（`~/.thincoder/skills`，core/skills.mjs:92-110）——按 path 过滤掉即可
 *   （只有落在暂存区里的条目才是本次的候选）。
 * - 名字白名单 / 层目录 / 路径归属 / 目录复制全部复用 skills.mjs 的导出件（跨模块单源，判据不会漂移）。
 *
 * 安全边界（导入是第一次把**不受信任的内容**引进技能目录的入口）：
 * - Git：显式拒绝 `ext::` 传输（git 的 ext 传输会执行任意命令 = RCE），并在 clone 命令上再挂
 *   `protocol.ext.allow=never` / `core.askPass=` / `GIT_TERMINAL_PROMPT=0`（不让 git 弹交互、不读系统配置）。
 * - 复制：符号链接一律跳过、绝不跟随（skills.copySkillEntry）；每个目标路径都过 assertInside。
 * - 临时目录一律在 os.tmpdir() 下（绝不落在工作树里）；TTL 10 分钟兜底清理 + 显式 DELETE。
 */

import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { homedir, tmpdir } from "node:os"
import { basename, isAbsolute, join, resolve } from "node:path"
import { loadThincoder } from "./thincoder.mjs"
import { SkillError, conflictAt, copySkillEntry, declaredMeta, insideLayer, layerDirFor } from "./skills.mjs"

/** 与内核 skills.mjs:18 / bridge/skills.mjs:36 同源：内核不认的名字这里也不认（否则会造出内核看不见的文件） */
const NAME_RE = /^[a-zA-Z0-9_-]+$/

/** 扁平技能条目：<name>.md（名字部分必须过白名单——`bad name.md` 因此落选，与内核一致） */
const FLAT_RE = /^([a-zA-Z0-9_-]+)\.md$/

/** 导入源类型（前端 SkillImportKind 与此对齐） */
const KINDS = ["dir", "git"]

/** 暂存生命期：兜底自动清理（显式 DELETE 是主路径） */
const DEFAULT_TTL_MS = 10 * 60_000

/** git 子进程超时：clone 挂死不能拖垮整个请求 */
const GIT_TIMEOUT_MS = 120_000

/** 候选预览：正文前 20 行、且截 2048 个 UTF-16 码元（纯 ASCII 约为 2KB；中文一字一码元、字节能多好几倍——
 *  所以别把它当字节上限读。口径写准，免得后人按「2KB」去推字符数） */
const PREVIEW_LINES = 20
const PREVIEW_CHARS = 2048

/** 单次导入的上限（文件数与总字节）：一次导入不能把 os.tmpdir() 写满、也不能把请求长挂住。
 *  在**复制过程中**就拦（等到整棵子树复制完再判，临时目录已经被写满了），触发即整批失败，外层负责清场。
 *  注：git 源的 clone 本身拦不了体积（`--depth 1` 只限历史），这上限管的是**要落地的技能内容**。
 *  两个上限都**每次调用现读环境变量**（同 TTL 的做法）：模块级常量在 import 时就固化了，测试根本调不动它。 */
const maxFiles = () => Number(process.env.TCW_SKILLIMPORT_MAX_FILES) || 500
const maxBytes = () => Number(process.env.TCW_SKILLIMPORT_MAX_BYTES) || 50 * 1024 * 1024

/** clone 失败/校验失败时回给用户看的 stderr 尾部长度 */
const STDERR_TAIL = 200

/**
 * TTL 每次调用时读环境变量——生产是默认 10 分钟；测试可以把它调到几十毫秒来验证清理（不必 sleep 十分钟）。
 * 读 `process.env` 而非常量：同一进程里改环境即可改行为（e2e 的短 TTL 用例就靠这条）。
 */
function ttlMs() {
  const n = Number(process.env.TCW_SKILLIMPORT_TTL_MS)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS
}

/** 计划表（内存态：进程重启即失效——暂存目录本身也在 tmp 下，重启后一并成孤儿，由 OS 回收 tmp 兜底） */
const plans = new Map()

/** 惰性清扫：getPlan / dropPlan 时顺手把过期计划连同暂存目录一起收掉（兜底，不是主路径） */
async function sweepExpired(now = Date.now()) {
  const ttl = ttlMs()
  for (const plan of [...plans.values()]) {
    if (now - plan.createdAt >= ttl) await dropPlan(plan.id)
  }
}

/**
 * 取一个计划（路由拿它的 stagingDir 传给 skills.applyImport）。
 * 过期即清（惰性清扫挂在这里）——返回 null 让路由回 404「请重新扫描」，绝不返回一个指向已删目录的计划。
 */
export async function getPlan(id) {
  await sweepExpired()
  const plan = plans.get(typeof id === "string" ? id : "")
  return plan ? { id: plan.id, dir: plan.dir, source: plan.source, candidates: plan.candidates, note: plan.note } : null
}

/** 放弃一个计划（DELETE /api/skills/import/:id 与 TTL 到期的共同收尾）：删暂存目录 + 摘表。未知 id → false */
export async function dropPlan(id) {
  const plan = plans.get(typeof id === "string" ? id : "")
  if (!plan) return false
  plans.delete(plan.id)
  if (plan.timer) clearTimeout(plan.timer)
  await rm(plan.dir, { recursive: true, force: true }).catch(() => { /* 目录已被清掉也算放弃成功 */ })
  return true
}

// ================= 参数校验（建任何目录之前做完） =================

/** `~` 展开用 os.homedir()（Windows 没有 HOME 环境变量，AGENTS.md F 条） */
function expandHome(p) {
  if (p === "~") return homedir()
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2))
  return p
}

/** subpath 必须是源目录内的相对路径：绝对路径 / `..` 段一律拒（与 assertInside 同一条精神的宽松版） */
function checkSubpath(raw) {
  const s = String(raw).trim()
  if (!s) return null
  if (isAbsolute(s)) throw new SkillError(400, "subpath 必须是源目录内的相对路径")
  const segs = s.split(/[\\/]+/).filter((x) => x && x !== ".")
  if (segs.some((x) => x === "..")) throw new SkillError(400, "subpath 不能包含 ..（会越出源目录）")
  return segs.join("/")
}

/**
 * git 地址的传输层校验（**白名单**，与界面文案同一口径）：
 * 允许 https:// · http:// · ssh:// · file:// · git@host:path（scp 形式）· 本地路径（`~` 会用
 * os.homedir() 展开——git 自己不认 `~`）。其余一律 400。
 * 为何白名单而不是「只拒 ext::」：`ext::`（git 的 ext 传输会执行任意命令 = RCE）最危险，但文案写着
 * 「只允许四种形态」而实现放行任意 scheme，就是「说一套做一套」——直接按白名单收口。
 */
function precheckGitUrl(raw) {
  const u = typeof raw === "string" ? raw.trim() : ""
  if (!u) throw new SkillError(400, "请填写 Git 仓库地址")
  if (/^ext::/i.test(u)) {
    throw new SkillError(400, "不允许 ext:: 传输（它会执行任意命令）；请改用 https://、http://、ssh://、git@host:path 或本地路径")
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*::/.test(u)) {
    throw new SkillError(400, "不支持双冒号传输形式；请改用 https://、http://、ssh://、git@host:path 或本地路径")
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(u)) {
    if (!/^(https?|ssh|file):\/\//i.test(u)) {
      throw new SkillError(400, "只支持 https:// / http:// / ssh:// / file:// / git@host:path / 本地路径")
    }
    return u
  }
  // scp 形式 host:path / user@host:path（排除 Windows 盘符 C:\ 与 C:/）
  if (!/^[a-zA-Z]:[\\/]/.test(u) && /^[^\\/\s]+:[^\s]+$/.test(u)) return u
  return resolve(expandHome(u)) // 其余当本地路径（git 能 clone 本地目录）
}

/** 本地目录源：必须有值、存在、且是目录（三种情况各自的文案分开说，别把「没填」说成「不存在」） */
async function resolveLocalDir(raw) {
  const s = typeof raw === "string" ? raw.trim() : ""
  if (!s) throw new SkillError(400, "请填写本地目录路径")
  const abs = resolve(expandHome(s))
  let st
  try {
    st = await stat(abs)
  } catch {
    throw new SkillError(400, `本地目录不存在：${abs}`)
  }
  if (!st.isDirectory()) throw new SkillError(400, `路径不是目录：${abs}`)
  return abs
}

// ================= git =================

/** 跑一条 git 命令（数组 argv 裸 spawn：git 是真可执行文件，win32 也无需 shell 包装；AGENTS.md F 条） */
function runGit(args, { cwd } = {}) {
  return new Promise((resolveRun) => {
    let child
    try {
      child = spawn("git", args, {
        cwd,
        // 不弹交互（终端提示 / askpass 都停用）+ 不读系统配置：clone 一条不受信任的仓库不能有任何人工停顿
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", GIT_CONFIG_NOSYSTEM: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (e) {
      resolveRun({ code: -1, stdout: "", stderr: String(e?.message ?? e) })
      return
    }
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => { try { child.kill("SIGKILL") } catch { /* 已退出 */ } }, GIT_TIMEOUT_MS)
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("error", (e) => {
      clearTimeout(timer)
      resolveRun({ code: -1, stdout, stderr: `${stderr}${e?.message ?? e}` })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolveRun({ code: code ?? -1, stdout, stderr })
    })
  })
}

const tail = (s, n = STDERR_TAIL) => {
  const t = String(s ?? "").trim()
  return t.length > n ? t.slice(-n) : t
}

/**
 * clone 到 dest，返回 dest。加固四条与设计逐条对齐：
 * `-c protocol.ext.allow=never`（再挡一次 ext 传输）/ `-c core.askPass=`（清掉 askpass 来源）/
 * 三个 GIT_* 环境变量 / 120s 超时（runGit 内）。
 */
async function cloneGit({ url, ref, dest }) {
  const u = precheckGitUrl(url)
  const args = ["-c", "protocol.ext.allow=never", "-c", "core.askPass=", "clone", "--depth", "1"]
  if (ref !== undefined && ref !== null && String(ref).trim()) args.push("--branch", String(ref).trim())
  args.push("--", u, dest)
  const r = await runGit(args)
  if (r.code !== 0) {
    const why = tail(r.stderr) || "（git 没有输出错误信息）"
    throw new SkillError(400, `Git 克隆失败：${why}（请检查仓库地址、网络与访问权限）`)
  }
  return dest
}

/** clone 后的 commit（短 sha 前 12 位；拿不到就不编造，如实缺省） */
async function gitHead(repoDir) {
  const r = await runGit(["-C", repoDir, "rev-parse", "HEAD"])
  const sha = r.stdout.trim()
  return r.code === 0 && sha ? sha.slice(0, 12) : null
}

// ================= 源扫描（不猜：按候选顺序探测） =================

const statOrNull = async (p) => {
  if (!p) return null
  try {
    return await stat(p)
  } catch {
    return null
  }
}

const isFileAt = async (p) => (await statOrNull(p))?.isFile() ?? false
const isDirAt = async (p) => (await statOrNull(p))?.isDirectory() ?? false

/** 该目录里是否至少有一个技能条目（.md 文件，或含 SKILL.md 的目录）——探测判据，与内核同规则 */
async function hasSkillEntry(dir) {
  return (await classify(dir)).skills.length > 0
}

/**
 * 分类一个目录的**一级条目**（不递归）：技能条目 vs 内核不认的条目。
 * 规则逐条镜像内核 loadSkillsFromDir（core/skills.mjs:52-85）：子目录要名字过白名单且含 SKILL.md 文件；
 * 扁平要 <name>.md 且名字过白名单；其余（README.txt / `bad name.md` / 无 SKILL.md 的目录 / 软链）
 * 都是「内核不认」——这类条目的名字要如实回给用户（note），否则他们会以为源里的东西全装进来了。
 */
async function classify(dir) {
  const list = await readdir(dir, { withFileTypes: true }).catch(() => [])
  list.sort((a, b) => a.name.localeCompare(b.name))
  const skills = []
  const ignored = []
  for (const entry of list) {
    if (entry.isSymbolicLink()) {
      ignored.push(entry.name) // 软链不跟随（复制阶段也会跳过它）——如实记为「没装进来」
      continue
    }
    if (entry.isDirectory()) {
      if (NAME_RE.test(entry.name) && (await isFileAt(join(dir, entry.name, "SKILL.md")))) {
        skills.push({ name: entry.name, format: "dir", src: join(dir, entry.name) })
      } else {
        ignored.push(entry.name)
      }
      continue
    }
    const m = entry.isFile() ? entry.name.match(FLAT_RE) : null
    if (m) skills.push({ name: m[1], format: "flat", src: join(dir, entry.name) })
    else ignored.push(entry.name)
  }
  return { skills, ignored }
}

/**
 * 选定「源里的技能目录」，候选顺序（缺省不猜，逐条按序命中）：
 *   subpath（给了就用它）→ **所选目录自身含 SKILL.md**（整目录 = 一个技能）→ 源根/skills
 *   → 源根/.thincoder/skills → 源根自身（技能集合）
 * subpath 越界/不存在一律 400；其它候选只有「真有技能条目」才会被选中。
 * 「自身含 SKILL.md 优先」是用户裁定（2026-09-27）：用户选的就是技能本体时，不该再去猜它的子目录。
 */
async function pickSkillsDir(sourceDir, subpath) {
  if (subpath) {
    const sub = checkSubpath(subpath)
    const dir = sub ? resolve(sourceDir, sub) : sourceDir
    if (sub && !insideLayer(sourceDir, dir)) throw new SkillError(400, "subpath 越出源目录")
    if (!(await isDirAt(dir))) throw new SkillError(400, `subpath 指向的目录不存在：${sub}`)
    return dir
  }
  if (await isFileAt(join(sourceDir, "SKILL.md"))) return sourceDir
  for (const rel of ["skills", join(".thincoder", "skills")]) {
    const dir = join(sourceDir, rel)
    if (await hasSkillEntry(dir)) return dir
  }
  return sourceDir
}

/** 一个技能条目都没有时的 400 文案：列出源根一级条目名，请用户给 subpath（不猜下去） */
async function noSkillMessage(sourceDir) {
  const names = (await readdir(sourceDir, { withFileTypes: true }).catch(() => [])).map((e) => e.name)
  names.sort((a, b) => a.localeCompare(b))
  return "源里没找到技能条目（名字只含字母、数字、下划线、连字符的 .md 文件，或含 SKILL.md 的子目录）。"
    + `源根一级条目：${names.length ? names.join("、") : "（空目录）"}。若技能在子目录里，请填写 subpath。`
}

// ================= 候选构建 =================

/** 预览：正文前 20 行，且截 2048 个码元；切到代理对中间会把高代理项单独留下（JSON 里成孤立代理项），故末尾补一刀 */
const previewOf = (text) => {
  const s = String(text ?? "").split("\n").slice(0, PREVIEW_LINES).join("\n").slice(0, PREVIEW_CHARS)
  return /[\uD800-\uDBFF]$/.test(s) ? s.slice(0, -1) : s
}

/** 内核会报的落点：dir 格式报 `<name>/SKILL.md`，flat 报 `<name>.md`。
 *  记账与「掉队」判据都必须用它——内核的 `loadSkills` 结果里 dir 条目的 path 是 SKILL.md，不是目录。 */
const kernelPathOf = (stagingDir, s) =>
  resolve(s.format === "flat" ? join(stagingDir, s.name + ".md") : join(stagingDir, s.name, "SKILL.md"))

/**
 * 单技能目录（用户裁定 2026-09-27）：所选目录根上有 `SKILL.md` ⇒ 整目录当成**一个**技能，
 * 目录里的其它条目（`notes.md`、`scripts/`…）作为它的资源文件一并写入——不再各算一个技能。
 * 改前按内核的发现规则逐条分类时，根上的 `SKILL.md` 会被当成名字叫 `SKILL` 的扁平技能（用户报的缺陷）。
 */

// frontmatter 解析已上移到 `bridge/skills.mjs` 的 `declaredMeta`（那边也要读作者自述）——
// **全仓只留一套解析规则**，别再在本文件里写第二份

/** 规范化成内核认的名字：非白名单字符整段换成 `-`、折叠、去首尾；结果仍不合规就返回 null（交给上层回落） */
const normalizeToName = (raw) => {
  const s = String(raw ?? "").trim()
  if (NAME_RE.test(s)) return s
  const slug = s.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-_]+|[-_]+$/g, "")
  return NAME_RE.test(slug) ? slug : null
}

/** 名字决议：frontmatter `name:` → 目录名；两者都不合规就规范化；仍取不出合法名 ⇒ 400 说清怎么办 */
const resolveSkillName = (metaName, dirBase) => {
  for (const cand of [metaName, dirBase]) {
    if (cand && NAME_RE.test(String(cand).trim())) return { name: String(cand).trim(), note: null }
  }
  const slug = [metaName, dirBase].map(normalizeToName).find(Boolean)
  if (slug) {
    const from = metaName ? `SKILL.md 的 frontmatter name:（${metaName}）` : `目录名（${dirBase}）`
    return { name: slug, note: `名字取自 ${from}，含不合规字符已规范化为「${slug}」` }
  }
  throw new SkillError(
    400,
    "技能名取不出合法名字：frontmatter name: 与目录名都不合规（只允许字母、数字、下划线、连字符）——"
      + "请改目录名，或在 SKILL.md 的 frontmatter 里写一个合法的 name:",
  )
}

/** 把「自身即技能」的目录整理成一条候选来源（外加如实交代用的 notes）；名字可能≠目录名 ⇒ 暂存与落点一律以 name 为准 */
async function singleSkillEntry(dir) {
  const doc = await readFile(join(dir, "SKILL.md"), "utf8").catch(() => "")
  const metaName = declaredMeta(doc).name
  const { name, note } = resolveSkillName(metaName, basename(dir))
  const notes = ["所选目录根上有 SKILL.md ⇒ 按「整目录 = 一个技能」处理，目录里的其它条目会作为它的资源文件一并写入"]
  if (note) notes.push(note)
  else if (metaName && name !== basename(dir)) notes.push(`名字取自 SKILL.md 的 frontmatter name:（${name}）`)
  return { entry: { name, format: "dir", src: dir }, notes }
}

/**
 * 取源 + 扫描 + 暂存，返回 `{ id, source, candidates, note? }`。**不碰任何技能目录**（冲突只读比对）。
 *
 * @param {{ kind: "dir"|"git", path?: string, url?: string, subpath?: string, ref?: string,
 *           layer: "project"|"user", projectDir?: string|null }} p
 */
export async function prepareImport({ kind, path, url, subpath, ref, layer, projectDir = null } = {}) {
  if (!KINDS.includes(kind)) throw new SkillError(400, `导入源类型无效（只支持 dir 或 git）：${String(kind)}`)
  // 目标层口径复用同一处：非法 layer / 项目层缺 project → 400 中文（与其余技能接口同文案）
  const targetDir = layerDirFor(layer, projectDir)
  const refVal = ref === undefined || ref === null || !String(ref).trim() ? null : String(ref).trim()

  // ---- 参数校验放在建目录之前：非法入参绝不留下任何临时目录（A7 的断言面） ----
  if (kind === "git") precheckGitUrl(url)
  if (subpath) checkSubpath(subpath)
  const localDir = kind === "dir" ? await resolveLocalDir(path) : null

  const id = randomUUID()
  const workDir = join(tmpdir(), `tcw-skillimport-${id}`)
  const stagingDir = join(workDir, ".thincoder", "skills")
  try {
    await mkdir(stagingDir, { recursive: true }) // 暂存布局 = 内核「项目层」的形状，loadSkills(workDir) 直接可读
    const sourceDir = localDir ?? (await cloneGit({ url, ref: refVal, dest: join(workDir, "repo") }))
    const commit = kind === "git" ? await gitHead(sourceDir) : null

    const found = await pickSkillsDir(sourceDir, subpath)
    // 所选目录自身含 SKILL.md ⇒ 整目录当成**一个**技能（用户裁定 2026-09-27）；否则按「技能集合」逐条列
    const singleInfo = (await isFileAt(join(found, "SKILL.md"))) ? await singleSkillEntry(found) : null
    const entries = singleInfo ? { skills: [singleInfo.entry], ignored: [] } : await classify(found)
    if (!entries.skills.length) throw new SkillError(400, await noSkillMessage(sourceDir))

    // 复制技能条目进暂存（软链跳过；设备/管道等无内容条目不计）——尺寸在复制时顺带量出来。
    // **按暂存落点记账**，不按名字：源里可能同时有 x.md 与 x/SKILL.md（内核只采用子目录那条），
    // 按名字记账会让后者把前者的文件数覆盖掉，候选行于是写出一个错的「将写入 N 个文件」。
    const sizes = new Map()
    let totalFiles = 0
    let totalBytes = 0
    for (const s of entries.skills) {
      const dest = s.format === "flat" ? join(stagingDir, s.name + ".md") : join(stagingDir, s.name)
      try {
        const size = await copySkillEntry(s.src, dest, stagingDir)
        sizes.set(kernelPathOf(stagingDir, s), size)
        totalFiles += size.files
        totalBytes += size.bytes
      } catch {
        sizes.set(kernelPathOf(stagingDir, s), { files: 0, bytes: 0 }) // 复制失败 → 内核自然认不出它，落到 note 里如实说
      }
      if (totalFiles > maxFiles()) throw new SkillError(400, `源里要导入的文件太多（已超过 ${maxFiles()} 个）：请缩小范围（用子目录指向单个技能）后再试`)
      if (totalBytes > maxBytes()) throw new SkillError(400, `源太大（已超过 ${Math.round(maxBytes() / 1024 / 1024)}MB）：请缩小范围（用子目录指向单个技能）后再试`)
    }

    // 内核认不认 / 描述是什么：全取内核（本模块零自算）。注意内核会一并读真用户层 ⇒ 按 path 只留暂存区内的
    const t = await loadThincoder()
    if (!t.skills) throw new SkillError(501, "当前内核不支持技能管理（缺 core/skills.mjs）")
    const recognized = (await t.skills.loadSkills(workDir)).filter((s) => insideLayer(stagingDir, resolve(s.path)))

    const candidates = []
    for (const s of recognized) {
      const format = s.path.endsWith("SKILL.md") ? "dir" : "flat"
      const size = sizes.get(resolve(s.path)) ?? { files: 0, bytes: 0 }
      const doc = await readFile(s.path, "utf8").catch(() => "")
      candidates.push({
        name: s.name,
        format,
        description: s.description, // 内核原话，绝不自算（与注入 system prompt 的那份同源）
        declaredDescription: declaredMeta(doc).description, // 作者自述：面板显示以它优先（用户裁定 2026-09-27）
        size: size.bytes,
        files: size.files,
        preview: previewOf(doc),
        conflict: await conflictAt(targetDir, s.name), // 只读比对，不碰技能目录
      })
    }
    candidates.sort((a, b) => a.name.localeCompare(b.name)) // 表序确定，不随文件系统漂移

    // 「内核不认 / 不被采用」如实上报：源里落选的条目 + 复制/识别阶段掉队的条目（绝不静默丢一条）。
    // 判据用**暂存落点**（每条目唯一），不用名字：源里同名两形态（x.md + x/SKILL.md）时按名字判会把
    // 被内核短路的那条误算成「已识别」——于是它既不在候选里也不在 note 里，正是「静默丢一条」。
    const recognizedPaths = new Set(recognized.map((s) => resolve(s.path)))
    const missed = new Set(entries.ignored)
    for (const s of entries.skills) {
      // 带上形态（`x.md` / `x/`）——光名字看不出说的是哪一条
      if (!recognizedPaths.has(kernelPathOf(stagingDir, s))) missed.add(s.format === "flat" ? `${s.name}.md` : `${s.name}/`)
    }
    const noteParts = [
      ...(singleInfo?.notes ?? []),
      missed.size
        ? `源里有 ${missed.size} 个条目不会生效（内核不认，或同名的子目录优先），已忽略：${[...missed].sort((a, b) => a.localeCompare(b)).join("、")}`
        : null,
    ].filter(Boolean)
    const note = noteParts.length ? noteParts.join("；") : null

    const source = { kind, label: kind === "dir" ? sourceDir : precheckGitUrl(url), ...(refVal ? { ref: refVal } : {}), ...(commit ? { commit } : {}) }
    const plan = {
      id, dir: workDir, source, candidates, note,
      createdAt: Date.now(),
      timer: setTimeout(() => { void dropPlan(id) }, ttlMs()), // 兜底：就算用户既没点导入也没点放弃
    }
    plan.timer.unref?.() // 别让兜底定时器把服务进程钉在事件循环上
    plans.set(id, plan)
    return { id, source, candidates, ...(note ? { note } : {}) }
  } catch (e) {
    // 失败即清场：临时目录绝不留在盘上（成功路径的清理归 TTL / DELETE）
    await rm(workDir, { recursive: true, force: true }).catch(() => { /* 清不掉也不能吞掉原错 */ })
    throw e
  }
}
