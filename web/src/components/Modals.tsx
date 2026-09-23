import { useState } from "react"
import type { DiffInfo, PendingRequest } from "../lib/types"
import { argSummary } from "./ToolCard"
import DiffViewer from "./DiffViewer"

interface Props {
  req: PendingRequest
  queueCount: number
  /** 当前所在项目：弹窗属于其它项目时显示项目名徽标（跨项目并行场景） */
  currentProject?: string | null
  onDecide: (reqId: string, allow: boolean, remember: boolean) => void
  onAnswer: (reqId: string, answer: string) => void
}

const BASE_NAME = (n: string) => (/[\\/]/.test(n) ? n.split(/[\\/]/).pop()! : n)
/** 项目目录 → 短名（弹窗徽标用；双分隔符兼容 Windows 反斜杠） */
const PROJECT_NAME = (dir: string) => dir.split(/[\\/]/).filter(Boolean).pop() ?? dir

export default function Modals({ req, queueCount, currentProject, onDecide, onAnswer }: Props) {
  const [remember, setRemember] = useState(false)
  const [answer, setAnswer] = useState("")
  const fromOther = Boolean(req.project && currentProject && req.project !== currentProject)
  const projectBadge = fromOther && (
    <span
      className="ml-auto max-w-[40%] truncate rounded-full bg-sky-950 px-2.5 py-0.5 text-xs text-sky-300"
      title={req.project}
    >
      项目 {PROJECT_NAME(req.project)}
    </span>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4 backdrop-blur-sm">
      <div className="rise w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-surface shadow-lg">
        {req.reqType === "approval" ? (
          <>
            <div className="flex items-center gap-2.5 border-b border-line px-5 py-4">
              <span className="inline-block h-2 w-2 rounded-full bg-accent" />
              <div className="text-sm font-medium text-t1">
                请求执行 <span className="font-mono text-accent">{req.name}</span>
              </div>
              {queueCount > 1 && (
                <span className="ml-auto rounded-full bg-surface3 px-2.5 py-0.5 text-xs text-t4">
                  还有 {queueCount - 1} 项排队
                </span>
              )}
              {projectBadge}
            </div>

            <div className="max-h-[55vh] overflow-y-auto px-5 py-4">
              <ApprovalDetail name={req.name} args={req.args} diff={req.diff} />
            </div>

            <div className="flex items-center gap-3 border-t border-line bg-surface2 px-5 py-3.5">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-t3">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="accent-accent"
                />
                本会话总是允许 {BASE_NAME(req.name)}
              </label>
              <div className="flex-1" />
              <button onClick={() => onDecide(req.reqId, false, false)} className="btn-ghost px-4 py-2 text-sm">
                拒绝
              </button>
              <button onClick={() => onDecide(req.reqId, true, remember)} className="btn-primary px-5 py-2 text-sm">
                批准
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2.5 border-b border-line px-5 py-4">
              <span className="inline-block h-2 w-2 rounded-full bg-sky-400" />
              <div className="text-sm font-medium text-t1">Agent 提问</div>
              {projectBadge}
            </div>

            <div className="max-h-[55vh] overflow-y-auto px-5 py-4">
              <div className="whitespace-pre-wrap text-sm leading-relaxed text-t-body">{req.question}</div>
              {req.options.length > 0 && (
                <div className="mt-3.5 flex flex-col gap-2">
                  {req.options.map((o) => (
                    <button
                      key={o}
                      onClick={() => onAnswer(req.reqId, o)}
                      className="rounded-xl border border-line2 bg-surface px-3.5 py-2.5 text-left text-sm text-t2 transition-colors hover:border-accent hover:bg-accent-soft"
                    >
                      {o}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 border-t border-line bg-surface2 px-5 py-3.5">
              <input
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && answer.trim()) onAnswer(req.reqId, answer.trim())
                }}
                placeholder="输入回答…"
                className="field min-w-0 flex-1 px-3.5 py-2 text-sm"
              />
              <button
                onClick={() => answer.trim() && onAnswer(req.reqId, answer.trim())}
                disabled={!answer.trim()}
                className="btn-primary px-4 py-2 text-sm"
              >
                回答
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** 审批正文：文件变更类优先展示 Diff（M1），其余按工具类型给可读细节 */
function ApprovalDetail({ name, args, diff }: { name: string; args: Record<string, unknown>; diff?: DiffInfo | null }) {
  const base = BASE_NAME(name)
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "")
  const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n…（共 ${s.length} 字符）` : s)

  if (base === "bash") {
    return (
      <div>
        <div className="mb-2 text-xs text-t3">将执行命令：</div>
        <pre className="overflow-x-auto rounded-xl bg-surface3 p-3.5 font-mono text-xs leading-relaxed text-t1">
          {str("command")}
        </pre>
      </div>
    )
  }

  if (base === "write") {
    return (
      <div className="flex flex-col gap-2.5">
        <div className="text-xs text-t3">
          写入 <span className="font-mono text-t1">{str("path")}</span>
          <span className="text-t4">（{str("content").length} 字符）</span>
        </div>
        {diff ? (
          <DiffViewer diff={diff} />
        ) : (
          <pre className="max-h-64 overflow-auto rounded-xl bg-surface3 p-3.5 font-mono text-xs leading-relaxed text-t2">
            {cap(str("content"), 2000)}
          </pre>
        )}
      </div>
    )
  }

  if (base === "edit") {
    // 三种参数形态（与内核 edit 工具一一对应）——diff 缺失时兜底渲染也不落空白：
    // ① 内容 {path, old_string, new_string} ② 行号 {path, line|startLine+endLine, new_string?}（省略 = 删行）
    // ③ 批量 {path?, edits: [{path?, old_string|line|startLine+endLine, new_string}]}
    const edits = Array.isArray(args.edits) ? (args.edits as Record<string, unknown>[]) : null
    const lineNo = (o: Record<string, unknown>) =>
      typeof o.line === "number" ? o.line : typeof o.startLine === "number" ? o.startLine : null
    const lineEnd = (o: Record<string, unknown>) => (typeof o.endLine === "number" ? o.endLine : null)
    const s = (o: Record<string, unknown>, k: string) => (typeof o[k] === "string" ? (o[k] as string) : "")

    if (edits) {
      // 批量形态：逐条目「文件 · 定位 → 删除/删行 → 替换为」
      return (
        <div className="flex flex-col gap-2.5">
          <div className="text-xs text-t3">批量编辑 {edits.length} 条</div>
          {edits.slice(0, 20).map((e, i) => {
            const p = s(e, "path") || str("path") || "（顶层未传 path）"
            const hasLine = lineNo(e) != null
            const del = e.new_string === undefined // 行号形态省略 new_string = 删行
            const loc = hasLine
              ? `第 ${lineNo(e)}${lineEnd(e) ? `–${lineEnd(e)}` : ""} 行`
              : "内容定位"
            return (
              <div key={i} className="rounded-xl border border-line bg-surface2 p-2.5">
                <div className="mb-1.5 font-mono text-xs text-t2">
                  {i + 1}. {p} <span className="text-t4">· {loc}</span>
                </div>
                {!del && s(e, "old_string") !== "" && (
                  <pre className="mb-1.5 max-h-32 overflow-auto rounded-lg bg-red-950 p-2 font-mono text-xs leading-relaxed text-red-300">
                    {cap(s(e, "old_string"), 800)}
                  </pre>
                )}
                {!del && (
                  <pre className="max-h-32 overflow-auto rounded-lg bg-emerald-950 p-2 font-mono text-xs leading-relaxed text-emerald-300">
                    {cap(s(e, "new_string"), 800)}
                  </pre>
                )}
                {del && <div className="text-xs text-red-300">删行（执行时删除该行/范围）</div>}
                {!hasLine && s(e, "old_string") === "" && s(e, "new_string") === "" && (
                  <div className="text-xs text-t4">（条目无内容参数——执行时会报错）</div>
                )}
              </div>
            )
          })}
          {edits.length > 20 && <div className="text-xs text-t4">… 其余 {edits.length - 20} 条略</div>}
        </div>
      )
    }

    // 单形态：行号形态（无 old_string）
    const isLine = lineNo(args) != null
    if (isLine) {
      const del = args.new_string === undefined
      return (
        <div className="flex flex-col gap-2.5">
          <div className="text-xs text-t3">
            编辑 <span className="font-mono text-t1">{str("path")}</span>
            <span className="text-t4"> · 第 {lineNo(args)}{lineEnd(args) ? `–${lineEnd(args)}` : ""} 行</span>
          </div>
          {del ? (
            <div className="text-xs text-red-300">删行（执行时删除该行/范围）</div>
          ) : (
            <pre className="max-h-40 overflow-auto rounded-xl bg-emerald-950 p-3 font-mono text-xs leading-relaxed text-emerald-300">
              {cap(str("new_string"), 1000)}
            </pre>
          )}
        </div>
      )
    }

    // 单形态：内容定位——old/new 至少其一存在才渲染旧兜底，否则落通用 JSON 预览（不再出双空框）
    if (str("old_string") !== "" || str("new_string") !== "") {
      return (
        <div className="flex flex-col gap-2.5">
          <div className="text-xs text-t3">
            编辑 <span className="font-mono text-t1">{str("path")}</span>
          </div>
          {diff ? (
            <DiffViewer diff={diff} />
          ) : (
            <>
              <div>
                <div className="mb-1.5 text-xs font-medium text-red-300">− 删除</div>
                <pre className="max-h-40 overflow-auto rounded-xl bg-red-950 p-3 font-mono text-xs leading-relaxed text-red-300">
                  {cap(str("old_string"), 1000)}
                </pre>
              </div>
              <div>
                <div className="mb-1.5 text-xs font-medium text-emerald-300">＋ 替换为</div>
                <pre className="max-h-40 overflow-auto rounded-xl bg-emerald-950 p-3 font-mono text-xs leading-relaxed text-emerald-300">
                  {cap(str("new_string"), 1000)}
                </pre>
              </div>
            </>
          )}
        </div>
      )
    }
    // 落到末尾的通用 args JSON 预览
  }

  if (base === "delete") {
    return (
      <div className="flex flex-col gap-2.5">
        <div className="text-xs text-t3">
          删除文件 <span className="font-mono text-red-300">{str("path")}</span>
          {args.force ? <span className="text-t4">（force：跟踪文件也删）</span> : ""}
        </div>
        {diff && <DiffViewer diff={diff} />}
      </div>
    )
  }

  if (base === "subagent") {
    return (
      <div>
        <div className="mb-2 text-xs text-t3">派发子 agent：</div>
        <pre className="whitespace-pre-wrap rounded-xl bg-surface3 p-3.5 font-mono text-xs leading-relaxed text-t2">
          {cap(str("task"), 1000)}
        </pre>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-2 text-xs text-t3">{argSummary(name, args)}</div>
      <pre className="max-h-64 overflow-auto rounded-xl bg-surface3 p-3.5 font-mono text-xs leading-relaxed text-t2">
        {cap(JSON.stringify(args, null, 2), 2000)}
      </pre>
    </div>
  )
}
