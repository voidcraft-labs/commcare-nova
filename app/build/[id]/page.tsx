'use client'
import { use } from 'react'
import { BuilderProvider } from '@/hooks/useBuilder'
import { BuilderLayout } from '@/components/builder/BuilderLayout'

/**
 * Build page — wraps BuilderLayout with BuilderProvider to scope the Builder
 * lifecycle to this route. When buildId changes (navigation between projects),
 * the provider creates a fresh Builder. When the page unmounts (navigation away
 * from /build/*), the Builder is garbage collected.
 */
export default function BuilderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return (
    <BuilderProvider buildId={id}>
      <BuilderLayout />
    </BuilderProvider>
  )
}
