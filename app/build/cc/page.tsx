'use client'
import { useState, useCallback } from 'react'
import { Icon } from '@iconify/react'
import ciSettings from '@iconify-icons/ci/settings'
import Link from 'next/link'
import { Logo } from '@/components/ui/Logo'
import { ClaudeCodeChat } from '@/components/claude-code/ClaudeCodeChat'
import { useBuilder } from '@/hooks/useBuilder'
import { BuilderLayout } from '@/components/builder/BuilderLayout'
import { validateBlueprint } from '@/lib/services/hqJsonExpander'
import type { AppBlueprint } from '@/lib/schemas/blueprint'

export default function ClaudeCodeBuildPage() {
  const builder = useBuilder()
  const [blueprintLoaded, setBlueprintLoaded] = useState(false)
  const [validationErrors, setValidationErrors] = useState<string[]>([])

  const handleBlueprintReady = useCallback((blueprint: AppBlueprint, _messages: { role: string; content: string }[]) => {
    // Validate the blueprint before loading
    const errors = validateBlueprint(blueprint)
    if (errors.length > 0) {
      setValidationErrors(errors)
    }

    // Load blueprint into builder
    builder.setDone({
      blueprint,
      hqJson: {},
      success: true,
    })

    setBlueprintLoaded(true)
  }, [builder])

  // Once blueprint is loaded, show the builder in Claude Code mode
  if (blueprintLoaded) {
    return <BuilderLayout buildId="cc" claudeCodeMode />
  }

  // Claude Code chat mode
  return (
    <div className="min-h-screen flex flex-col relative overflow-hidden bg-nova-void">
      <div className="flex items-center justify-between px-4 py-2">
        <Logo size="sm" />
        <Link
          href="/settings"
          className="p-1.5 text-nova-text-muted hover:text-nova-text transition-colors rounded-lg hover:bg-nova-surface"
          title="Settings"
        >
          <Icon icon={ciSettings} width="18" height="18" />
        </Link>
      </div>

      <div className="flex-1 flex flex-col">
        <ClaudeCodeChat onBlueprintReady={handleBlueprintReady} />

        {/* Validation warnings */}
        {validationErrors.length > 0 && (
          <div className="mx-4 mb-2 p-3 rounded-lg bg-nova-amber/10 border border-nova-amber/30">
            <p className="text-sm font-medium text-nova-amber mb-1">
              Blueprint has {validationErrors.length} validation warning{validationErrors.length !== 1 ? 's' : ''}:
            </p>
            <ul className="text-xs text-nova-text-muted space-y-0.5 list-disc pl-4">
              {validationErrors.slice(0, 5).map((e, i) => <li key={i}>{e}</li>)}
              {validationErrors.length > 5 && (
                <li>...and {validationErrors.length - 5} more</li>
              )}
            </ul>
          </div>
        )}
      </div>
    </div>
  )
}
