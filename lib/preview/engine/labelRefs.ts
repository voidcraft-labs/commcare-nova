/**
 * Projects and resolves the typed references in canonical label/hint prose.
 *
 * `resolveLabel()` is the unified entry point for the form engine — evaluates
 * bare hashtag refs and returns the resolved text.
 */
import {
	type ProseTemplate,
	printProseTemplate,
	resolveProseTemplate,
	type XPathPrintableDoc,
} from "@/lib/domain";

/**
 * Extract bare hashtag references (#form/x, #case/x, #user/x) from label text.
 * Used by the TriggerDag to register label dependencies.
 */
export function proseReferenceExpressions(
	template: ProseTemplate | undefined,
	doc: XPathPrintableDoc,
): string[] {
	if (!template) return [];
	return template.parts
		.filter((part) => part.kind !== "text")
		.map((part) => printProseTemplate({ parts: [part] }, doc));
}

/**
 * Replace each bare hashtag reference in display text with the result of a
 * transform function. Used by the form engine to evaluate hashtags to their
 * runtime values, and by MutableBlueprint to rewrite hashtags during rename
 * propagation. The `g` flag is created fresh each call because `lastIndex`
 * is stateful — sharing a module-level regex would be a correctness bug.
 */
export function resolveLabel(
	template: ProseTemplate | undefined,
	doc: XPathPrintableDoc,
	evaluator: (expr: string) => string,
): string | undefined {
	if (!template) return undefined;
	return resolveProseTemplate(template, doc, evaluator);
}
