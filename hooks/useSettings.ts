'use client'
import { useState, useEffect, useCallback } from 'react'
import { DEFAULT_PIPELINE_CONFIG } from '@/lib/models'
import type { NovaSettings, PipelineConfig, PipelineStageConfig } from '@/lib/types/settings'

const STORAGE_KEY = 'nova-settings'
const LEGACY_KEY = 'nova-api-key'

function defaultSettings(): NovaSettings {
  return { apiKey: '', pipeline: { ...DEFAULT_PIPELINE_CONFIG } }
}

function loadSettings(): NovaSettings {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<NovaSettings>
      return {
        apiKey: parsed.apiKey ?? '',
        pipeline: { ...DEFAULT_PIPELINE_CONFIG, ...parsed.pipeline },
      }
    } catch { /* fall through */ }
  }

  // Migrate from legacy key
  const legacyKey = localStorage.getItem(LEGACY_KEY)
  if (legacyKey) {
    const settings: NovaSettings = { apiKey: legacyKey, pipeline: { ...DEFAULT_PIPELINE_CONFIG } }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    localStorage.removeItem(LEGACY_KEY)
    return settings
  }

  return defaultSettings()
}

function persistSettings(settings: NovaSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  // Keep legacy key in sync so other code that reads it directly still works during migration
  if (settings.apiKey) {
    localStorage.setItem(LEGACY_KEY, settings.apiKey)
  } else {
    localStorage.removeItem(LEGACY_KEY)
  }
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
