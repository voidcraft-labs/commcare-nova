// lib/domain/prose.ts
//
// Canonical storage for every reference-capable authored prose surface.
// Markdown remains ordinary text. References are explicit typed parts whose
// identity survives field moves/renames and custom-worker-property renames.
// Text that merely looks like `#form/question` is therefore still text.

import { z } from "zod";
import { BUILT_IN_USER_PROPERTIES } from "./users";
import { uuidSchema } from "./uuid";
import { type XPathPrintableDoc, xpathPrintContext } from "./xpath/print";

export const proseTextPartSchema = z
	.object({
		kind: z.literal("text"),
		text: z.string().min(1),
	})
	.strict();

export const proseFieldRefPartSchema = z
	.object({
		kind: z.literal("field-ref"),
		uuid: uuidSchema,
	})
	.strict();

export const proseCaseRefPartSchema = z
	.object({
		kind: z.literal("case-ref"),
		caseType: z.string().min(1),
		property: z.string().min(1),
	})
	.strict();

export const proseUserPropertyRefPartSchema = z
	.object({
		kind: z.literal("user-property-ref"),
		userPropertyUuid: uuidSchema,
	})
	.strict();

const externalWorkerPropertyNames = BUILT_IN_USER_PROPERTIES.map(
	(property) => property.slug,
) as [string, ...string[]];

/**
 * External CommCare session properties have no Nova-owned identity. Their
 * stable external name is the reference, and the closed runtime catalog keeps
 * a custom property from being smuggled through this arm.
 */
export const proseExternalUserRefPartSchema = z
	.object({
		kind: z.literal("user-ref"),
		property: z.enum(externalWorkerPropertyNames),
	})
	.strict();

export const prosePartSchema = z.discriminatedUnion("kind", [
	proseTextPartSchema,
	proseFieldRefPartSchema,
	proseCaseRefPartSchema,
	proseUserPropertyRefPartSchema,
	proseExternalUserRefPartSchema,
]);
export type ProsePart = z.infer<typeof prosePartSchema>;
export type ProseReferencePart = Exclude<ProsePart, { kind: "text" }>;

export const proseTemplateSchema = z
	.object({
		parts: z.array(prosePartSchema),
	})
	.strict()
	.superRefine((template, ctx) => {
		for (let index = 1; index < template.parts.length; index++) {
			if (
				template.parts[index - 1]?.kind === "text" &&
				template.parts[index]?.kind === "text"
			) {
				ctx.addIssue({
					code: "custom",
					path: ["parts", index],
					message:
						"Adjacent prose text parts are not canonical; merge them into one part.",
				});
			}
		}
	});
export type ProseTemplate = z.infer<typeof proseTemplateSchema>;

/** Construct literal authored prose. Hashtag-looking text stays literal. */
export function proseText(text: string): ProseTemplate {
	return text.length === 0
		? { parts: [] }
		: { parts: [{ kind: "text", text }] };
}

/** Drop empty runs and merge adjacent text into the one canonical shape. */
export function canonicalProseTemplate(
	parts: readonly ProsePart[],
	options?: { trim?: boolean },
): ProseTemplate {
	const normalized: ProsePart[] = [];
	for (const part of parts) {
		if (part.kind === "text") {
			if (part.text.length === 0) continue;
			const previous = normalized.at(-1);
			if (previous?.kind === "text") previous.text += part.text;
			else normalized.push({ ...part });
		} else {
			normalized.push({ ...part });
		}
	}
	if (options?.trim) {
		const first = normalized[0];
		if (first?.kind === "text") first.text = first.text.trimStart();
		const last = normalized.at(-1);
		if (last?.kind === "text") last.text = last.text.trimEnd();
	}
	return {
		parts: normalized.filter(
			(part) => part.kind !== "text" || part.text.length > 0,
		),
	};
}

export const EMPTY_PROSE_TEMPLATE: ProseTemplate = { parts: [] };

export function proseTemplateIsEmpty(
	template: ProseTemplate | undefined,
): boolean {
	return template === undefined || template.parts.length === 0;
}

/** Total identity fallback for UI/log surfaces that have no document context. */
export function fallbackProseProjection(template: ProseTemplate): string {
	let out = "";
	for (const part of template.parts) {
		switch (part.kind) {
			case "text":
				out += part.text;
				break;
			case "field-ref":
				out += `#form/${part.uuid}`;
				break;
			case "case-ref":
				out += `#${part.caseType}/${part.property}`;
				break;
			case "user-property-ref":
				out += `#user/${part.userPropertyUuid}`;
				break;
			case "user-ref":
				out += `#user/${part.property}`;
				break;
			default: {
				const _exhaustive: never = part;
				break;
			}
		}
	}
	return out;
}

export function isProseTemplate(value: unknown): value is ProseTemplate {
	return proseTemplateSchema.safeParse(value).success;
}

/** Stored reference parts in document order. */
export function proseReferenceParts(
	template: ProseTemplate,
): readonly ProseReferencePart[] {
	return template.parts.filter(
		(part): part is ProseReferencePart => part.kind !== "text",
	);
}

/**
 * Project a template to the canonical human/wire spelling. This is a read
 * projection only: no consumer may parse it back to recover identity.
 */
export function printProseTemplate(
	template: ProseTemplate,
	doc: XPathPrintableDoc,
): string {
	const ctx = xpathPrintContext(doc);
	let out = "";
	for (const part of template.parts) {
		switch (part.kind) {
			case "text":
				out += part.text;
				break;
			case "field-ref":
				out += `#form/${(ctx.fieldPathSegments(part.uuid) ?? [part.uuid]).join(
					"/",
				)}`;
				break;
			case "case-ref":
				out += `#${part.caseType}/${part.property}`;
				break;
			case "user-property-ref":
				out += `#user/${
					ctx.userPropertySlug(part.userPropertyUuid) ?? part.userPropertyUuid
				}`;
				break;
			case "user-ref":
				out += `#user/${part.property}`;
				break;
			default: {
				const _exhaustive: never = part;
				break;
			}
		}
	}
	return out;
}

/**
 * Runtime projection that evaluates reference parts while leaving Markdown
 * text untouched. The callback receives the current canonical hashtag/XPath
 * projection for the typed part.
 */
export function resolveProseTemplate(
	template: ProseTemplate,
	doc: XPathPrintableDoc,
	evaluate: (expression: string) => string,
): string | undefined {
	if (!template.parts.some((part) => part.kind !== "text")) return undefined;
	const ctx = xpathPrintContext(doc);
	let out = "";
	for (const part of template.parts) {
		switch (part.kind) {
			case "text":
				out += part.text;
				break;
			case "field-ref":
				out += evaluate(
					`#form/${(ctx.fieldPathSegments(part.uuid) ?? [part.uuid]).join(
						"/",
					)}`,
				);
				break;
			case "case-ref":
				out += evaluate(`#${part.caseType}/${part.property}`);
				break;
			case "user-property-ref":
				out += evaluate(
					`#user/${
						ctx.userPropertySlug(part.userPropertyUuid) ?? part.userPropertyUuid
					}`,
				);
				break;
			case "user-ref":
				out += evaluate(`#user/${part.property}`);
				break;
			default: {
				const _exhaustive: never = part;
				break;
			}
		}
	}
	return out;
}

/** Rename the only prose reference family whose identity is name-based. */
export function renameCasePropertyInProse(
	template: ProseTemplate,
	caseType: string,
	oldName: string,
	newName: string,
): number {
	let changed = 0;
	for (const part of template.parts) {
		if (
			part.kind === "case-ref" &&
			part.caseType === caseType &&
			part.property === oldName
		) {
			part.property = newName;
			changed++;
		}
	}
	return changed;
}
