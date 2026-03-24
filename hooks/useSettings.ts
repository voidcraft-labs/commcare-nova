'use client'
import { useCallback, useSyncExternalStore } from 'react'
import { DEFAULT_PIPELINE_CONFIG } from '@/lib/models'
import type { NovaSettings, PipelineConfig, PipelineStageConfig } from '@/lib/types/settings'

const STORAGE_KEY = 'nova-settings'

function defaultSettings(): NovaSettings {
  return { apiKey: '', pipeline: { ...DEFAULT_PIPELINE_CONFIG } }
}

/** Keys from old PipelineConfig that should be removed on load. */
const STALE_PIPELINE_KEYS = ['requirementsAnalyst', 'appContent', 'editArchitect', 'singleFormRegen', 'schemaGeneration', 'scaffold']

function loadSettings(): NovaSettings {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return defaultSettings()
  const stored = JSON.parse(raw) as Partial<NovaSettings>
  const defaults = defaultSettings()

  // Clean stale pipeline keys from stored settings
  if (stored.pipeline) {
    for (const key of STALE_PIPELINE_KEYS) {
      delete (stored.pipeline as any)[key]
    }
  }

  return {
    ...defaults,
    ...stored,
    pipeline: {
      ...defaults.pipeline,
      ...stored.pipeline,
    },
  }
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

  const updatePipelineStage = useCallback(
    (stage: keyof PipelineConfig, updates: Partial<PipelineStageConfig>) => {
      persistAndNotify({
        ...currentSettings,
        pipeline: {
          ...currentSettings.pipeline,
          [stage]: { ...currentSettings.pipeline[stage], ...updates },
        },
      })
    },
    [],
  )

  const resetToDefaults = useCallback(() => {
    persistAndNotify({ ...currentSettings, pipeline: { ...DEFAULT_PIPELINE_CONFIG } })
  }, [])

  return { settings, updateSettings, updatePipelineStage, resetToDefaults }
}
