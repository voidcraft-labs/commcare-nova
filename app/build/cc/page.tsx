'use client'
import { useState, useCallback } from 'react'
import { Icon } from '@iconify/react'
import ciSettings from '@iconify-icons/ci/settings'
import Link from 'next/link'
import { Logo } from '@/components/ui/Logo'
import { ClaudeCodeChat } from '@/components/claude-code/ClaudeCodeChat'
import { useBuilder } from '@/hooks/useBuilder'
import { BuilderLayout } from '@/components/builder/BuilderLayout'
import type { AppBlueprint } from '@/lib/schemas/blueprint'

export default function ClaudeCodeBuildPage() {
  const builder = useBuilder()
  const [blueprintLoaded, setBlueprintLoaded] = useState(false)

  const handleBlueprintReady = useCallback((blueprint: AppBlueprint, _messages: { role: string; content: string }[]) => {
    // Blueprint has already been validated in ClaudeCodeChat — load directly
    builder.setDone({
      blueprint,
      hqJson: {},
      success: true,
    })
    setBlueprintLoaded(true)
  }, [builder])

  if (blueprintLoaded) {
    return <BuilderLayout buildId="cc" claudeCodeMode />
  }

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
      </div>
    </div>
  )
}
