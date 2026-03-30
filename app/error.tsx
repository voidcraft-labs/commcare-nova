'use client'
import { Logo } from '@/components/ui/Logo'
import { Button } from '@/components/ui/Button'

/**
 * Global error boundary. Uses hard navigation (window.location)
 * instead of router.push because client-side navigation doesn't work reliably
 * inside an error boundary — React's tree is in an error state.
 */
export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="min-h-screen bg-nova-void flex flex-col items-center justify-center gap-6 px-6">
      <Logo size="sm" />
      <div className="text-center space-y-2 max-w-md">
        <h1 className="text-lg font-display font-semibold text-nova-text">Something went wrong</h1>
        <p className="text-sm text-nova-text-secondary">{error.message || 'An unexpected error occurred.'}</p>
      </div>
      <div className="flex gap-3">
        <Button variant="ghost" onClick={() => reset()}>Try Again</Button>
        <Button onClick={() => { window.location.href = '/' }}>Return to Home</Button>
      </div>
    </div>
  )
}
