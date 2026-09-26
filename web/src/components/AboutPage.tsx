import { useEffect, useRef, useState } from "react"
import { api } from "../lib/api"
import type { ServerEvent } from "../lib/types"
import TMark from "./TMark"
import Tooltip from "./Tooltip"

const GITHUB_URL = "https://github.com/hzchrisfang/Thincoder-WebUI"

/** 一键更新任务状态（/api/webui-update-status 与 SSE 载荷共用的前端视图） */
interface UpdateStatus {
  state: "idle" | "running" | "ok" | "failed"
  result: { version: string; at: number; skip?: boolean; message?: string } | null
  failure: { step: string; message: string } | null
  logTail: string[]
  logTotal: number
}

/** GitHub octocat 轮廓标（Star 按钮用） */
function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}

/** 关于页 —— 单卡：标题行（版本 + 检查 + Star）+ 简介 + 一键更新（0.8.0）+ 底行（内核适配 + 检查 + 更新日志） */
export default function AboutPage() {
  const [ver, setVer] = useState<{ webui: string; thincoder: string | null } | null>(null)
  // 内核最新版检查（打开本页即查，服务端有缓存；失败静默原位显示）
  const [ku, setKu] = useState<{
    installed: string | null
    latest: string | null
    source: string | null
    checkedAt: number
    error: string | null
    outdated: boolean
  } | null>(null)
  // WebUI 自身最新版检查（公开 GitHub 仓 main 分支 package.json；缓存策略同上）
  const [wu, setWu] = useState<{
    installed: string
    latest: string | null
    source: string | null
    checkedAt: number
    error: string | null
    outdated: boolean
  } | null>(null)
  // 一键半自动更新（0.8.0）：null=本进程从未跑过（不显示日志区）；
  // 有值即展示（刷新页面/关掉重开后由 status 接口恢复最近一次任务的进度与日志）
  const [upd, setUpd] = useState<UpdateStatus | null>(null)
  const updRef = useRef<UpdateStatus | null>(null)
  updRef.current = upd
  // 日志区自动滚动到底
  const logBoxRef = useRef<HTMLPreElement | null>(null)

  useEffect(() => {
    api.version().then(setVer).catch(() => {})
    setKu(null)
    api.kernelUpdate().then(setKu).catch(() => {})
    setWu(null)
    api.webuiUpdate().then(setWu).catch(() => {})
    // 恢复最近一次更新任务状态（页面刷新 / 关掉再回来）
    api
      .webuiUpdateStatus()
      .then((s) => {
        if (s.state !== "idle") setUpd({ ...s })
      })
      .catch(() => {})
  }, [])

  // SSE 跟随 App.tsx 现有模式：组件自建 EventSource，按 type 过滤 webui_update 事件。
  // 事件只带增量（phase/step/status/line），完整状态以 status 接口回读为准（进度/日志尾部）
  useEffect(() => {
    const es = new EventSource("/api/events")
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data) as ServerEvent
        if (ev.type !== "webui_update") return
        // 有事件流动说明任务活跃或刚结束：拉一次全量状态对齐（含日志尾部）
        api
          .webuiUpdateStatus()
          .then((s) => setUpd({ ...s }))
          .catch(() => {})
      } catch {
        /* 忽略坏事件 */
      }
    }
    es.onerror = () => {
      /* EventSource 自动重连 */
    }
    return () => es.close()
  }, [])

  // 日志追加时自动滚到底
  useEffect(() => {
    const box = logBoxRef.current
    if (box) box.scrollTop = box.scrollHeight
  }, [upd?.logTail.length, upd?.state])

  /** 点「一键更新」：确认文案讲清三件事（编排内容/重启生效/期间勿动 git、npm） */
  const applyUpdate = () => {
    if (!wu?.latest) return
    const ok = window.confirm(
      `将更新到 v${wu.latest}，服务端将依次执行：\n\n` +
        `1. 拉取公开仓新代码（git fetch + 快进合并）\n` +
        `2. 安装依赖（会执行依赖包脚本）\n` +
        `3. 重新构建前端并自动换入\n\n` +
        `完成后需手动重启服务才生效（启动终端 Ctrl+C 后 npm start）。\n` +
        `更新期间请勿在本机对 WebUI 目录执行任何 git / npm 操作。`
    )
    if (!ok) return
    setUpd({ state: "running", result: null, failure: null, logTail: [], logTotal: 0 })
    api
      .webuiApplyUpdate()
      .then(() => {
        // 触发成功：立刻拉一次状态（任务已异步开跑）
        api
          .webuiUpdateStatus()
          .then((s) => setUpd({ ...s }))
          .catch(() => {})
      })
      .catch((e) => {
        // 409 等失败：回到失败态展示
        setUpd({ state: "failed", result: null, failure: { step: "触发", message: e.message }, logTail: [], logTotal: 0 })
      })
  }

  const running = upd?.state === "running"

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto overflow-x-hidden px-8 py-8">
      <h1 className="mb-5 text-base font-medium text-t1">关于</h1>

      <div className="rounded-xl border border-line bg-surface px-5 py-4">
        {/* 标题行：标识 + 项目名 + 版本徽标（含 WebUI 最新版检查小字）+ Star 按钮 */}
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent">
            <TMark className="h-4 w-4 text-white" />
          </span>
          <span className="text-sm font-medium text-t1">Thincoder-WebUI</span>
          <span className="rounded-md bg-surface2 px-1.5 py-0.5 font-mono text-xs text-t3">
            v{ver?.webui ?? "…"}
          </span>
          {/* WebUI 自身最新版检查：小字不加粗、无括号——已是最新 / 有可用更新：vX.Y.Z；
              检查中留空，失败/镜像滞后说明进悬停。口径同内核——中性事实陈述；
              0.8.0 起 outdated 时旁边有一键更新按钮（服务端编排，完成后手动重启生效） */}
          {wu?.latest != null && (
            <Tooltip
              label={
                wu.outdated
                  ? `公开仓已发布 ${wu.latest}。可一键更新：自动拉取新代码、安装依赖并重新构建，完成后重启服务生效`
                  : wu.source === "jsdelivr"
                    ? "经 jsDelivr 镜像检查（缓存有滞后，结果可能偏旧）"
                    : undefined
              }
              side="top"
            >
              <span className={wu.outdated ? "text-xs text-accent" : "text-xs text-t4"}>
                {wu.outdated ? `有可用更新：v${wu.latest}` : "已是最新"}
              </span>
            </Tooltip>
          )}
          {wu?.latest == null && wu?.error && (
            <span className="text-xs text-t4" title={`最新版检查失败：${wu.error}`} />
          )}
          {/* 一键更新按钮：outdated 时出现在检查小字旁；进步度态（运行中禁用） */}
          {wu?.outdated && (
            <Tooltip label={running ? "更新进行中，可在下方日志区查看进度" : "服务端自动拉取、安装依赖并重新构建"} side="top">
              <button
                onClick={applyUpdate}
                disabled={running}
                className="shrink-0 rounded-lg bg-accent px-2.5 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {running ? "更新中…" : "一键更新"}
              </button>
            </Tooltip>
          )}
          <span className="flex-1" />
          <Tooltip label="到 GitHub 仓库点 Star" side="bottom">
            <a
              href={`${GITHUB_URL}/stargazers`}
              target="_blank"
              rel="noreferrer"
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line2 px-2.5 py-1 text-xs text-t3 transition-colors hover:border-t4/50 hover:bg-hover hover:text-t1"
            >
              <GitHubMark className="h-3.5 w-3.5" />
              Star
            </a>
          </Tooltip>
        </div>

        {/* 简介（用户定稿文案，三段） */}
        <div className="mt-3 space-y-1.5 text-xs leading-relaxed text-t4">
          <p>
            一款基于{" "}
            <a
              href="https://gitee.com/shanghai-xinbo/thincoder"
              target="_blank"
              rel="noreferrer"
              className="text-t3 underline decoration-line2 underline-offset-2 hover:text-t1"
            >
              Thincoder
            </a>{" "}
            的 Web 客户端，遵循一个朴素的愿景：简洁、方便、好用。
          </p>
          <p>
            交互上类似 Codex：你可以在本地或局域网的浏览器里，创建项目、和 Agent 对话、批准它调用工具、查看文件改动。
          </p>
        </div>

        {/* 一键更新：成功绿色横幅（重启指引）/ 失败红色（步骤名+日志尾部）/ 进度日志区 */}
        {upd && (
          <div className="mt-3.5">
            {upd.state === "ok" && upd.result && (
              <div className="rounded-lg border border-emerald-900 bg-emerald-950 px-3.5 py-2.5 text-xs leading-relaxed text-emerald-300">
                {upd.result.skip
                  ? `已与远端一致（v${upd.result.version}），无需更新。`
                  : `已更新到 v${upd.result.version}，重启服务后生效：在启动终端按 Ctrl+C 停止，再执行 npm start。`}
              </div>
            )}
            {upd.state === "failed" && upd.failure && (
              <div className="rounded-lg border border-red-900 bg-red-950 px-3.5 py-2.5 text-xs leading-relaxed text-red-300">
                <span className="font-medium">更新失败（{upd.failure.step}）：</span>
                {upd.failure.message}
              </div>
            )}
            {/* 日志区：运行中实时滚动；结束后保留最近一次任务日志（环形缓冲尾部） */}
            {upd.logTail.length > 0 && (
              <pre
                ref={logBoxRef}
                className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-line bg-bg px-3 py-2.5 font-mono text-[11px] leading-relaxed text-t4"
              >
                {upd.logTail.join("\n")}
              </pre>
            )}
            {running && (
              <p className="mt-1.5 text-[11px] text-t4">
                更新进行中：拉取公开仓 → 安装依赖 → 重新构建 → 换入。期间请勿对本目录执行 git / npm 操作。
              </p>
            )}
          </div>
        )}

        <div className="my-3 border-t border-line" />

        {/* 底行：内核适配 + 最新版检查（同款小字口径）+ 更新日志入口 */}
        <div className="flex items-center gap-2 text-xs text-t4">
          <span>
            适配 <span className="font-medium text-t3">Thincoder</span>
          </span>
          <span className="font-mono text-t3">
            {ver ? ver.thincoder ?? "未检测到" : "…"}
          </span>
          {/* 内核最新版检查：同款小字口径。有新版只做中性陈述——内核无稳定契约，
              直接升级可能造成 WebUI 桥接层不适配，是否升级由用户另行评估（悬停有提醒） */}
          {ku?.latest != null && (
            <Tooltip
              label={
                ku.outdated
                  ? `npm 已发布 ${ku.latest}。内核无稳定契约，升级需与 WebUI 桥接层同步适配，请勿直接升级`
                  : ku.source === "npmmirror"
                    ? "经 npmmirror 镜像源检查（同步有滞后，结果可能偏旧）"
                    : undefined
              }
              side="top"
            >
              <span className={ku.outdated ? "text-accent" : ""}>
                {ku.outdated ? `（有可用更新：v${ku.latest}）` : "（已是最新）"}
              </span>
            </Tooltip>
          )}
          {ku?.latest == null && ku?.error && (
            <span className="text-t4" title={`最新版检查失败：${ku.error}`} />
          )}
          <span className="flex-1" />
          <Tooltip label="公开仓 CHANGELOG.md" side="top">
            <a
              href={`${GITHUB_URL}/blob/main/CHANGELOG.md`}
              target="_blank"
              rel="noreferrer"
              className="text-t4/80 underline decoration-transparent underline-offset-2 transition-colors hover:text-t1 hover:decoration-line2"
            >
              更新日志
            </a>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}
