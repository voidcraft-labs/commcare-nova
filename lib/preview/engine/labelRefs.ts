/**
 * Projects and resolves the typed references in canonical label/hint prose.
 *
 * `resolveLabel()` is the unified entry point for the form engine — evaluates
 * bare hashtag refs and returns the resolved text.
 */
import {
	type ProseTemplate,
	printProseTemplate,
	type ReferenceNamesDoc,
	resolveProseTemplate,
} from "@/lib/domain";
import { isNodesetCardinalityFailure } from "../xpath/runtimeError";

/** Only ambiguous custom validation wording uses the standard warning.
 * Rule evaluation and every other prose surface remain outside this policy. */
export function resolveConstraintMessage(
	resolve: () => string | undefined,
): string | undefined {
	try {
		const message = resolve();
		return message === "" ? undefined : message;
	} catch (error) {
		if (isNodesetCardinalityFailure(error)) return undefined;
		throw error;
	}
}

export async function resolveConstraintMessageAsync(
	resolve: () => Promise<string | undefined>,
): Promise<string | undefined> {
	try {
		const message = await resolve();
		return message === "" ? undefined : message;
	} catch (error) {
		if (isNodesetCardinalityFailure(error)) return undefined;
		throw error;
	}
}

/**
 * Resolve each typed prose reference against the captured runtime context.
 * Literal text is preserved, including text that looks like a reference.
 */
export function resolveLabel(
	template: ProseTemplate | undefined,
	doc: ReferenceNamesDoc,
	evaluator: (expr: string) => string,
): string | undefined {
	if (!template) return undefined;
	return resolveProseTemplate(template, doc, evaluator);
}

/** Async counterpart used by the browser XPath boundary. Text remains literal
 * while each typed reference is projected and evaluated in document order. */
export async function resolveLabelAsync(
	template: ProseTemplate | undefined,
	doc: ReferenceNamesDoc,
	evaluator: (expr: string) => Promise<string>,
): Promise<string | undefined> {
	if (!template?.parts.some((part) => part.kind !== "text")) {
		return undefined;
	}
	let resolved = "";
	for (const part of template.parts) {
		resolved +=
			part.kind === "text"
				? part.text
				: await evaluator(printProseTemplate({ parts: [part] }, doc));
	}
	return resolved;
}
