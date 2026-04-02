'use client'
import { useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Icon } from '@iconify/react/offline'
import ciFileUpload from '@iconify-icons/ci/file-upload'
import ciFileDocument from '@iconify-icons/ci/file-document'
import { Button } from '@/components/ui/Button'
import { extractReplayStages, setReplayData } from '@/lib/services/logReplay'
import type { StoredEvent } from '@/lib/db/types'
import { parseJsonlEvents } from '@/lib/db/jsonl'

interface ParsedLog {
  events: StoredEvent[]
  fileName: string
  /** Derived summary for display. */
  summary: { stepCount: number; totalCost: number; startedAt: string }
}

/** Derive display summary from a stream of events. */
function summarizeEvents(events: StoredEvent[]): ParsedLog['summary'] {
  let stepCount = 0
  let totalCost = 0
  const startedAt = events[0]?.timestamp ?? ''
  for (const { event } of events) {
    if (event.type === 'step') {
      stepCount++
      totalCost += event.usage.cost
      for (const tc of event.tool_calls) {
        if (tc.generation) totalCost += tc.generation.cost
      }
    }
  }
  return { stepCount, totalCost, startedAt }
}

/**
 * Log replay section for the settings page.
 * Provides a drop zone for .jsonl run log files, parses them, shows metadata,
 * and allows loading them into the builder for replay without API calls.
 */
export function LogReplaySection() {
  const router = useRouter()

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [parsed, setParsed] = useState<ParsedLog>()
  const [replayError, setReplayError] = useState<string>()
  const [dragging, setDragging] = useState(false)

  const handleFile = useCallback((file: File) => {
    setReplayError(undefined)
    setParsed(undefined)

    if (!file.name.endsWith('.jsonl') && !file.name.endsWith('.json')) {
      setReplayError('Please select a .jsonl or .json file.')
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      try {
        const events = parseJsonlEvents(reader.result as string)
        if (!events.length || !events[0].event) {
          setReplayError('This file does not appear to be a valid event log.')
          return
        }
        setParsed({ events, fileName: file.name, summary: summarizeEvents(events) })
      } catch {
        setReplayError('Failed to parse log file.')
      }
    }
    reader.readAsText(file)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }, [handleFile])

  const handleLoadReplay = useCallback(() => {
    if (!parsed) return
    const result = extractReplayStages(parsed.events)
    if (!result.success) {
      setReplayError(result.error)
      return
    }
    setReplayData(result.stages, result.doneIndex)
    router.push('/build/new')
  }, [parsed, router])

  const formatCost = (cost: number) => `$${cost.toFixed(4)}`
  const formatDate = (iso: string) => new Date(iso).toLocaleString()

  return (
    <section className="rounded-xl border border-nova-border bg-nova-deep p-6">
      <h2 className="text-sm font-display font-semibold tracking-wide uppercase text-nova-text-secondary mb-1">Log Replay</h2>
      <p className="text-xs text-nova-text-muted mb-4">
        Load a .jsonl event log to replay generation stages without API calls.
      </p>

      {/* Unified drop zone / loaded state */}
      <div
        onDragOver={(e) => { e.preventDefault(); if (!parsed) setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { if (!parsed) handleDrop(e); else { e.preventDefault(); setDragging(false) } }}
        onClick={() => { if (!parsed && !replayError) fileInputRef.current?.click() }}
        className={`relative rounded-xl transition-colors ${
          parsed
            ? 'border border-nova-border bg-nova-surface'
            : replayError
              ? 'border-2 border-dashed border-nova-rose/30 bg-nova-rose/5'
              : dragging
                ? 'border-2 border-dashed border-nova-violet bg-nova-violet/5'
                : 'border-2 border-dashed border-nova-border bg-nova-surface/50 hover:border-nova-border-bright cursor-pointer'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".jsonl,.json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleFile(file)
            if (fileInputRef.current) fileInputRef.current.value = ''
          }}
        />

        {/* Empty state */}
        {!parsed && !replayError && (
          <div className="flex flex-col items-center justify-center gap-3 p-8">
            <Icon icon={ciFileUpload} width={32} height={32} className="text-nova-text-muted" />
            <span className="text-sm text-nova-text-secondary">
              Drop a log file or click to browse
            </span>
            <span className="text-xs text-nova-text-muted">.jsonl files from .log/ directory</span>
          </div>
        )}

        {/* Error state */}
        {replayError && (
          <div className="flex flex-col items-center justify-center gap-3 p-8">
            <p className="text-sm text-rose-400">{replayError}</p>
            <button
              type="button"
              onClick={() => { setReplayError(undefined); fileInputRef.current?.click() }}
              className="text-xs text-nova-text-muted hover:text-nova-text-secondary transition-colors cursor-pointer"
            >
              Try another file
            </button>
          </div>
        )}

        {/* Loaded state */}
        {parsed && !replayError && (
          <div className="p-4">
            <div className="flex items-start gap-3">
              <Icon icon={ciFileDocument} width={24} height={24} className="text-nova-violet-bright shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{parsed.fileName}</p>
                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-nova-text-secondary">
                  <span>Date: {formatDate(parsed.summary.startedAt)}</span>
                  <span>Steps: {parsed.summary.stepCount}</span>
                  <span>Cost: {formatCost(parsed.summary.totalCost)}</span>
                  <span>{parsed.events.length} events</span>
                </div>
              </div>
            </div>
            <div className="flex gap-2.5 mt-4">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setParsed(undefined) }}
                className="flex-1 px-3 py-2 text-sm text-nova-text-secondary hover:text-nova-text bg-nova-void border border-nova-border rounded-lg transition-colors cursor-pointer"
              >
                Clear
              </button>
              <Button
                onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleLoadReplay() }}
                className="flex-1"
                size="sm"
              >
                Load Replay
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
