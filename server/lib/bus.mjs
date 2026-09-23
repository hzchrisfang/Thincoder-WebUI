/**
 * bus.mjs — 进程内事件总线 + SSE 客户端管理（零依赖）
 * 所有事件都带 project 字段；前端按当前项目过滤。
 */

const clients = new Set()

/** 注册一个 SSE 连接，返回移除函数 */
export function addClient(res) {
  clients.add(res)
  return () => clients.delete(res)
}

/** 广播一条事件（自动补时间戳） */
export function emit(ev) {
  const payload = `data: ${JSON.stringify({ ...ev, ts: Date.now() })}\n\n`
  for (const res of clients) {
    try { res.write(payload) } catch { clients.delete(res) }
  }
}

export function clientCount() {
  return clients.size
}

/** 向单个新连接写 SSE 头 + 心跳 */
export function initSseStream(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  })
  res.write(`: connected\n\n`)
  const heartbeat = setInterval(() => {
    try { res.write(`: ping\n\n`) } catch { /* 断就断 */ }
  }, 25000)
  req.on("close", () => clearInterval(heartbeat))
}
