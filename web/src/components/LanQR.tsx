import { useMemo, useState } from "react"
import { QRCodeSVG } from "qrcode.react"

interface Props {
  port: number | null
  token: string | null
  addresses: { name: string; address: string }[]
}

/**
 * 局域网访问二维码：把「带 token 的登录链接」编码成二维码，手机扫码即可直接登录。
 * 二维码始终用白底深色模块渲染（不跟随主题），保证各扫码器的识别率。
 */
export default function LanQR({ port, token, addresses }: Props) {
  const [idx, setIdx] = useState(0)
  const [copied, setCopied] = useState(false)

  const current = addresses[Math.min(idx, Math.max(addresses.length - 1, 0))]
  const url = useMemo(() => {
    if (!current || !port) return null
    return `http://${current.address}:${port}/login?token=${token ?? ""}`
  }, [current, port, token])

  const copy = async () => {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      /* 剪贴板不可用时忽略（非 https 环境可能被拒） */
    }
  }

  if (addresses.length === 0) {
    return (
      <div className="mt-3.5 rounded-lg border border-line bg-surface2 px-3.5 py-2.5 text-xs leading-relaxed text-t4">
        未检测到局域网地址（可能当前无网络连接）。确认已连上 Wi-Fi / 网线后刷新本页。
      </div>
    )
  }

  return (
    <div className="mt-3.5 rounded-xl border border-line bg-surface2 p-3.5">
      <div className="flex items-start gap-4">
        {/* 二维码 */}
        <div className="shrink-0 rounded-lg bg-white p-2 shadow-xs">
          {url ? (
            <QRCodeSVG value={url} size={124} level="M" marginSize={0} bgColor="#ffffff" fgColor="#1f1e1b" />
          ) : (
            <div className="flex h-[124px] w-[124px] items-center justify-center text-xs text-t4">生成中…</div>
          )}
        </div>

        {/* 说明 + 地址 */}
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-t2">手机扫码登录</div>
          <div className="mt-0.5 text-xs leading-relaxed text-t4">
            手机连同一个 Wi-Fi，扫码即可带着 token 打开，免手动输入。
          </div>

          {url && (
            <div className="mt-2.5 flex items-center gap-1.5">
              <code className="min-w-0 flex-1 truncate rounded-md bg-surface3 px-2 py-1 font-mono text-xs text-t2" title={url}>
                {url}
              </code>
              <button onClick={copy} className="btn-ghost shrink-0 px-2.5 py-1 text-xs">
                {copied ? "已复制" : "复制"}
              </button>
            </div>
          )}

          {/* 多网卡时切换地址 */}
          {addresses.length > 1 && (
            <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-t4">网卡：</span>
              {addresses.map((a, i) => (
                <button
                  key={a.address}
                  onClick={() => setIdx(i)}
                  title={a.name}
                  className={`rounded-full px-2.5 py-0.5 font-mono text-xs transition-colors ${
                    i === Math.min(idx, addresses.length - 1)
                      ? "bg-accent text-white"
                      : "border border-line2 text-t3 hover:border-accent hover:text-t1"
                  }`}
                >
                  {a.address}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
