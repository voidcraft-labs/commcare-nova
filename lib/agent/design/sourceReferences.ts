import { z } from "zod";
import { strictWireJsonSchema } from "@/lib/agent/strictStructuredOutput";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	DESIGN_SOURCE_SCHEMA_MARKER,
	type SourceRef,
	sourceRefKey,
	sourceRefSchema,
} from "./evidence";
import { mapDesignSchemaSlots } from "./identityProjection";
import { citableSourceRefs, type DesignSourcePackage } from "./sourcePackage";

/** A source keeps its label when a conversation grows or its index is reordered.
 * The full coordinate remains private; attachment locations narrow the same source. */
export function designSourceLabel(ref: SourceRef): string {
	return ref.kind === "platform-constraint"
		? `platform:${ref.code}`
		: `S_${canonicalJsonDigest(sourceRefKey(ref)).slice(0, 12)}`;
}

const labelSchema = z
	.string()
	.min(1)
	.max(120)
	.describe("Source label shown with the message, document or image.");

export const authoredSourceRefSchema = z.union([
	labelSchema,
	z
		.object({
			source: labelSchema,
			sectionPath: z.array(z.string().min(1)).optional(),
			figureMarker: z.string().min(1).optional(),
		})
		.strict()
		.describe("A document source with an optional section or figure location."),
]);

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

let authoredWire: unknown;

/** Replace the provenance carrier once, wherever a source reference is allowed. */
export function sourceAuthoringWireSchema(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(sourceAuthoringWireSchema);
	if (!object(node)) return node;
	if (node[DESIGN_SOURCE_SCHEMA_MARKER] === true) {
		authoredWire ??= (
			strictWireJsonSchema(
				z.object({ reference: authoredSourceRefSchema }).strict(),
			) as { properties: { reference: unknown } }
		).properties.reference;
		return authoredWire;
	}
	return Object.fromEntries(
		Object.entries(node).map(([key, value]) => [
			key,
			sourceAuthoringWireSchema(value),
		]),
	);
}

export function projectDesignSourceRefs(
	schema: z.ZodType,
	value: unknown,
): unknown {
	return mapDesignSchemaSlots(
		schema,
		value,
		DESIGN_SOURCE_SCHEMA_MARKER,
		(entry) => {
			const ref = sourceRefSchema.parse(entry);
			const source = designSourceLabel(ref);
			if (
				ref.kind !== "attachment-extract" ||
				(ref.sectionPath.length === 0 && ref.figureMarker === undefined)
			)
				return source;
			return {
				source,
				...(ref.sectionPath.length > 0 ? { sectionPath: ref.sectionPath } : {}),
				...(ref.figureMarker === undefined
					? {}
					: { figureMarker: ref.figureMarker }),
			};
		},
	);
}

/** Resolve only labels from the current authorized package. The model neither
 * supplies coordinates nor creates authority by spelling a plausible source. */
export function bindDesignSourceRefs(args: {
	schema: z.ZodType;
	input: unknown;
	pkg: DesignSourcePackage;
}): { ok: true; value: unknown } | { ok: false; error: string } {
	const refs = new Map<string, SourceRef>();
	for (const ref of citableSourceRefs(args.pkg)) {
		const label = designSourceLabel(ref);
		const prior = refs.get(label);
		if (prior !== undefined && sourceRefKey(prior) !== sourceRefKey(ref))
			throw new Error("Distinct design sources share a label.");
		refs.set(
			label,
			ref.kind === "attachment-extract"
				? {
						kind: ref.kind,
						assetId: ref.assetId,
						extractorVersion: ref.extractorVersion,
						sectionPath: [],
					}
				: ref,
		);
	}
	let error: string | undefined;
	const value = mapDesignSchemaSlots(
		args.schema,
		args.input,
		DESIGN_SOURCE_SCHEMA_MARKER,
		(entry, path) => {
			const authored = authoredSourceRefSchema.safeParse(entry);
			if (!authored.success) {
				error ??= `${path.join(".")}: Use the source label shown with the source.`;
				return entry;
			}
			const label =
				typeof authored.data === "string"
					? authored.data
					: authored.data.source;
			const ref = refs.get(label);
			if (ref === undefined) {
				error ??= `${path.join(".")}: Source ${label} is not in the current conversation.`;
				return entry;
			}
			if (typeof authored.data === "string") return ref;
			if (ref.kind !== "attachment-extract") {
				error ??= `${path.join(".")}: Only document sources have section or figure locations.`;
				return entry;
			}
			return {
				...ref,
				...(authored.data.sectionPath === undefined
					? {}
					: { sectionPath: authored.data.sectionPath }),
				...(authored.data.figureMarker === undefined
					? {}
					: { figureMarker: authored.data.figureMarker }),
			};
		},
	);
	return error === undefined ? { ok: true, value } : { ok: false, error };
}
