// lib/domain/prose.ts
//
// Canonical storage for every reference-capable authored prose surface.
// Markdown remains ordinary text. References are explicit typed parts whose
// identity survives field moves/renames and custom-worker-property renames.
// Text that merely looks like `#form/question` is therefore still text. A
// calculated value is a part holding a form-rule expression whose result is
// shown where the part stands.

import { z } from "zod";
import { authoredCasePropertyNameSchema } from "./casePropertyName";
import { type Expression, formLogicSchema } from "./expression/types";
import { externalUserPropertyNameSchema } from "./externalUserProperty";
import { caseReferenceText } from "./hashtagSegments";
import { proseReferenceOf } from "./proseExpression";
import { type ReferenceNamesDoc, referenceNames } from "./referenceNames";
import { uuidSchema } from "./uuid";

export const proseTextPartSchema = z.strictObject({
	kind: z.literal("text"),
	text: z.string().min(1),
});

export const proseFieldRefPartSchema = z.strictObject({
	kind: z.literal("field-ref"),
	uuid: uuidSchema,
});

export const proseCaseRefPartSchema = z.strictObject({
	kind: z.literal("case-ref"),
	caseType: z.string().min(1),
	property: authoredCasePropertyNameSchema,
});

export const proseUserPropertyRefPartSchema = z.strictObject({
	kind: z.literal("user-property-ref"),
	userPropertyUuid: uuidSchema,
});

/**
 * External CommCare session properties have no Nova-owned identity. Their
 * stable external name is the reference. The schema uses the same open
 * CommCare/session grammar as Predicate and XPath; document-aware admission
 * separately rejects a name claimed by Nova-owned worker information.
 */
export const proseExternalUserRefPartSchema = z.strictObject({
	kind: z.literal("user-ref"),
	property: externalUserPropertyNameSchema,
});

export const proseValuePartSchema = z.strictObject({
	kind: z.literal("value"),
	/** A form-rule expression that gives one value, shown as text where the part stands. */
	expression: formLogicSchema,
});
export type ProseValuePart = z.infer<typeof proseValuePartSchema>;

export const prosePartSchema = z.discriminatedUnion("kind", [
	proseTextPartSchema,
	proseFieldRefPartSchema,
	proseCaseRefPartSchema,
	proseUserPropertyRefPartSchema,
	proseExternalUserRefPartSchema,
	proseValuePartSchema,
]);
export type ProsePart = z.infer<typeof prosePartSchema>;
/** The four identity kinds. */
export type ProseReferencePart = Exclude<
	ProsePart,
	{ kind: "text" } | { kind: "value" }
>;
/** Every part that is not literal text. */
export type ProseAtomPart = ProseReferencePart | ProseValuePart;

export const PROSE_VALUE_IS_REFERENCE_MESSAGE =
	"This calculated value only reads one answer or saved value, and Nova keeps that as a reference. It can be stored as the reference part instead.";
export const CATALOG_PROSE_VALUE_MESSAGE =
	"A case property's label, hint and choice labels can't hold a calculated value, because no form evaluates them. You can put it in a question's label instead.";

export const proseTemplateSchema = z
	.strictObject({
		parts: z.array(prosePartSchema),
	})
	.superRefine((template, ctx) => {
		for (let index = 0; index < template.parts.length; index++) {
			const part = template.parts[index];
			if (
				index > 0 &&
				template.parts[index - 1]?.kind === "text" &&
				part?.kind === "text"
			) {
				ctx.addIssue({
					code: "custom",
					path: ["parts", index],
					message:
						"Adjacent prose text parts are not canonical; merge them into one part.",
				});
			}
			if (
				part?.kind === "value" &&
				proseReferenceOf(part.expression) !== undefined
			) {
				ctx.addIssue({
					code: "custom",
					path: ["parts", index, "expression"],
					message: PROSE_VALUE_IS_REFERENCE_MESSAGE,
				});
			}
		}
	});
export type ProseTemplate = z.infer<typeof proseTemplateSchema>;

/** A case property's label, hint or choice label: a template that holds no
 *  calculated value. A refinement, so the authoring layer still finds it in
 *  the `text` family by its schema's lineage. */
export const catalogProseTemplateSchema = proseTemplateSchema.superRefine(
	(template, ctx) => {
		template.parts.forEach((part, index) => {
			if (part.kind !== "value") return;
			ctx.addIssue({
				code: "custom",
				path: ["parts", index],
				message: CATALOG_PROSE_VALUE_MESSAGE,
			});
		});
	},
);

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

/**
 * The literal text an author typed, with every reference and calculated value
 * skipped.
 *
 * This is NOT a projection: a reference's current spelling only exists relative
 * to a document, so anything user-visible goes through `projectProseTemplate`.
 * This is for search indexing, sort keys, and comparisons, where matching what
 * was typed is the point and inventing a rendered spelling would be wrong.
 */
export function proseTemplateText(template: ProseTemplate): string {
	let out = "";
	for (const part of template.parts) {
		if (part.kind === "text") out += part.text;
	}
	return out;
}

/** What `projectProseTemplate` shows for a calculated value when the caller
 *  gives no printer. */
export const UNPRINTED_PROSE_VALUE_TEXT = "[calculated value]";

/** How a caller prints a calculated value. */
export interface ProseProjectionOptions {
	readonly value?: (part: ProseValuePart) => string;
}

export interface UnresolvedProseProjection {
	readonly kind: "field-ref" | "user-property-ref";
	readonly identity: string;
}

export type ProseProjectionResult =
	| { readonly ok: true; readonly text: string }
	| {
			readonly ok: false;
			readonly text: string;
			readonly unresolved: readonly UnresolvedProseProjection[];
	  };

export class ProseProjectionError extends Error {
	constructor(
		readonly unresolved: readonly UnresolvedProseProjection[],
		message = "Prose contains an unresolved authored reference.",
	) {
		super(message);
		this.name = "ProseProjectionError";
	}
}

export function isProseTemplate(value: unknown): value is ProseTemplate {
	return proseTemplateSchema.validate(value);
}

/** Stored reference parts (the four identity kinds) in document order. */
export function proseReferenceParts(
	template: ProseTemplate,
): readonly ProseReferencePart[] {
	return template.parts.filter(
		(part): part is ProseReferencePart =>
			part.kind !== "text" && part.kind !== "value",
	);
}

/** Every part that is not literal text, in document order. */
export function proseAtomParts(
	template: ProseTemplate,
): readonly ProseAtomPart[] {
	return template.parts.filter(
		(part): part is ProseAtomPart => part.kind !== "text",
	);
}

/**
 * Project a template to the canonical human/wire spelling. This is a read
 * projection only: no consumer may parse it back to recover identity. A
 * calculated value prints through `options.value`; with none it reads
 * `[calculated value]` and is not reported unresolved.
 */
export function projectProseTemplate(
	template: ProseTemplate,
	doc: ReferenceNamesDoc,
	options?: ProseProjectionOptions,
): ProseProjectionResult {
	const ctx = referenceNames(doc);
	let out = "";
	const unresolved: UnresolvedProseProjection[] = [];
	for (const part of template.parts) {
		switch (part.kind) {
			case "text":
				out += part.text;
				break;
			case "field-ref": {
				const path = ctx.fieldPathSegments(part.uuid);
				if (path === undefined) {
					unresolved.push({ kind: part.kind, identity: part.uuid });
					out += "#form/[reference needs repair]";
				} else {
					out += `#form/${path.join("/")}`;
				}
				break;
			}
			case "case-ref":
				out += caseReferenceText(part.caseType, part.property);
				break;
			case "user-property-ref": {
				const slug = ctx.userPropertySlug(part.userPropertyUuid);
				if (slug === undefined) {
					unresolved.push({
						kind: part.kind,
						identity: part.userPropertyUuid,
					});
					out += "#user/[reference needs repair]";
				} else {
					out += `#user/${slug}`;
				}
				break;
			}
			case "user-ref":
				out += `#user/${part.property}`;
				break;
			case "value":
				out += options?.value
					? options.value(part)
					: UNPRINTED_PROSE_VALUE_TEXT;
				break;
			default: {
				const _exhaustive: never = part;
				break;
			}
		}
	}
	return unresolved.length === 0
		? { ok: true, text: out }
		: { ok: false, text: out, unresolved };
}

/** Strict projection for wire/runtime consumers. A calculated value with no
 *  printer is a defect of the caller, never a guess. */
export function printProseTemplate(
	template: ProseTemplate,
	doc: ReferenceNamesDoc,
	options?: ProseProjectionOptions,
): string {
	if (
		options?.value === undefined &&
		template.parts.some((part) => part.kind === "value")
	) {
		throw new ProseProjectionError(
			[],
			"Prose holds a calculated value, and this projection was given no way to print it.",
		);
	}
	const projected = projectProseTemplate(template, doc, options);
	if (!projected.ok) throw new ProseProjectionError(projected.unresolved);
	return projected.text;
}

/**
 * Runtime projection that evaluates every atom part while leaving Markdown
 * text untouched. A reference part must resolve in the document first; the
 * callback evaluates the atom (`proseAtomExpression` is what it stands for).
 */
export function resolveProseTemplate(
	template: ProseTemplate,
	doc: ReferenceNamesDoc,
	evaluate: (part: ProseAtomPart) => string,
): string | undefined {
	if (!template.parts.some((part) => part.kind !== "text")) return undefined;
	const ctx = referenceNames(doc);
	let out = "";
	for (const part of template.parts) {
		switch (part.kind) {
			case "text":
				out += part.text;
				break;
			case "field-ref":
				if (ctx.fieldPathSegments(part.uuid) === undefined) {
					throw new ProseProjectionError([
						{ kind: part.kind, identity: part.uuid },
					]);
				}
				out += evaluate(part);
				break;
			case "user-property-ref":
				if (ctx.userPropertySlug(part.userPropertyUuid) === undefined) {
					throw new ProseProjectionError([
						{ kind: part.kind, identity: part.userPropertyUuid },
					]);
				}
				out += evaluate(part);
				break;
			case "case-ref":
			case "user-ref":
			case "value":
				out += evaluate(part);
				break;
			default: {
				const _exhaustive: never = part;
				break;
			}
		}
	}
	return out;
}

/** Rename the only prose reference family whose identity is name-based, and
 *  the property reads of each calculated value through `mapExpression`, which
 *  rewrites the tree in place and returns how many reads it rewrote. A catalog
 *  text holds no value, so its callers pass none. */
export function mapCasePropertiesInProse(
	template: ProseTemplate,
	resolve: (caseType: string, property: string) => string | undefined,
	mapExpression?: (expression: Expression) => number,
): number {
	let changed = 0;
	for (const part of template.parts) {
		if (part.kind === "value") {
			if (mapExpression) changed += mapExpression(part.expression);
			continue;
		}
		if (part.kind !== "case-ref") continue;
		const destination = resolve(part.caseType, part.property);
		if (destination === undefined || destination === part.property) continue;
		part.property = destination;
		changed++;
	}
	return changed;
}
