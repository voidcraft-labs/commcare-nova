'use client'
import { useSyncExternalStore } from 'react'
import { Builder } from '@/lib/services/builder'

const builder = new Builder()

export function useBuilder() {
  useSyncExternalStore(builder.subscribe, builder.getSnapshot)
  return builder
}
