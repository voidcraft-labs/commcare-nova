/**
 * Vellum hashtag expansion — converts #case/ and #user/ shorthand to full XPath.
 *
 * CommCare's Vellum editor uses hashtag shorthand (#case/prop, #user/prop) in
 * XPath expressions. The XForm runtime doesn't understand these — they must be
 * expanded to full instance() XPath. The shorthand is preserved in vellum:*
 * attributes for round-tripping back to the editor.
 */

/** Prefix expansion map — tells HQ how to expand #case/ and #user/ shorthand. */
export const VELLUM_HASHTAG_TRANSFORMS = {
  prefixes: {
    '#case/': "instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/case_id]/",
    '#user/': "instance('casedb')/casedb/case[@case_type = 'commcare-user'][hq_user_id = instance('commcaresession')/session/context/userid]/",
  },
} as const

/** Expand #case/ and #user/ hashtags to full XPath in an expression. */
export function expandHashtags(expr: string): string {
  return expr.replace(/#(case|user)\/([\w-]+)/g, (match, type) => {
    const prefix = VELLUM_HASHTAG_TRANSFORMS.prefixes[`#${type}/` as keyof typeof VELLUM_HASHTAG_TRANSFORMS.prefixes]
    return prefix ? match.replace(`#${type}/`, prefix) : match
  })
}

/** Returns true if the expression contains any #case/ or #user/ hashtags. */
export function hasHashtags(expr: string): boolean {
  return /#(?:case|user)\//.test(expr)
}

/** Extract all #case/... and #user/... hashtag references from XPath expressions. */
export function extractHashtags(exprs: string[]): string[] {
  const hashtags = new Set<string>()
  for (const expr of exprs) {
    const matches = expr.matchAll(/#(?:case|user)\/[\w-]+/g)
    for (const m of matches) {
      hashtags.add(m[0])
    }
  }
  return [...hashtags]
}
