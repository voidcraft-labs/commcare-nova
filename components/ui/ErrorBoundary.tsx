'use client'
import React from 'react'
import { reportClientError } from '@/lib/clientErrorReporter'

interface ErrorBoundaryProps {
  fallback?: React.ReactNode
  children: React.ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error?: Error
}

/**
 * Catches render errors in children and displays a fallback instead of
 * crashing the whole tree. Reports the error to the server logging
 * endpoint so component-level crashes appear in GCP Cloud Logging.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error) {
    reportClientError({
      message: error.message || 'Component rendering error',
      stack: error.stack,
      source: 'error-boundary',
      url: typeof window !== 'undefined' ? window.location.href : '',
    })
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback
      return (
        <div className="flex items-center justify-center p-6 text-sm text-nova-text-muted">
          Something went wrong.
        </div>
      )
    }
    return this.props.children
  }
}
