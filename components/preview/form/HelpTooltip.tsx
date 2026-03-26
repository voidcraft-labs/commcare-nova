'use client'
import { useState } from 'react'
import {
  useFloating,
  autoUpdate,
  offset,
  flip,
  shift,
  useHover,
  useFocus,
  useDismiss,
  useRole,
  useInteractions,
  FloatingPortal,
} from '@floating-ui/react'
import { Icon } from '@iconify/react'
import ciHelpCircle from '@iconify-icons/ci/help-circle'
import { renderPreviewMarkdown } from '@/lib/markdown'

export function HelpTooltip({ help, isEditMode }: { help: string; isEditMode: boolean }) {
  if (isEditMode) {
    return (
      <span className="inline-flex opacity-30 cursor-default pointer-events-none">
        <Icon icon={ciHelpCircle} width="14" height="14" />
      </span>
    )
  }

  return <InteractiveHelpTooltip help={help} />
}

function InteractiveHelpTooltip({ help }: { help: string }) {
  const [isOpen, setIsOpen] = useState(false)

  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'top',
    middleware: [offset(6), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  })

  const hover = useHover(context, { move: false, delay: { open: 300 } })
  const focus = useFocus(context)
  const dismiss = useDismiss(context)
  const role = useRole(context, { role: 'tooltip' })

  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss, role])

  return (
    <>
      <span
        ref={refs.setReference}
        {...getReferenceProps()}
        className="inline-flex text-nova-violet hover:text-nova-text cursor-help transition-colors"
        tabIndex={0}
      >
        <Icon icon={ciHelpCircle} width="14" height="14" />
      </span>
      <FloatingPortal>
        {isOpen && (
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            className="z-popover max-w-60 rounded-lg border border-nova-border bg-nova-elevated px-3 py-2 shadow-lg"
          >
            <div
              className="preview-markdown text-xs text-nova-text"
              dangerouslySetInnerHTML={{ __html: renderPreviewMarkdown(help) }}
            />
          </div>
        )}
      </FloatingPortal>
    </>
  )
}
