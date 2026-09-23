/**
 * lib/sound.ts — 提示音（Web Audio 现场合成，零音频资源、零依赖）
 *
 * 浏览器自动播放策略：AudioContext 只有在用户手势的「同步」调用栈里创建/恢复
 * 才会进入 running，否则恒 suspended 且静默失败（不报错）。因此：
 * - 首次 pointerdown / keydown 时同步创建并解锁（App 挂载即监听）
 * - 未解锁前 playSound() 静默跳过——提示只走视觉，不报错
 */

let ctx: AudioContext | null = null
let unlocked = false

/** 在用户手势的同步栈里调用（勿放在 await 之后）：创建 AudioContext 并解除挂起 */
export function unlockAudio() {
  if (unlocked) return
  unlocked = true
  try {
    ctx = new AudioContext()
    if (ctx.state === "suspended") void ctx.resume()
  } catch {
    ctx = null // 无 AudioContext 环境：静默降级为无音效
  }
}

/** 单音：sine + 快起音 / 指数衰减包络，轻音量 */
function tone(ac: AudioContext, freq: number, at: number, dur: number, peak: number) {
  const osc = ac.createOscillator()
  const gain = ac.createGain()
  osc.type = "sine"
  osc.frequency.value = freq
  gain.gain.setValueAtTime(0, at)
  gain.gain.linearRampToValueAtTime(peak, at + 0.008)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur)
  osc.connect(gain).connect(ac.destination)
  osc.start(at)
  osc.stop(at + dur + 0.02)
}

export type SoundKind = "alert" | "done"

/**
 * 播放提示音（各约 0.3 秒的双音）：
 * - alert（审批 / 提问弹窗）— 上行 E5→A5，语义「需要你处理」
 * - done（长任务完成）— 下行 A5→E5，语义「做完了」
 * 未解锁（本次页面加载尚无任何用户交互）时静默跳过。
 */
export function playSound(kind: SoundKind) {
  const ac = ctx
  if (!ac || ac.state !== "running") return
  const t = ac.currentTime + 0.01
  const [f1, f2] = kind === "alert" ? [659.25, 880] : [880, 659.25]
  tone(ac, f1, t, 0.14, 0.07)
  tone(ac, f2, t + 0.11, 0.18, 0.07)
}
