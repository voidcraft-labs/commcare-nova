'use client'
import { useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Icon } from '@iconify/react'
import ciFileUpload from '@iconify-icons/ci/file-upload'
import ciFileDocument from '@iconify-icons/ci/file-document'
import { Button } from '@/components/ui/Button'
import { extractReplayStages, setReplayData } from '@/lib/services/logReplay'
import type { RunLog } from '@/lib/services/runLogger'

interface ParsedLog {
  log: RunLog
  fileName: string
}

/**
 * Log replay section for the settings page.
 * Provides a drop zone for .json run log files, parses them, shows metadata,
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

    if (!file.name.endsWith('.json')) {
      setReplayError('Please select a .json file.')
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      try {
        const log = JSON.parse(reader.result as string) as RunLog
        if (log.version !== 3 || !Array.isArray(log.turns)) {
          setReplayError('This file does not appear to be a valid v3 run log.')
          return
        }
        setParsed({ log, fileName: file.name })
      } catch {
        setReplayError('Failed to parse JSON file.')
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
    const result = extractReplayStages(parsed.log)
    if (!result.success) {
      setReplayError(result.error)
      return
    }
    setReplayData(result.stages, result.doneIndex, result.appName)
    router.push('/build/new')
  }, [parsed, router])

  const formatCost = (cost: number) => `$${cost.toFixed(4)}`
  const formatDate = (iso: string) => new Date(iso).toLocaleString()

  return (
    <section className="rounded-xl border border-nova-border bg-nova-deep p-6">
      <h2 className="text-sm font-display font-semibold tracking-wide uppercase text-nova-text-secondary mb-1">Log Replay</h2>
      <p className="text-xs text-nova-text-muted mb-4">
        Load a run log to replay generation stages without API calls.
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
          accept=".json"
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
            <span className="text-xs text-nova-text-muted">.json files from .log/ directory</span>
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
                <p className="font-medium truncate">{parsed.log.app_name ?? parsed.fileName}</p>
                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-nova-text-secondary">
                  <span>Date: {formatDate(parsed.log.started_at)}</span>
                  <span>Turns: {parsed.log.turns.length}</span>
                  <span>Cost: {formatCost(parsed.log.totals.cost_estimate)}</span>
                  <span>{parsed.log.finished_at ? 'Completed' : 'Abandoned'}</span>
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
