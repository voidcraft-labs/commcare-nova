/**
 * Contract: turning a mapping row into a condition through its comparison menu commits through
 * the real gate, including a row saved before rows carried identities (an app brought in from
 * HQ, or a document saved earlier), and turning it back keeps its saved value. The plausible
 * failure: the patch carries no identity, and the gate refuses a condition row with none
 * (CASE_LIST_MAPPING_CONDITION), so the author can't convert the row in place. A row keyed by its
 * saved value keeps its translations under the unit it moves to as it gains an identity or a new
 * value (`mappingRowTranslationCarry`); without the carry the old entry would name a unit that
 * no longer exists, and the author's translation would be lost or the edit refused. The same
 * edit made under a worker language runs through the Builder's language projection, which reads
 * the moved row as the row it was (`mappingRowUnitMoves`) rather than as new source content.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	columnSnapshotMutations,
	mappingRowTranslationCarry,
} from "@/lib/doc/caseListColumnMutations";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import { projectBuilderLanguageMutations } from "@/lib/doc/projectBuilderLanguageMutations";
import type { Mutation } from "@/lib/doc/types";
import {
	type BlueprintDoc,
	type Column,
	collectTranslationUnits,
	idMappingColumn,
	idMappingEntry,
	plainColumn,
	type Uuid,
} from "@/lib/domain";
import { caseMappingTextUnit } from "@/lib/domain/caseMappingRows";
import { proseText } from "@/lib/domain/prose";
import { mappingComparisonPatch } from "../mappingRowComparison";

const NAME = "00000000-0000-4000-8000-000000000001" as Uuid;
const WATER = "00000000-0000-4000-8000-000000000002" as Uuid;

function app(): BlueprintDoc {
	return buildDoc({
		caseTypes: [
			{
				name: "household",
				properties: [{ name: "water", label: proseText("Water") }],
			},
		],
		modules: [
			{
				name: "Households",
				caseType: "household",
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "name",
								caseWrite: { caseType: "household", property: "case_name" },
							}),
							f({
								kind: "text",
								id: "water",
								caseWrite: { caseType: "household", property: "water" },
							}),
						],
					},
				],
				caseListConfig: {
					columns: [
						plainColumn(NAME, "case_name", "Name"),
						{
							...idMappingColumn(WATER, "water", "Water", [
								idMappingEntry("tap", "Tap"),
							]),
							behavior: "first-match",
						},
					],
					searchInputs: [],
				},
			},
		],
	});
}

/** The card's row update: the patch merged in, cleared keys dropped. */
function patched(column: Column, patch: object): Column {
	if (column.kind !== "id-mapping") throw new Error("Expected a mapping.");
	const [row] = column.mapping;
	return {
		...column,
		mapping: [
			Object.fromEntries(
				Object.entries({ ...row, ...patch }).filter(([, v]) => v !== undefined),
			) as (typeof column.mapping)[number],
		],
	};
}

function commit(
	doc: BlueprintDoc,
	column: Column,
	carry: { before: Mutation[]; after: Mutation[] } = { before: [], after: [] },
) {
	const moduleUuid = doc.moduleOrder[0] as Uuid;
	const { uuid: _uuid, ...content } = column;
	return mutationCommitVerdict(
		doc,
		[
			...carry.before,
			{ kind: "updateColumn", moduleUuid, uuid: WATER, column: content },
			...carry.after,
		],
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
}

function waterColumn(doc: BlueprintDoc) {
	const column = doc.modules[
		doc.moduleOrder[0] as Uuid
	]?.caseListConfig?.columns.find((one) => one.uuid === WATER);
	if (column?.kind !== "id-mapping") throw new Error("Expected a mapping.");
	return column;
}

/** `app()` with Spanish, and the row's label translated. */
function translated(): { doc: BlueprintDoc; unitId: string } {
	const base = produce(app(), (draft) => {
		applyMutations(draft, [
			{ kind: "addLanguage", language: { language: "spa" }, wireCode: "es" },
		]);
	});
	const [row] = waterColumn(base).mapping;
	const unitId = caseMappingTextUnit(WATER, row ?? {}, "mapping");
	const unit = collectTranslationUnits(base).find((one) => one.id === unitId);
	if (unit === undefined) throw new Error("The row's label has no unit.");
	const doc = produce(base, (draft) => {
		applyMutations(draft, [
			{
				kind: "setTranslation",
				language: "spa",
				unitId: unit.id,
				entry: {
					value: "Grifo",
					sourceFingerprint: unit.sourceFingerprint,
					origin: "human",
					review: "reviewed",
					translatedFrom: "eng",
				},
			},
		]);
	});
	return { doc, unitId };
}

describe("a mapping row's comparison", () => {
	it("turns a row with no identity into a condition the gate admits", () => {
		const doc = app();
		const moduleUuid = doc.moduleOrder[0] as Uuid;
		const column = doc.modules[moduleUuid]?.caseListConfig?.columns.find(
			(one) => one.uuid === WATER,
		);
		if (column?.kind !== "id-mapping") throw new Error("Expected a mapping.");
		const [row] = column.mapping;
		expect(row?.uuid).toBeUndefined();
		const condition = patched(
			column,
			mappingComparisonPatch(row ?? {}, "condition", false),
		);
		const verdict = commit(doc, condition);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
		if (condition.kind !== "id-mapping") throw new Error("Expected a mapping.");
		const [rule] = condition.mapping;
		expect(rule?.uuid).toBeDefined();
		expect(rule?.when).toBeDefined();
		// Back to a saved value: the identity stays, the condition goes.
		expect(mappingComparisonPatch(rule ?? {}, "exact", false)).toEqual({
			value: "",
			when: undefined,
		});
	});
	it("carries a row's translation as it gains an identity or a new value", () => {
		const { doc, unitId } = translated();
		const column = waterColumn(doc);
		const [row] = column.mapping;
		for (const patch of [
			mappingComparisonPatch(row ?? {}, "condition", false),
			{ value: "piped" },
		]) {
			const next = patched(column, patch);
			const carry = mappingRowTranslationCarry(doc, column, next);
			expect(carry.after).toHaveLength(1);
			const verdict = commit(doc, next, carry);
			if (!verdict.ok) throw new Error(JSON.stringify(verdict.findings));
			const [moved] = waterColumn(verdict.nextDoc).mapping;
			const to = caseMappingTextUnit(WATER, moved ?? {}, "mapping");
			expect(to).not.toBe(unitId);
			const spanish = verdict.nextDoc.localization?.translations.spa ?? {};
			expect(spanish[to]?.value).toBe("Grifo");
			expect(spanish[unitId]).toBeUndefined();
		}
	});
	it("carries the row's translation when the edit is made under the worker language", () => {
		// The Builder runs every batch through the language projection; under Spanish the row
		// shows its Spanish label, and the moved row is the same row, not new source content.
		const { doc, unitId } = translated();
		const moduleUuid = doc.moduleOrder[0] as Uuid;
		const column = waterColumn(doc);
		const [row] = column.mapping;
		for (const [patch, spanishLabel] of [
			[mappingComparisonPatch(row ?? {}, "condition", false), "Grifo"],
			[{ value: "piped" }, "Grifo"],
			[{ value: "piped" }, "Agua de grifo"],
		] as const) {
			const next = patched(
				{
					...column,
					mapping: column.mapping.map((one) => ({
						...one,
						label: "Grifo",
					})),
				},
				{ ...patch, label: spanishLabel },
			);
			const carry = mappingRowTranslationCarry(doc, column, next);
			const projection = projectBuilderLanguageMutations(doc, "spa", [
				...carry.before,
				...columnSnapshotMutations(moduleUuid, column, next),
				...carry.after,
			]);
			if (!projection.ok) throw new Error(projection.message);
			const verdict = mutationCommitVerdict(
				doc,
				projection.mutations,
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			if (!verdict.ok) throw new Error(JSON.stringify(verdict.findings));
			const [moved] = waterColumn(verdict.nextDoc).mapping;
			expect(moved?.label).toBe("Tap");
			const to = caseMappingTextUnit(WATER, moved ?? {}, "mapping");
			expect(to).not.toBe(unitId);
			const spanish = verdict.nextDoc.localization?.translations.spa ?? {};
			expect(spanish[to]?.value).toBe(spanishLabel);
			expect(spanish[unitId]).toBeUndefined();
		}
	});
});
