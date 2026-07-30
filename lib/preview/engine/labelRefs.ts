/**
 * Projects and resolves the typed references in canonical label/hint prose.
 *
 * `resolveLabel()` is the unified entry point for the form engine — evaluates
 * bare hashtag refs and returns the resolved text.
 */
import {
	type ProseTemplate,
	printProseTemplate,
	projectProseTemplate,
	resolveProseTemplate,
	type XPathPrintableDoc,
} from "@/lib/domain";

/**
 * Project typed prose atoms to friendly reference expressions. Used by the
 * TriggerDag to register label dependencies.
 */
export function proseReferenceExpressions(
	template: ProseTemplate | undefined,
	doc: XPathPrintableDoc,
	mode: "strict" | "inspection" = "strict",
): string[] {
	if (!template) return [];
	return template.parts
		.filter((part) => part.kind !== "text")
		.map((part) =>
			mode === "strict"
				? printProseTemplate({ parts: [part] }, doc)
				: projectProseTemplate({ parts: [part] }, doc).text,
		);
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
