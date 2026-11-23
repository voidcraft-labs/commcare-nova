// Identities of the records and values supplied when one form opens.

import { v5 as uuidv5 } from "uuid";
import { z } from "zod";
import type { BlueprintDoc } from "./blueprint";
import {
	caseTypeNameSchema,
	formLogicSchema,
	sessionUserPropertySchema,
	sessionUserSchema,
} from "./expression/types";
import { lookupColumnIdSchema, lookupTableIdSchema } from "./lookupIds";
import { advancedTagSchema } from "./placements";
import { asUuid, type Uuid, uuidSchema } from "./uuid";

const namedIndex = z.strictObject({
	selection: uuidSchema,
	identifier: advancedTagSchema,
});

export const formSelectionSourceSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("choose"),
		module: uuidSchema,
		under: namedIndex
			.extend({
				relationship: z
					.union([
						z.literal("extension"),
						z.strictObject({ question: uuidSchema }),
					])
					.optional(),
			})
			.optional(),
	}),
	z.strictObject({ kind: z.literal("expression"), value: formLogicSchema }),
	z.strictObject({
		kind: z.literal("worker-data"),
		property: z.union([
			sessionUserSchema.omit({ source: true }),
			sessionUserPropertySchema.omit({ source: true }),
		]),
	}),
	z.strictObject({
		kind: z.literal("table"),
		table: lookupTableIdSchema,
		column: lookupColumnIdSchema,
	}),
	z.strictObject({ kind: z.literal("index"), ...namedIndex.shape }),
	z.strictObject({ kind: z.literal("worker-record") }),
]);
export type FormSelectionSource = z.infer<typeof formSelectionSourceSchema>;

export const formCaseSelectionSchema = z.strictObject({
	uuid: uuidSchema,
	name: z.string().min(1),
	caseType: caseTypeNameSchema,
	tag: advancedTagSchema,
	source: formSelectionSourceSchema,
});
export type FormCaseSelection = z.infer<typeof formCaseSelectionSchema>;

export const computedEntryValueSchema = z.strictObject({
	uuid: uuidSchema,
	key: advancedTagSchema,
	value: formLogicSchema,
});
export type ComputedEntryValue = z.infer<typeof computedEntryValueSchema>;

/** Materializing an implicit selection, moving its menu, and renaming a menu or a
 * case type all retain its identity. The form serves as its UUID namespace. */
export function implicitFormSelectionId(
	form: Uuid,
	module: Uuid | "worker-record",
): Uuid {
	return asUuid(
		uuidv5(
			module === "worker-record" ? "worker-record" : `chosen/${module}`,
			form,
		),
	);
}

/** Labels have no HQ source property. Keep them for an existing form when
 * the source still supplies the same tag after an edit in HQ. */
export function knownFormEntryChoicesOf(
	doc: BlueprintDoc,
): ReadonlyMap<Uuid, ReadonlyMap<string, string>> {
	return new Map(
		Object.values(doc.forms).flatMap((form) =>
			form.caseSelections === undefined
				? []
				: [
						[
							form.uuid,
							new Map(form.caseSelections.map((row) => [row.tag, row.name])),
						] as const,
					],
		),
	);
}
