import type { PreviewScreen } from './types'
import type { AppBlueprint } from '@/lib/schemas/blueprint'
import { generateDummyCases } from './dummyData'

/**
 * Ensures a PreviewScreen has case data when needed.
 * Follow-up form screens without caseData get auto-generated dummy data.
 * Screens that already have caseData (e.g. from CaseList selection) are preserved.
 */
export function resolveScreen(screen: PreviewScreen, blueprint: AppBlueprint): PreviewScreen {
  if (screen.type !== 'form') return screen
  if (screen.caseData) return screen

  const mod = blueprint.modules[screen.moduleIndex]
  const form = mod?.forms[screen.formIndex]
  if (!form || form.type !== 'followup' || !mod?.case_type) return screen

  const caseType = blueprint.case_types?.find(ct => ct.name === mod.case_type)
  if (!caseType) return screen

  const rows = generateDummyCases(caseType, 1)
  if (!rows[0]) return screen

  return { ...screen, caseData: rows[0].properties }
}
