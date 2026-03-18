'use client'
import { useRouter } from 'next/navigation'
import { Logo } from '@/components/ui/Logo'
import { Button } from '@/components/ui/Button'

export default function BuildError({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter()

  return (
    <div className="min-h-screen bg-nova-void flex flex-col items-center justify-center gap-6 px-6">
      <Logo size="sm" />
      <div className="text-center space-y-2 max-w-md">
        <h1 className="text-lg font-display font-semibold text-nova-text">Builder crashed</h1>
        <p className="text-sm text-nova-text-secondary">{error.message || 'An unexpected error occurred in the builder.'}</p>
      </div>
      <div className="flex gap-3">
        <Button variant="ghost" onClick={() => reset()}>Try Again</Button>
        <Button onClick={() => router.push('/build/new')}>Start New Build</Button>
      </div>
    </div>
  )
}
