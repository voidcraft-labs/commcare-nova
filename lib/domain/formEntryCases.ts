// Identities of the records and values supplied when one form opens.

import { v5 as uuidv5 } from "uuid";
import { z } from "zod";
import type { BlueprintDoc } from "./blueprint";
import { mapExpressionAst } from "./expression/mapAst";
import {
	caseTypeNameSchema,
	formLogicSchema,
	sessionUserPropertySchema,
	sessionUserSchema,
} from "./expression/types";
import type { Form } from "./forms";
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

/** A second entry owns its selection sources. A replacement supplies the
 * parent's selection identity to the shared questions. An additional choice
 * has an identity and label of its own and contributes no case writes. */
export const sharedFormSelectionSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("replace"),
		selection: uuidSchema,
		caseType: caseTypeNameSchema,
		source: formSelectionSourceSchema,
	}),
	formCaseSelectionSchema.extend({ kind: z.literal("add") }),
]);
export type SharedFormSelection = z.infer<typeof sharedFormSelectionSchema>;
export const sharedFormSchema = z.strictObject({
	form: uuidSchema,
	selections: z.array(sharedFormSelectionSchema),
});

/** Only a new choice owns its identity; a replacement refers to its parent's. */
export function ownedFormSelections(
	form: Pick<Form, "caseSelections" | "shadowOf">,
): readonly FormCaseSelection[] {
	return (
		form.shadowOf?.selections.filter((row) => row.kind === "add") ??
		form.caseSelections ??
		[]
	);
}

/** The ordinary form that supplies the field tree, write program and submission namespace. */
export function formContentUuid(
	doc: Pick<BlueprintDoc, "forms">,
	entryUuid: Uuid,
): Uuid {
	return doc.forms[entryUuid]?.shadowOf?.form ?? entryUuid;
}

/** The topology of explicit opening choices, including a second entry's
 * replacements. Menu navigation needs neither the stored tag nor its label. */
export function entrySelectionSettings(
	form: Pick<Form, "caseSelections" | "shadowOf"> | undefined,
):
	| readonly Pick<FormCaseSelection, "uuid" | "source" | "caseType">[]
	| undefined {
	if (!form?.shadowOf) return form?.caseSelections;
	return form.shadowOf.selections.map((row) => ({
		uuid: row.kind === "replace" ? row.selection : row.uuid,
		caseType: row.caseType,
		source: row.source,
	}));
}

export const computedEntryValueSchema = z.strictObject({
	uuid: uuidSchema,
	key: advancedTagSchema,
	value: formLogicSchema,
});
export type ComputedEntryValue = z.infer<typeof computedEntryValueSchema>;

/** An entry owns its calculations. Keep existing formulas by their saved
 * key and supply each new parent value with a local identity. A copy of a
 * calculation reading an earlier one reads the entry's value under that key.
 * Stable minting makes a parent change replay identically from its mutation. */
export function sharedEntryValues(
	parent: Form,
	entry: Uuid,
	existing: readonly ComputedEntryValue[] = [],
): ComputedEntryValue[] {
	const values = [...existing];
	const byKey = new Map(existing.map((row) => [row.key, row.uuid]));
	const occupied = new Set(byKey.values());
	const local = new Map<Uuid, Uuid>();
	for (const row of parent.computedDatums ?? []) {
		let uuid = byKey.get(row.key);
		if (!uuid) {
			let attempt = 0;
			do {
				uuid = asUuid(uuidv5(`shared-value/${row.uuid}/${attempt++}`, entry));
			} while (occupied.has(uuid));
			occupied.add(uuid);
			const value = mapExpressionAst(row.value, {
				mapTerm(term) {
					if (
						term.kind !== "session-datum" ||
						term.datum.kind !== "entry-value"
					)
						return term;
					const ref = local.get(term.datum.datum);
					return ref
						? { ...term, datum: { kind: "entry-value", datum: ref } }
						: term;
				},
			});
			values.push({ ...row, uuid, value });
		}
		local.set(row.uuid, uuid);
	}
	return values;
}

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
			!form.shadowOf && form.caseSelections === undefined
				? []
				: [
						[
							form.uuid,
							new Map(
								ownedFormSelections(form).map((row) => [row.tag, row.name]),
							),
						] as const,
					],
		),
	);
}
