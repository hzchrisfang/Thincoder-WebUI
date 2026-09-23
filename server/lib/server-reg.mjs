/**
 * lib/server-reg.mjs — http server 注册表（供路由层做 host 热切换）
 * 单独成模块避免 routes ↔ index 循环引用。
 */

let reg = null

export function setServerReg(server, info) {
  reg = { server, ...info }
}

export function getServerReg() {
  return reg
}
