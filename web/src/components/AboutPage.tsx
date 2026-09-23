import { useEffect, useState } from "react"
import { api } from "../lib/api"
import TMark from "./TMark"

/** 关于页 —— 版本信息 + 内核最新版检查（自设置页迁出，左侧导航独立入口） */
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

  useEffect(() => {
    api.version().then(setVer).catch(() => {})
    setKu(null)
    api.kernelUpdate().then(setKu).catch(() => {})
  }, [])

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto px-8 py-8">
      <h1 className="mb-5 text-base font-medium text-t1">关于</h1>

      <div className="flex items-center gap-2 rounded-xl border border-line bg-surface px-4 py-3 text-xs text-t4">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-accent">
          <TMark className="h-3.5 w-3.5 text-white" />
        </span>
        <span>
          thincoder-webui <span className="font-mono text-t3">v{ver?.webui ?? "…"}</span>
        </span>
        <span className="text-t4/60">·</span>
        <span
          title={
            ku?.latest == null && ku?.error
              ? `最新版检查失败：${ku.error}`
              : ku?.source === "npmmirror"
                ? "经 npmmirror 镜像源检查（同步有滞后，结果可能偏旧）"
                : undefined
          }
        >
          内核 thincoder{" "}
          <span className="font-mono text-t3">
            {ver ? ver.thincoder ?? "未检测到" : "…"}
            {/* 最新版检查结果括号备注：检查中留空，失败/滞后源说明进悬停。
                有新版只做中性事实陈述（npm 最新 x.y.z），不写「可更新/升级」——
                内核无稳定契约，直接升级可能造成 WebUI 桥接层不适配，是否升级由用户另行评估 */}
            {ku?.latest != null &&
              (ku.outdated ? (
                <span
                  className="font-medium text-accent"
                  title={`npm 已发布 ${ku.latest}。内核无稳定契约，升级需与 WebUI 桥接层同步适配，请勿直接升级`}
                >
                  （npm 最新 {ku.latest}）
                </span>
              ) : (
                "（已是最新）"
              ))}
          </span>
        </span>
        <span className="flex-1" />
        <span className="text-t4/80">更新日志见仓库 CHANGELOG.md</span>
      </div>
    </div>
  )
}
