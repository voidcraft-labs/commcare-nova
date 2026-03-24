'use client'
import { useCallback } from 'react'
import { useSettings } from './useSettings'

export function useApiKey() {
  const { settings, updateSettings } = useSettings()

  const saveApiKey = useCallback((key: string) => {
    updateSettings({ apiKey: key })
  }, [updateSettings])

  const clearApiKey = useCallback(() => {
    updateSettings({ apiKey: '' })
  }, [updateSettings])

  return { apiKey: settings.apiKey, saveApiKey, clearApiKey }
}
