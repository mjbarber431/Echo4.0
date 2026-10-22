import type { EchoApi } from '@shared/types'

declare global {
  interface Window {
    echo: EchoApi
  }
}

export const api = (): EchoApi => window.echo

export const uid = (): string => crypto.randomUUID()
export const nowISO = (): string => new Date().toISOString()

export function relativeDay(iso: string, today: string): string {
  const a = new Date(`${iso.slice(0, 10)}T12:00:00`).getTime()
  const b = new Date(`${today}T12:00:00`).getTime()
  const days = Math.round((b - a) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days > 1 && days < 7) return `${days} days ago`
  if (days === -1) return 'Tomorrow'
  return new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: days > 300 ? 'numeric' : undefined })
}

export function longDate(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

/** Stable soft hue per client so avatars are recognizable at a glance. */
export function hueFor(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360
  return h
}

export function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  // Strip Electron's IPC wrapper prefix.
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
