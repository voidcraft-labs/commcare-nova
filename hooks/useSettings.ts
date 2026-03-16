'use client'
import { useState, useEffect, useCallback } from 'react'
import { DEFAULT_PIPELINE_CONFIG } from '@/lib/models'
import type { NovaSettings, PipelineConfig, PipelineStageConfig } from '@/lib/types/settings'

const STORAGE_KEY = 'nova-settings'

function defaultSettings(): NovaSettings {
  return { apiKey: '', pipeline: { ...DEFAULT_PIPELINE_CONFIG } }
}

/** Keys from old PipelineConfig that should be removed on load. */
const STALE_PIPELINE_KEYS = ['requirementsAnalyst', 'appContent', 'editArchitect', 'singleFormRegen']

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

function persistSettings(settings: NovaSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
}

export function useSettings() {
  const [settings, setSettings] = useState<NovaSettings>(defaultSettings)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    setSettings(loadSettings())
    setLoaded(true)
  }, [])

  const updateSettings = useCallback((updates: Partial<NovaSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...updates }
      persistSettings(next)
      return next
    })
  }, [])

  const updatePipelineStage = useCallback(
    (stage: keyof PipelineConfig, updates: Partial<PipelineStageConfig>) => {
      setSettings(prev => {
        const next = {
          ...prev,
          pipeline: {
            ...prev.pipeline,
            [stage]: { ...prev.pipeline[stage], ...updates },
          },
        }
        persistSettings(next)
        return next
      })
    },
    [],
  )

  const resetToDefaults = useCallback(() => {
    setSettings(prev => {
      const next = { ...prev, pipeline: { ...DEFAULT_PIPELINE_CONFIG } }
      persistSettings(next)
      return next
    })
  }, [])

  return { settings, loaded, updateSettings, updatePipelineStage, resetToDefaults }
}
