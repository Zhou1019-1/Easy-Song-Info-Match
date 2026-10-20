/** 轻量 toast（无第三方依赖）。 */
import { reactive } from 'vue'

export type ToastType = 'info' | 'success' | 'warn' | 'error'

export interface ToastItem {
  id: number
  type: ToastType
  text: string
}

const items = reactive<ToastItem[]>([])
let seq = 0

export const toasts = items

export function dismissToast(id: number): void {
  const i = items.findIndex((t) => t.id === id)
  if (i >= 0) items.splice(i, 1)
}

export function pushToast(text: string, type: ToastType = 'info', ttl = 4200): void {
  const id = ++seq
  items.push({ id, type, text })
  if (ttl > 0) window.setTimeout(() => dismissToast(id), ttl)
}

export const toast = {
  info: (text: string) => pushToast(text, 'info'),
  success: (text: string) => pushToast(text, 'success'),
  warn: (text: string) => pushToast(text, 'warn'),
  error: (text: string) => pushToast(text, 'error', 7000)
}
