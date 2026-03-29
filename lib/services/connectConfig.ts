/**
 * CommCare Connect configuration auto-derivation.
 *
 * Populates sensible defaults for Connect config based on form content.
 * Called after all questions are built (in validateAndFix) so it has
 * access to the full question tree.
 */
import type { BlueprintForm, ConnectConfig, Question } from '../schemas/blueprint'

/** Count questions recursively (excluding structural containers). */
function countQuestions(questions: Question[]): number {
  let count = 0
  for (const q of questions) {
    if (q.type !== 'group' && q.type !== 'repeat') count++
    if (q.children) count += countQuestions(q.children)
  }
  return count
}

/**
 * Find a hidden question likely to be an assessment score.
 * Looks for hidden questions with a calculate expression whose id
 * contains 'score' or 'assessment'.
 */
function findScoreQuestion(questions: Question[]): Question | undefined {
  for (const q of questions) {
    if (q.type === 'hidden' && q.calculate && /score|assessment/i.test(q.id)) {
      return q
    }
    if (q.children) {
      const found = findScoreQuestion(q.children)
      if (found) return found
    }
  }
  return undefined
}

/**
 * Auto-populate Connect config defaults from the form's content.
 *
 * @param connectType The app-level connect type ('learn' or 'deliver')
 * @param form The form to populate defaults for (must have `connect` present)
 *
 * Only fills in sub-configs that are missing — existing values are
 * never overwritten. This allows the SA or UI to set explicit values
 * that survive re-derivation.
 */
/**
 * Strip empty Connect sub-configs so absent data stays absent.
 *
 * Sub-configs that exist but contain only empty/default-sentinel values
 * are removed — preventing the XForm builder from emitting empty blocks.
 * Called from MutableBlueprint.updateForm() on every connect mutation.
 */
export function normalizeConnectConfig(config: ConnectConfig): ConnectConfig | undefined {
  const out = { ...config }

  if (out.task && !out.task.name.trim() && !out.task.description.trim()) {
    delete out.task
  }

  // Config with no sub-configs at all → remove entirely
  if (!out.learn_module && !out.assessment && !out.deliver_unit && !out.task) {
    return undefined
  }

  return out
}

export function deriveConnectDefaults(connectType: 'learn' | 'deliver', form: BlueprintForm): void {
  if (!form.connect) return

  if (connectType === 'learn') {
    form.connect.learn_module ??= {
      name: form.name,
      description: form.name,
      time_estimate: Math.max(1, Math.ceil(countQuestions(form.questions || []) / 3)),
    }
    // Auto-detect assessment score: prefer a hidden calculated question with
    // 'score' or 'assessment' in its id, otherwise default to 100 (automatic pass)
    if (!form.connect.assessment) {
      const scoreQ = findScoreQuestion(form.questions || [])
      form.connect.assessment = { user_score: scoreQ?.calculate ?? '100' }
    }
  }

  if (connectType === 'deliver') {
    const du = form.connect.deliver_unit ??= { name: '', entity_id: '', entity_name: '' }
    du.name ||= form.name
    du.entity_id ||= "concat(#user/username, '-', today())"
    du.entity_name ||= "#user/username"
  }
}
