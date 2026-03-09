'use client'
import { useEffect, useState } from 'react'
import { Builder } from '@/lib/services/builder'

const builder = new Builder()

export function useBuilder() {
  const [, tick] = useState(0)

  useEffect(() => {
    return builder.subscribe(() => tick(n => n + 1))
  }, [])

  return builder
}
