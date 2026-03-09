'use client'
import { use } from 'react'
import { BuilderLayout } from '@/components/builder/BuilderLayout'

export default function BuilderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  return <BuilderLayout buildId={id} />
}
