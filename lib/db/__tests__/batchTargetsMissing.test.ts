/**
 * `batchTargetsMissing` — the concurrent-delete guard the guarded commit runs
 * against the FRESH stored doc BEFORE the verdict. The reducers are total, so a
 * mutation whose target a peer deleted silently no-ops and the verdict passes —
 * invisible data loss. This function turns that into a surfaced conflict.
 *
 * These are PURE unit tests (no Firestore): the function is a pure
 * `(doc, mutations) => boolean`. Coverage is per-KIND at the granularity P2
 * introduced — entity (module/form/field), catalog (`(caseType, property)`
 * name), and collection item (column / search-input / option uuid). The
 * exhaustive `switch` is closed by `assertNever` in the `default`, so an
 * unlisted kind is a COMPILE error; here we prove every listed kind resolves
 * against its live set — a present target → `false`, a missing one → `true`.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { batchTargetsMissing } from "@/lib/db/commitGuard";
import type { Mutation } from "@/lib/doc/types";
import { asUuid, type BlueprintDoc } from "@/lib/domain";

/**
 * A doc with one case-list module (a column + a search input), a survey form
 * carrying a select field with two keyed options, and a `patient` case type.
 * Provides a live target of every entity + collection kind for the checks below.
 */
function fixture(): {
	doc: BlueprintDoc;
	moduleUuid: string;
	formUuid: string;
	fieldUuid: string;
	selectUuid: string;
	columnUuid: string;
	searchInputUuid: string;
	optionUuid: string;
} {
	const doc = buildDoc({
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Intake",
						type: "survey",
						fields: [
							f({ kind: "text", id: "note", label: "Note" }),
							f({
								kind: "single_select",
								id: "color",
								label: "Color",
								options: [
									{ value: "red", label: "Red" },
									{ value: "green", label: "Green" },
								],
							}),
						],
					},
				],
			},
		],
		caseTypes: [
			{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
		],
	});

	const moduleUuid = Object.values(doc.modules)[0].uuid;
	const formUuid = Object.values(doc.forms)[0].uuid;
	const noteField = Object.values(doc.fields).find((fl) => fl.id === "note");
	const selectField = Object.values(doc.fields).find((fl) => fl.id === "color");
	if (!noteField || !selectField) throw new Error("fixture fields missing");

	// Inject a search input + option uuids the concise builder doesn't mint.
	const mod = doc.modules[moduleUuid] as {
		caseListConfig: {
			columns: { uuid: string }[];
			searchInputs: {
				uuid: string;
				name: string;
				label: string;
				type: string;
			}[];
		};
	};
	const searchInputUuid = asUuid("search-input-1");
	mod.caseListConfig.searchInputs = [
		{
			uuid: searchInputUuid,
			name: "name",
			label: "Name",
			type: "text",
			kind: "simple",
			property: "case_name",
		} as unknown as (typeof mod.caseListConfig.searchInputs)[number],
	];
	const columnUuid = mod.caseListConfig.columns[0].uuid;

	const select = doc.fields[selectField.uuid] as {
		options: { value: string; uuid?: string }[];
	};
	const optionUuid = asUuid("option-red");
	select.options[0].uuid = optionUuid;
	select.options[1].uuid = asUuid("option-green");

	return {
		doc,
		moduleUuid,
		formUuid,
		fieldUuid: noteField.uuid,
		selectUuid: selectField.uuid,
		columnUuid,
		searchInputUuid,
		optionUuid,
	};
}

const MISSING = "00000000-0000-4000-8000-000000000000";

describe("batchTargetsMissing — entity kinds", () => {
	it("returns false for edits to live module / form / field targets", () => {
		const { doc, moduleUuid, formUuid, fieldUuid } = fixture();
		const live: Mutation[] = [
			{
				kind: "renameModule",
				uuid: moduleUuid,
				newId: "patients2",
			} as Mutation,
			{ kind: "renameForm", uuid: formUuid, newId: "intake2" } as Mutation,
			{
				kind: "updateField",
				uuid: fieldUuid,
				targetKind: "text",
				patch: { label: "Note!" },
			} as Mutation,
		];
		expect(batchTargetsMissing(doc, live)).toBe(false);
	});

	it("returns true when a module / form / field target was removed by a peer", () => {
		const { doc } = fixture();
		expect(
			batchTargetsMissing(doc, [
				{ kind: "renameModule", uuid: MISSING, newId: "x" } as Mutation,
			]),
		).toBe(true);
		expect(
			batchTargetsMissing(doc, [
				{ kind: "removeForm", uuid: MISSING } as Mutation,
			]),
		).toBe(true);
		expect(
			batchTargetsMissing(doc, [
				{ kind: "removeField", uuid: MISSING } as Mutation,
			]),
		).toBe(true);
	});

	it("tracks intra-batch adds — an add-then-edit of the same entity is not missing", () => {
		const { doc, moduleUuid } = fixture();
		const newFormUuid = asUuid("new-form");
		const batch: Mutation[] = [
			{
				kind: "addForm",
				moduleUuid,
				form: {
					uuid: newFormUuid,
					id: "extra",
					name: "Extra",
					type: "survey",
				},
			} as unknown as Mutation,
			{ kind: "renameForm", uuid: newFormUuid, newId: "extra2" } as Mutation,
		];
		expect(batchTargetsMissing(doc, batch)).toBe(false);
	});
});

describe("batchTargetsMissing — granular catalog kinds", () => {
	it("returns false for catalog edits against a declared type", () => {
		const { doc } = fixture();
		const live: Mutation[] = [
			{
				kind: "addCaseProperty",
				caseType: "patient",
				property: { name: "age", label: "Age" },
			} as Mutation,
			{
				kind: "removeCaseProperty",
				caseType: "patient",
				property: "age",
			} as Mutation,
			{
				kind: "setCaseProperty",
				caseType: "patient",
				property: { name: "age", label: "Age" },
			} as Mutation,
			{ kind: "setCaseTypeMeta", caseType: "patient" } as Mutation,
		];
		expect(batchTargetsMissing(doc, live)).toBe(false);
	});

	it("returns true for a catalog edit or retire against an absent / concurrently-retired type", () => {
		const { doc } = fixture();
		expect(
			batchTargetsMissing(doc, [
				{
					kind: "addCaseProperty",
					caseType: "household",
					property: { name: "x", label: "X" },
				} as Mutation,
			]),
		).toBe(true);
		expect(
			batchTargetsMissing(doc, [
				{ kind: "retireCaseType", caseType: "household" } as Mutation,
			]),
		).toBe(true);
	});

	it("seeds an intra-batch declareCaseType before its property writes", () => {
		const { doc } = fixture();
		const batch: Mutation[] = [
			{ kind: "declareCaseType", caseType: "household" } as Mutation,
			{
				kind: "addCaseProperty",
				caseType: "household",
				property: { name: "size", label: "Size" },
			} as Mutation,
		];
		expect(batchTargetsMissing(doc, batch)).toBe(false);
	});
});

describe("batchTargetsMissing — granular collection kinds (item uuid)", () => {
	it("returns false for column / search-input / option edits on live items", () => {
		const {
			doc,
			moduleUuid,
			columnUuid,
			searchInputUuid,
			selectUuid,
			optionUuid,
		} = fixture();
		// Non-destructive edits to every live item (no remove-then-move on the
		// same uuid, which would legitimately trip the guard mid-batch).
		const live: Mutation[] = [
			{
				kind: "moveColumn",
				moduleUuid,
				uuid: columnUuid,
				order: "a1",
			} as Mutation,
			{
				kind: "removeSearchInput",
				moduleUuid,
				uuid: searchInputUuid,
			} as Mutation,
			{ kind: "setCaseListMeta", uuid: moduleUuid, patch: {} } as Mutation,
			{
				kind: "moveOption",
				fieldUuid: selectUuid,
				uuid: optionUuid,
				order: "a1",
			} as Mutation,
		];
		expect(batchTargetsMissing(doc, live)).toBe(false);
	});

	it("returns true when a column / search-input / option item was concurrently removed", () => {
		const { doc, moduleUuid, selectUuid } = fixture();
		expect(
			batchTargetsMissing(doc, [
				{ kind: "removeColumn", moduleUuid, uuid: MISSING } as Mutation,
			]),
		).toBe(true);
		expect(
			batchTargetsMissing(doc, [
				{
					kind: "updateSearchInput",
					moduleUuid,
					uuid: MISSING,
				} as unknown as Mutation,
			]),
		).toBe(true);
		expect(
			batchTargetsMissing(doc, [
				{
					kind: "moveOption",
					fieldUuid: selectUuid,
					uuid: MISSING,
					order: "a1",
				} as Mutation,
			]),
		).toBe(true);
	});

	it("returns true when a column/option target's parent module/field was removed", () => {
		const { doc } = fixture();
		expect(
			batchTargetsMissing(doc, [
				{
					kind: "addColumn",
					moduleUuid: MISSING,
					column: {
						uuid: asUuid("c-new"),
						kind: "plain",
						field: "x",
						header: "X",
					},
				} as unknown as Mutation,
			]),
		).toBe(true);
		expect(
			batchTargetsMissing(doc, [
				{
					kind: "addOption",
					fieldUuid: MISSING,
					option: { value: "v", label: "V", uuid: asUuid("o-new") },
				} as unknown as Mutation,
			]),
		).toBe(true);
	});

	it("rejects a setCaseListMeta whose config a peer concurrently cleared", () => {
		const { doc, moduleUuid } = fixture();
		// The fixture's module has a config, so a setCaseListMeta on it is fine.
		expect(
			batchTargetsMissing(doc, [
				{
					kind: "setCaseListMeta",
					uuid: moduleUuid,
					patch: { filter: { kind: "match-all" } },
				} as Mutation,
			]),
		).toBe(false);

		// Simulate a peer having cleared the whole case-list config: the same
		// setCaseListMeta now targets a removed config → a conflict, not a silent
		// resurrection.
		const cleared = {
			...doc,
			modules: {
				...doc.modules,
				[moduleUuid]: {
					...doc.modules[moduleUuid],
					caseListConfig: undefined,
				},
			},
		} as BlueprintDoc;
		expect(
			batchTargetsMissing(cleared, [
				{
					kind: "setCaseListMeta",
					uuid: moduleUuid,
					patch: { filter: { kind: "match-all" } },
				} as Mutation,
			]),
		).toBe(true);
	});

	it("does not reject a setCaseListMeta that follows a same-batch config birth", () => {
		const { doc, moduleUuid } = fixture();
		const cleared = {
			...doc,
			modules: {
				...doc.modules,
				[moduleUuid]: {
					...doc.modules[moduleUuid],
					caseListConfig: undefined,
				},
			},
		} as BlueprintDoc;
		// A wholesale config birth (`updateModule{caseListConfig}`) followed by a
		// setCaseListMeta in the same batch: the guard tracks the intra-batch birth.
		expect(
			batchTargetsMissing(cleared, [
				{
					kind: "updateModule",
					uuid: moduleUuid,
					patch: { caseListConfig: { columns: [], searchInputs: [] } },
				} as unknown as Mutation,
				{
					kind: "setCaseListMeta",
					uuid: moduleUuid,
					patch: { filter: { kind: "match-all" } },
				} as Mutation,
			]),
		).toBe(false);
		// An addColumn also births a config, so a follow-up setCaseListMeta resolves.
		expect(
			batchTargetsMissing(cleared, [
				{
					kind: "addColumn",
					moduleUuid,
					column: {
						uuid: asUuid("col-birth"),
						kind: "plain",
						field: "case_name",
						header: "N",
					},
				} as unknown as Mutation,
				{
					kind: "setCaseListMeta",
					uuid: moduleUuid,
					patch: { filter: { kind: "match-all" } },
				} as Mutation,
			]),
		).toBe(false);
	});

	it("seeds an intra-batch addColumn/addOption before a follow-up edit of the same item", () => {
		const { doc, moduleUuid, selectUuid } = fixture();
		const newColUuid = asUuid("col-new");
		const newOptUuid = asUuid("opt-new");
		const batch: Mutation[] = [
			{
				kind: "addColumn",
				moduleUuid,
				column: {
					uuid: newColUuid,
					kind: "plain",
					field: "case_name",
					header: "N",
				},
			} as unknown as Mutation,
			{
				kind: "moveColumn",
				moduleUuid,
				uuid: newColUuid,
				order: "a1",
			} as Mutation,
			{
				kind: "addOption",
				fieldUuid: selectUuid,
				option: { value: "blue", label: "Blue", uuid: newOptUuid },
			} as unknown as Mutation,
			{
				kind: "removeOption",
				fieldUuid: selectUuid,
				uuid: newOptUuid,
			} as Mutation,
		];
		expect(batchTargetsMissing(doc, batch)).toBe(false);
	});
});

describe("batchTargetsMissing — app-level scalars", () => {
	it("app-level scalar kinds are always safe (no entity target)", () => {
		const { doc } = fixture();
		const scalars: Mutation[] = [
			{ kind: "setAppName", name: "New" } as Mutation,
			{ kind: "setConnectType", connectType: null } as Mutation,
			{ kind: "setAppLogo", logo: null } as Mutation,
		];
		expect(batchTargetsMissing(doc, scalars)).toBe(false);
	});

	it("a wholesale setCaseTypes re-seeds the simulated catalog for later catalog edits", () => {
		const { doc } = fixture();
		const batch: Mutation[] = [
			{
				kind: "setCaseTypes",
				caseTypes: [{ name: "household", properties: [] }],
			} as unknown as Mutation,
			{
				kind: "addCaseProperty",
				caseType: "household",
				property: { name: "size", label: "Size" },
			} as Mutation,
			// `patient` was replaced by the wholesale set → now a conflict.
			{ kind: "retireCaseType", caseType: "patient" } as Mutation,
		];
		expect(batchTargetsMissing(doc, batch)).toBe(true);
	});
});
