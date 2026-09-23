import { useEffect, useState } from "react"
import { api } from "../lib/api"
import type { Preset } from "../lib/types"

/** 未配置模型时的快速配置面板（写入 ~/.thincoder/config.json） */
export default function SetupPanel({ onSaved }: { onSaved: () => void }) {
  const [presets, setPresets] = useState<Preset[]>([])
  const [name, setName] = useState("deepseek")
  const [baseURL, setBaseURL] = useState("")
  const [model, setModel] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [advanced, setAdvanced] = useState(false)

  useEffect(() => {
    api
      .presets()
      .then((r) => {
        setPresets(r.presets)
        const first = r.presets[0]
        if (first) {
          setName(first.name)
          setBaseURL(first.baseURL)
          setModel(first.model)
        }
      })
      .catch(() => setErr("无法加载预设列表"))
  }, [])

  const pick = (p: Preset) => {
    setName(p.name)
    setBaseURL(p.baseURL)
    setModel(p.model)
  }

  const save = async () => {
    setBusy(true)
    setErr(null)
    try {
      await api.saveProvider({ name, baseURL, apiKey, model })
      onSaved()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="shrink-0 border-t border-amber-900 bg-amber-950 px-4 py-3.5">
      <div className="mx-auto max-w-3xl">
        <div className="mb-2.5 flex items-center gap-2 text-sm font-medium text-amber-300">
          <span>⚠</span> 尚未配置模型 —— 选择一个提供商并填入 API key
        </div>
        <div className="mb-2.5 flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <button
              key={p.name}
              onClick={() => pick(p)}
              className={`rounded-full px-3 py-1 text-xs transition-colors ${
                name === p.name
                  ? "bg-accent text-white"
                  : "border border-line2 bg-surface text-t3 hover:border-accent hover:text-t1"
              }`}
            >
              {p.desc}
            </button>
          ))}
        </div>
        {advanced && (
          <div className="mb-2.5 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="名称"
              className="field px-3 py-1.5 text-xs" />
            <input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder="baseURL（OpenAI 兼容）"
              className="field px-3 py-1.5 text-xs sm:col-span-2" />
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="模型"
              className="field px-3 py-1.5 text-xs sm:col-span-3" />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={`${name} 的 API key`}
            className="field min-w-0 flex-1 px-3.5 py-2 text-sm"
          />
          <button onClick={() => setAdvanced((v) => !v)} className="btn-ghost px-3 py-2 text-xs">
            {advanced ? "收起" : "自定义端点"}
          </button>
          <button
            onClick={save}
            disabled={busy || !apiKey.trim() || !baseURL.trim() || !model.trim()}
            className="btn-primary px-4 py-2 text-sm"
          >
            {busy ? "保存中…" : "保存并启用"}
          </button>
        </div>
        {err && <div className="mt-2 text-xs text-red-300">{err}</div>}
      </div>
    </div>
  )
}
