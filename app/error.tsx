'use client'
import { useEffect } from 'react'
import { Logo } from '@/components/ui/Logo'
import { Button } from '@/components/ui/Button'
import { reportClientError } from '@/lib/clientErrorReporter'

/**
 * Global error boundary. Uses hard navigation (window.location)
 * instead of router.push because client-side navigation doesn't work reliably
 * inside an error boundary — React's tree is in an error state.
 *
 * Reports the caught error to the server logging endpoint on mount so
 * React rendering crashes appear in GCP Cloud Logging alongside JS errors.
 */
export default function GlobalError({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    reportClientError({
      message: error.message || 'Unknown rendering error',
      stack: error.stack,
      source: 'error-boundary',
      url: window.location.href,
    })
  }, [error])

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
