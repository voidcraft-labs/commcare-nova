'use client'
import { useState, useEffect } from 'react'

export function useApiKey() {
  const [apiKey, setApiKey] = useState<string>('')
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const stored = localStorage.getItem('nova-api-key')
    if (stored) setApiKey(stored)
    setLoaded(true)
  }, [])

  const saveApiKey = (key: string) => {
    setApiKey(key)
    localStorage.setItem('nova-api-key', key)
  }

  const clearApiKey = () => {
    setApiKey('')
    localStorage.removeItem('nova-api-key')
  }

  return { apiKey, loaded, saveApiKey, clearApiKey }
}
