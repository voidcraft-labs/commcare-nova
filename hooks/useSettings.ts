'use client'
import { useCallback, useSyncExternalStore } from 'react'

/** Client-side settings stored in localStorage. Currently just the BYOK API key. */
interface NovaSettings {
  apiKey: string
}

const STORAGE_KEY = 'nova-settings'

function defaultSettings(): NovaSettings {
  return { apiKey: '' }
}

function loadSettings(): NovaSettings {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return defaultSettings()
  const stored = JSON.parse(raw) as Partial<NovaSettings>
  return { ...defaultSettings(), ...stored }
}

// ── Module-level settings store ──────────────────────────────────────────
// useSyncExternalStore uses getServerSnapshot during both SSR and hydration,
// then switches to getSnapshot (localStorage) after hydration completes.
// Components should render consistently with both snapshots — no typeof window branching.

let currentSettings: NovaSettings = defaultSettings()
let initialized = false
const listeners = new Set<() => void>()

function getSnapshot(): NovaSettings {
  if (!initialized && typeof window !== 'undefined') {
    currentSettings = loadSettings()
    initialized = true
  }
  return currentSettings
}

const SERVER_SNAPSHOT = defaultSettings()

function getServerSnapshot(): NovaSettings {
  return SERVER_SNAPSHOT
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify() {
  listeners.forEach(fn => fn())
}

function persistAndNotify(settings: NovaSettings) {
  currentSettings = settings
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  notify()
}

export function useSettings() {
  const settings = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  const updateSettings = useCallback((updates: Partial<NovaSettings>) => {
    persistAndNotify({ ...currentSettings, ...updates })
  }, [])

  return { settings, updateSettings }
}
