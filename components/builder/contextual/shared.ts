import type { MutableBlueprint } from '@/lib/services/mutableBlueprint'

export const MEDIA_TYPES = new Set(['image', 'audio', 'video', 'signature'])

export const xpathFields = [
  { field: 'validation', label: 'Validation' },
  { field: 'relevant', label: 'Show When' },
  { field: 'default_value', label: 'Default Value' },
  { field: 'calculate', label: 'Calculate' },
] as const

export const addableTextFields = [
  { field: 'hint', label: 'Hint' },
  { field: 'help', label: 'Help' },
  { field: 'validation_msg', label: 'Validation Message' },
] as const

/** Returns case type names this module can write to: its own type + any child types. */
export function getModuleCaseTypes(mb: MutableBlueprint, moduleIndex: number): string[] {
  const mod = mb.getModule(moduleIndex)
  const bp = mb.getBlueprint()
  if (!mod?.case_type || !bp.case_types) return []
  const result = [mod.case_type]
  for (const ct of bp.case_types) {
    if (ct.parent_type === mod.case_type) result.push(ct.name)
  }
  return result
}
