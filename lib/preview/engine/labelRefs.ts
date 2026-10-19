/**
 * Resolves the typed references in canonical label/hint prose.
 *
 * `resolveLabel()` is the form engine's entry point: literal text stays as
 * written, and each reference part is evaluated by the caller, which prints
 * it at the Preview target as the XForm's `<output>` for it reads.
 */
import type { ProseReferencePart, ProseTemplate } from "@/lib/domain";
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
 * A template with no reference resolves to `undefined`: the renderer shows
 * its authored text.
 */
export function resolveLabel(
	template: ProseTemplate | undefined,
	evaluator: (part: ProseReferencePart) => string,
): string | undefined {
	if (!template?.parts.some((part) => part.kind !== "text")) return undefined;
	let resolved = "";
	for (const part of template.parts)
		resolved += part.kind === "text" ? part.text : evaluator(part);
	return resolved;
}

/** Async counterpart used by the browser XPath boundary. Text remains literal
 * while each typed reference is evaluated in document order. */
export async function resolveLabelAsync(
	template: ProseTemplate | undefined,
	evaluator: (part: ProseReferencePart) => Promise<string>,
): Promise<string | undefined> {
	if (!template?.parts.some((part) => part.kind !== "text")) {
		return undefined;
	}
	let resolved = "";
	for (const part of template.parts) {
		resolved += part.kind === "text" ? part.text : await evaluator(part);
	}
	return resolved;
}
