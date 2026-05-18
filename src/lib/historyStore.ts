const LEGACY_STORAGE_KEY = 'hage-rate-tracker-history'

/** 頭頂コンディション推移の保存キー（旧キーから自動マイグレーション） */
export const STORAGE_KEY = 'scalp-condition-tracker-history'

export interface HistoryEntry {
  id: string
  ts: number
  baldRate: number
}

function migrateFromLegacy(): void {
  try {
    if (localStorage.getItem(STORAGE_KEY)) return
    const oldJson = localStorage.getItem(LEGACY_STORAGE_KEY)
    if (!oldJson) return
    localStorage.setItem(STORAGE_KEY, oldJson)
    localStorage.removeItem(LEGACY_STORAGE_KEY)
  } catch {
    /* ignore quota / privacy mode */
  }
}

function readRaw(): HistoryEntry[] {
  migrateFromLegacy()
  try {
    const s = localStorage.getItem(STORAGE_KEY)
    if (!s) return []
    const p = JSON.parse(s) as unknown
    if (!Array.isArray(p)) return []
    return p.filter(
      (e): e is HistoryEntry =>
        !!e &&
        typeof e.id === 'string' &&
        typeof e.ts === 'number' &&
        typeof e.baldRate === 'number',
    )
  } catch {
    return []
  }
}

export function loadHistory(): HistoryEntry[] {
  return readRaw().sort((a, b) => b.ts - a.ts)
}

export function appendHistory(baldRate: number): HistoryEntry[] {
  migrateFromLegacy()
  const next: HistoryEntry = {
    id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    ts: Date.now(),
    baldRate,
  }
  const merged = [next, ...readRaw()].slice(0, 180)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
  return loadHistory()
}

export function clearHistory(): void {
  localStorage.removeItem(STORAGE_KEY)
  localStorage.removeItem(LEGACY_STORAGE_KEY)
}
