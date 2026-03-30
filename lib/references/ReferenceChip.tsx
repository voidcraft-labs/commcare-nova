/**
 * React chip component for rendering a reference as a styled inline pill.
 *
 * Used by TipTap's React NodeView (CommcareRefView) and any React-based
 * display context. Visual dimensions are driven by the shared CHIP constants
 * in config.ts to stay in sync with chipDom.ts (CM6) and renderLabel.ts (HTML).
 * Colors come from the per-type ReferenceTypeConfig via Tailwind classes.
 */

import { Icon } from '@iconify/react'
import { CHIP, REF_TYPE_CONFIG, displayId } from './config'
import type { Reference } from './types'

interface ReferenceChipProps {
  reference: Reference
}

export function ReferenceChip({ reference }: ReferenceChipProps) {
  const config = REF_TYPE_CONFIG[reference.type]

  return (
    <span
      className={`inline-flex items-center font-mono font-medium leading-none border ${config.bgClass} ${config.textClass} ${config.borderClass} select-none align-baseline`}
      style={{ gap: CHIP.gap, paddingInline: CHIP.paddingX, height: CHIP.height, borderRadius: CHIP.borderRadius, fontSize: CHIP.fontSize }}
      data-ref-raw={reference.raw}
    >
      <Icon icon={reference.icon ?? config.icon} width={CHIP.iconSize} height={CHIP.iconSize} className="shrink-0" />
      <span className="whitespace-nowrap overflow-hidden text-ellipsis" style={{ maxWidth: CHIP.maxLabelWidth }}>
        {displayId(reference)}
      </span>
    </span>
  )
}
