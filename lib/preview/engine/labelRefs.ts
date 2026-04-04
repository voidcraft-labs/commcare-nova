/**
 * Parses and resolves dynamic hashtag references in label/hint display text.
 *
 * Labels use bare hashtag refs (#form/x, #case/x, #user/x) as the canonical
 * internal format.
 *
 * `resolveLabel()` is the unified entry point for the form engine — evaluates
 * bare hashtag refs and returns the resolved text.
 */
import { HASHTAG_REF_PATTERN } from '@/lib/references/config'

/**
 * Extract bare hashtag references (#form/x, #case/x, #user/x) from label text.
 * Used by the TriggerDag to register label dependencies.
 */
export function parseBareHashtags(text: string): string[] {
  if (!text) return []
  const refs: string[] = []
  const re = new RegExp(HASHTAG_REF_PATTERN, 'g')
  let match: RegExpExecArray | null = re.exec(text)
  while (match !== null) {
    refs.push(match[0])
    match = re.exec(text)
  }
  return refs
}

/**
 * Replace each bare hashtag reference in display text with the result of a
 * transform function. Used by the form engine to evaluate hashtags to their
 * runtime values, and by MutableBlueprint to rewrite hashtags during rename
 * propagation. The `g` flag is created fresh each call because `lastIndex`
 * is stateful — sharing a module-level regex would be a correctness bug.
 */
export function transformBareHashtags(
  text: string,
  fn: (hashtag: string) => string,
): string {
  if (!text) return text
  return text.replace(new RegExp(HASHTAG_REF_PATTERN, 'g'), match => fn(match))
}

/**
 * Resolve all dynamic hashtag references in label/hint text. Single entry
 * point for the form engine's 'output' expression handler. Returns undefined
 * if the text contains no resolvable references (so callers can distinguish
 * "no refs" from "refs resolved to empty").
 */
export function resolveLabel(
  text: string | undefined,
  evaluator: (expr: string) => string,
): string | undefined {
  if (!text) return undefined
  const resolved = transformBareHashtags(text, evaluator)
  /* Return undefined when nothing was resolved — matches the engine's convention
     where resolvedLabel is only set when the label contains dynamic refs. */
  return resolved !== text ? resolved : undefined
}
