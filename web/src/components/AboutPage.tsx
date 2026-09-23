import { useEffect, useState } from "react"
import { api } from "../lib/api"
import TMark from "./TMark"

const GITHUB_URL = "https://github.com/hzchrisfang/Thincoder-WebUI"

/** GitHub octocat 轮廓标（Star 按钮用） */
function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  )
}

/** 关于页 —— 单卡：标题行（版本 + 检查 + Star）+ 简介 + 底行（内核适配 + 检查 + 更新日志） */
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

  useEffect(() => {
    api.version().then(setVer).catch(() => {})
    setKu(null)
    api.kernelUpdate().then(setKu).catch(() => {})
    setWu(null)
    api.webuiUpdate().then(setWu).catch(() => {})
  }, [])

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto px-8 py-8">
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
              检查中留空，失败/镜像滞后说明进悬停。口径同内核——中性事实陈述，
              是否升级（npm i / git pull 后重新 npm run build）由用户自行评估 */}
          {wu?.latest != null && (
            <span
              className={
                wu.outdated ? "text-xs text-accent" : "text-xs text-t4"
              }
              title={
                wu.outdated
                  ? `公开仓已发布 ${wu.latest}。更新需拉取新代码并重新构建（npm install → npm run build），请自行评估`
                  : wu.source === "jsdelivr"
                    ? "经 jsDelivr 镜像检查（缓存有滞后，结果可能偏旧）"
                    : undefined
              }
            >
              {wu.outdated ? `有可用更新：v${wu.latest}` : "已是最新"}
            </span>
          )}
          {wu?.latest == null && wu?.error && (
            <span className="text-xs text-t4" title={`最新版检查失败：${wu.error}`} />
          )}
          <span className="flex-1" />
          <a
            href={`${GITHUB_URL}/stargazers`}
            target="_blank"
            rel="noreferrer"
            title="到 GitHub 仓库点 Star"
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-line2 px-2.5 py-1 text-xs text-t3 transition-colors hover:border-t4/50 hover:bg-hover hover:text-t1"
          >
            <GitHubMark className="h-3.5 w-3.5" />
            Star
          </a>
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
            <span
              className={ku.outdated ? "text-accent" : ""}
              title={
                ku.outdated
                  ? `npm 已发布 ${ku.latest}。内核无稳定契约，升级需与 WebUI 桥接层同步适配，请勿直接升级`
                  : ku.source === "npmmirror"
                    ? "经 npmmirror 镜像源检查（同步有滞后，结果可能偏旧）"
                    : undefined
              }
            >
              {ku.outdated ? `（有可用更新：v${ku.latest}）` : "（已是最新）"}
            </span>
          )}
          {ku?.latest == null && ku?.error && (
            <span className="text-t4" title={`最新版检查失败：${ku.error}`} />
          )}
          <span className="flex-1" />
          <a
            href={`${GITHUB_URL}/blob/main/CHANGELOG.md`}
            target="_blank"
            rel="noreferrer"
            title="公开仓 CHANGELOG.md"
            className="text-t4/80 underline decoration-transparent underline-offset-2 transition-colors hover:text-t1 hover:decoration-line2"
          >
            更新日志
          </a>
        </div>
      </div>
    </div>
  )
}
