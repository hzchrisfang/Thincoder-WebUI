// 应用图标生成器 —— 零依赖（node:zlib 手写 PNG 编码）
// 产出：web/public/ 下的 apple-touch-icon.png（180 满幅，系统套圆角）、icon-192.png / icon-512.png（25% 圆角透明角）、
// favicon.png（48 满幅）——Chrome 应用 shim 管线只认位图 favicon（SVG data-URI 栅格化不出，会落字母占位图标）
// 图形 = 程序内主 logo（web/src/components/TMark.tsx）：accent 底 + 白色 T 字。
// 改 logo 只改这里与 TMark.tsx 两处几何；本脚本可重复执行（幂等覆盖）。
import { deflateSync } from "node:zlib"
import { writeFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// ==== 品牌常量（与 web/src/index.css --accent 一致）====
const ACCENT = [201, 100, 66] // #c96442
const WHITE = [255, 255, 255]

// ==== TMark 几何（TMark.tsx 的 path，viewBox 0 0 16 16）====
const TMARK_VIEWBOX = 16
// M3.6 3.2 h8.8 v2.2 H9.1 V12.8 H6.9 V5.4 H3.6 z
const TMARK_POLYGON = [
  [3.6, 3.2],
  [12.4, 3.2],
  [12.4, 5.4],
  [9.1, 5.4],
  [9.1, 12.8],
  [6.9, 12.8],
  [6.9, 5.4],
  [3.6, 5.4],
]
// 容器圆角比例：favicon 用 rx=8/32=25%，与 NavRail 的 rounded-xl 观感一致
const CORNER_RATIO = 0.25
// 满幅模式（apple-touch-icon）：不透明、无自带圆角——Safari/iOS 落盘时由系统套遮罩
const FULL_BLEED = false

// ==== 栅格化：整图超采样（8×）后盒式下采样，边缘自然抗锯齿 ====
const SS = 8

function pointInPolygon(px, py, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function inRoundedRect(px, py, size, radius) {
  if (px < 0 || py < 0 || px >= size || py >= size) return false
  if (radius <= 0) return true
  const rx = Math.min(px, size - 1 - px)
  const ry = Math.min(py, size - 1 - py)
  if (rx >= radius || ry >= radius) return true
  const dx = radius - rx
  const dy = radius - ry
  return dx * dx + dy * dy <= radius * radius
}

/** 渲染一枚 size×size 的 RGBA 图标 */
function renderIcon(size, { fullBleed }) {
  const scale = size / TMARK_VIEWBOX
  const poly = TMARK_POLYGON.map(([x, y]) => [x * scale, y * scale])
  const radius = fullBleed ? 0 : size * CORNER_RATIO
  const hi = size * SS
  const mask = new Uint8Array(hi * hi) // 0 背景 / 1 accent 底 / 2 白 T
  const ss = SS
  for (let y = 0; y < hi; y++) {
    for (let x = 0; x < hi; x++) {
      // 像素中心采样
      const px = x + 0.5
      const py = y + 0.5
      if (!inRoundedRect(px / ss, py / ss, size, radius)) continue
      mask[y * hi + x] = pointInPolygon(px / ss, py / ss, poly) ? 2 : 1
    }
  }
  // 8×8 盒式下采样：按超采样占比混色
  const rgba = Buffer.alloc(size * size * 4)
  const total = ss * ss
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0,
        accent = 0,
        white = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const v = mask[(y * ss + sy) * hi + (x * ss + sx)]
          if (v === 0) bg++
          else if (v === 1) accent++
          else white++
        }
      }
      const o = (y * size + x) * 4
      if (bg === total) {
        // 纯透明角
        rgba[o + 3] = 0
        continue
      }
      // accent 与 white 按 alpha 覆盖合成（white 叠在 accent 上）
      const aAccent = accent / total
      const aWhite = white / total
      const mix = (base, over) => Math.round(base * (1 - aWhite) + over * aWhite)
      rgba[o] = mix(ACCENT[0], WHITE[0])
      rgba[o + 1] = mix(ACCENT[1], WHITE[1])
      rgba[o + 2] = mix(ACCENT[2], WHITE[2])
      rgba[o + 3] = Math.round((aAccent + aWhite) * 255)
    }
  }
  return rgba
}

// ==== PNG 编码（RGBA8，filter 0）====
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function pngChunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, "ascii")
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  // 每行前置 filter 字节 0
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

// ==== 产出 ====
const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "public")
mkdirSync(outDir, { recursive: true })

const targets = [
  { file: "apple-touch-icon.png", size: 180, fullBleed: true }, // Safari「添加到程序坞」取用，系统自动套圆角
  { file: "icon-192.png", size: 192, fullBleed: false }, // PWA manifest / Chrome 安装应用
  { file: "icon-512.png", size: 512, fullBleed: false },
  { file: "favicon.png", size: 48, fullBleed: true }, // 浏览器标签页 + Chrome 应用 shim（创建快捷方式时唯一可靠来源）
]

for (const t of targets) {
  const png = encodePng(renderIcon(t.size, { fullBleed: t.fullBleed }), t.size)
  writeFileSync(join(outDir, t.file), png)
  console.log(`${t.file}: ${t.size}x${t.size} fullBleed=${t.fullBleed} (${png.length} bytes)`)
}
