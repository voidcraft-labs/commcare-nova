/**
 * Static configuration for reference types — icons, colors, and the shared
 * regex pattern used to identify hashtag references in text.
 *
 * Color mapping:
 *   form  = violet  (primary building block)
 *   case  = cyan    (persistent external data)
 *   user  = emerald (stable system properties)
 */

import ciFileDocument from '@iconify-icons/ci/file-document'
import tablerDatabase from '@iconify-icons/tabler/database'
import ciUser02 from '@iconify-icons/ci/user-02'
import { qpathId } from '@/lib/services/questionPath'
import type { Reference, ReferenceType, ReferenceTypeConfig } from './types'

/**
 * Extract the display ID for a reference chip. Form refs use qpathId to get
 * the leaf question ID from a potentially nested path. Case and user refs
 * are already bare identifiers — returned as-is.
 */
export function displayId(ref: Reference): string {
  return ref.type === 'form' ? qpathId(ref.path) : ref.path
}

/**
 * Regex matching canonical hashtag references: #form/path, #case/path, #user/path.
 * Paths may contain word characters, dots, and forward slashes (for nested groups).
 * Exported WITHOUT the `g` flag to avoid shared mutable `lastIndex` state —
 * consumers create a global instance via `new RegExp(HASHTAG_REF_PATTERN, 'g')`.
 */
export const HASHTAG_REF_PATTERN = /#(form|user|case)\/[\w./]+/

/** The three hashtag namespaces — single source of truth for iteration and validation. */
export const REFERENCE_TYPES: readonly ReferenceType[] = ['form', 'case', 'user'] as const

/**
 * Shared chip dimension constants. Used by chipDom.ts (CodeMirror inline CSS)
 * and ReferenceChip.tsx (Tailwind) to keep both rendering paths in sync.
 */
export const CHIP = {
  height: 18,
  fontSize: 11,
  iconSize: 11,
  borderRadius: 4,
  paddingX: 5,
  gap: 3,
  maxLabelWidth: 140,
} as const

export const REF_TYPE_CONFIG: Record<ReferenceType, ReferenceTypeConfig> = {
  form: {
    type: 'form',
    icon: ciFileDocument,
    bgClass: 'bg-nova-violet/15',
    textClass: 'text-nova-violet-bright',
    borderClass: 'border-nova-violet/20',
    cssColor: '#a78bfa',
    cssBg: 'rgba(139, 92, 246, 0.15)',
    cssBorder: 'rgba(139, 92, 246, 0.2)',
  },
  case: {
    type: 'case',
    icon: tablerDatabase,
    bgClass: 'bg-nova-cyan/15',
    textClass: 'text-nova-cyan-bright',
    borderClass: 'border-nova-cyan/20',
    cssColor: '#22d3ee',
    cssBg: 'rgba(6, 182, 212, 0.15)',
    cssBorder: 'rgba(6, 182, 212, 0.2)',
  },
  user: {
    type: 'user',
    icon: ciUser02,
    bgClass: 'bg-nova-emerald/15',
    textClass: 'text-emerald-400',
    borderClass: 'border-nova-emerald/20',
    cssColor: '#34d399',
    cssBg: 'rgba(16, 185, 129, 0.15)',
    cssBorder: 'rgba(16, 185, 129, 0.2)',
  },
}
