'use client'
import { useState, useEffect, useCallback } from 'react'
import type { Build } from '@/lib/types'

export function useBuilds() {
  const [builds, setBuilds] = useState<Build[]>([])

  useEffect(() => {
    const stored = localStorage.getItem('nova-builds')
    if (stored) {
      try { setBuilds(JSON.parse(stored)) } catch { /* ignore */ }
    }
  }, [])

  const saveBuild = useCallback((build: Build) => {
    setBuilds(prev => {
      const updated = [build, ...prev.filter(b => b.id !== build.id)]
      localStorage.setItem('nova-builds', JSON.stringify(updated.slice(0, 50)))
      return updated
    })
  }, [])

  const removeBuild = useCallback((id: string) => {
    setBuilds(prev => {
      const updated = prev.filter(b => b.id !== id)
      localStorage.setItem('nova-builds', JSON.stringify(updated))
      return updated
    })
  }, [])

  return { builds, saveBuild, removeBuild }
}
