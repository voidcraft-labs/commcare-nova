/**
 * `batchTargetsMissing` — the concurrent-delete guard the guarded commit runs
 * against the FRESH stored doc BEFORE the verdict. The reducers are total, so a
 * mutation whose target a peer deleted silently no-ops and the verdict passes —
 * invisible data loss. This function turns that into a surfaced conflict.
 *
 * These are PURE unit tests (no database): the function is a pure
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
import {
	asUuid,
	type BlueprintDoc,
	type CaseOperation,
	emptyCaseListConfig,
} from "@/lib/domain";

const OPERATION = asUuid("11111111-1111-4111-8111-111111111111");
const OTHER_OPERATION = asUuid("22222222-2222-4222-8222-222222222222");

function value(value: string) {
	return {
		kind: "term" as const,
		term: { kind: "literal" as const, value },
	};
}

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
	operationUuid: string;
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
	doc.forms[formUuid].caseOperations = [
		{
			uuid: OPERATION,
			id: "create_patient",
			action: "create",
			caseType: "patient",
			target: { kind: "new" },
			name: value("Patient"),
			writes: [{ property: "status", value: value("open") }],
			links: [
				{
					identifier: "parent",
					targetType: "household",
					target: null,
					relationship: "child",
				},
			],
		},
	];

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
		operationUuid: OPERATION,
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
		expect(
			batchTargetsMissing(doc, [
				{
					kind: "updateModule",
					uuid: MISSING,
					patch: { caseListConfig: emptyCaseListConfig() },
					ensureCaseListConfig: true,
				} as unknown as Mutation,
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
				} as unknown as Mutation,
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
		const column = doc.modules[moduleUuid].caseListConfig?.columns.find(
			(candidate) => candidate.uuid === columnUuid,
		);
		if (!column) throw new Error("fixture column missing");
		// Non-destructive edits to every live item (no remove-then-move on the
		// same uuid, which would legitimately trip the guard mid-batch).
		const live: Mutation[] = [
			{
				kind: "moveColumn",
				moduleUuid,
				uuid: columnUuid,
				surface: "list",
				after: null,
			} as Mutation,
			{
				kind: "moveColumn",
				moduleUuid,
				uuid: columnUuid,
				surface: "list",
				after: null,
			} as Mutation,
			{
				kind: "moveColumn",
				moduleUuid,
				uuid: columnUuid,
				surface: "detail",
				after: null,
			} as Mutation,
			{
				kind: "updateColumn",
				moduleUuid,
				uuid: columnUuid,
				column: { ...column, visibleInDetail: false },
				visibilityPatch: { surface: "detail", visible: false },
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
					kind: "updateColumn",
					moduleUuid,
					uuid: MISSING,
					column: {
						uuid: MISSING,
						kind: "plain",
						field: "x",
						header: "X",
						visibleInList: false,
					},
					visibilityPatch: { surface: "list", visible: false },
				} as Mutation,
			]),
		).toBe(true);
		expect(
			batchTargetsMissing(doc, [
				{
					kind: "moveColumn",
					moduleUuid,
					uuid: MISSING,
					surface: "list",
					after: null,
				} as Mutation,
			]),
		).toBe(true);
		expect(
			batchTargetsMissing(doc, [
				{
					kind: "moveColumn",
					moduleUuid,
					uuid: MISSING,
					surface: "detail",
					after: null,
				} as Mutation,
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
				} as Mutation,
			]),
		).toBe(true);
	});

	it("tracks an intra-batch column add before its visibility patch", () => {
		const { doc, moduleUuid } = fixture();
		const owner = asUuid(moduleUuid);
		const uuid = asUuid("column-new");
		const column = {
			uuid,
			kind: "plain" as const,
			field: "case_name",
			header: "Second name",
		};
		expect(
			batchTargetsMissing(doc, [
				{
					kind: "addColumn",
					moduleUuid: owner,
					column,
					afterInList: null,
					afterInDetail: null,
				},
				{
					kind: "updateColumn",
					moduleUuid: owner,
					uuid,
					column: { ...column, visibleInDetail: false },
					visibilityPatch: { surface: "detail", visible: false },
				},
			]),
		).toBe(false);
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
		// The semantic config ensure followed by setCaseListMeta: the guard tracks
		// the intra-batch birth without requiring a stale whole-config snapshot.
		expect(
			batchTargetsMissing(cleared, [
				{
					kind: "updateModule",
					uuid: moduleUuid,
					patch: { caseListConfig: emptyCaseListConfig() },
					ensureCaseListConfig: true,
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

describe("batchTargetsMissing — case-operation logical identities", () => {
	function operationIn(doc: BlueprintDoc, formUuid: string): CaseOperation {
		const operation = doc.forms[formUuid]?.caseOperations?.[0];
		if (operation === undefined) throw new Error("fixture operation missing");
		return operation;
	}

	function granular(
		formUuid: string,
		fallback: CaseOperation,
		caseOperationPatch: NonNullable<
			Extract<Mutation, { kind: "updateForm" }>["caseOperationPatch"]
		>,
	): Mutation {
		return {
			kind: "updateForm",
			uuid: asUuid(formUuid),
			patch: {},
			caseOperationChange: {
				operation: "update",
				uuid: fallback.uuid,
				value: fallback,
			},
			caseOperationPatch,
		};
	}

	it("rejects a scalar/move/write/link edit after a peer removed its target", () => {
		const { doc, formUuid } = fixture();
		const operation = operationIn(doc, formUuid);
		const withoutOperation = structuredClone(doc);
		delete withoutOperation.forms[formUuid].caseOperations;
		const operationEdits: Mutation[] = [
			granular(
				formUuid,
				{ ...operation, id: "renamed" },
				{
					operation: "update",
					uuid: OPERATION,
					patch: { id: "renamed" },
				},
			),
			granular(formUuid, operation, {
				operation: "move",
				uuid: OPERATION,
				after: null,
			}),
		];
		for (const mutation of operationEdits) {
			expect(batchTargetsMissing(withoutOperation, [mutation])).toBe(true);
		}

		const withoutWrite = structuredClone(doc);
		delete withoutWrite.forms[formUuid].caseOperations?.[0]?.writes;
		expect(
			batchTargetsMissing(withoutWrite, [
				granular(
					formUuid,
					{
						...operation,
						writes: [{ property: "status", value: value("closed") }],
					},
					{
						operation: "update-write",
						uuid: OPERATION,
						property: "status",
						patch: { value: value("closed") },
					},
				),
			]),
		).toBe(true);

		const withoutLink = structuredClone(doc);
		delete withoutLink.forms[formUuid].caseOperations?.[0]?.links;
		expect(
			batchTargetsMissing(withoutLink, [
				granular(
					formUuid,
					{
						...operation,
						links: [
							{
								identifier: "parent",
								targetType: "household",
								target: null,
								relationship: "extension",
							},
						],
					},
					{
						operation: "update-link",
						uuid: OPERATION,
						identifier: "parent",
						patch: { relationship: "extension" },
					},
				),
			]),
		).toBe(true);
	});

	it("rejects operation/write/link adds whose logical key a peer already added", () => {
		const { doc, formUuid } = fixture();
		const operation = operationIn(doc, formUuid);
		expect(
			batchTargetsMissing(doc, [
				{
					kind: "updateForm",
					uuid: asUuid(formUuid),
					patch: {},
					caseOperationChange: {
						operation: "add",
						value: { ...operation, uuid: OPERATION },
					},
				},
			]),
		).toBe(true);

		const peerWrite = { property: "note", value: value("peer") };
		const withPeerWrite = structuredClone(doc);
		withPeerWrite.forms[formUuid].caseOperations?.[0]?.writes?.push(peerWrite);
		expect(
			batchTargetsMissing(withPeerWrite, [
				granular(
					formUuid,
					{
						...operation,
						writes: [...(operation.writes ?? []), peerWrite],
					},
					{
						operation: "add-write",
						uuid: OPERATION,
						value: peerWrite,
						index: 1,
					},
				),
			]),
		).toBe(true);

		const peerLink = {
			identifier: "household",
			targetType: "household",
			target: null,
			relationship: "child" as const,
		};
		const withPeerLink = structuredClone(doc);
		withPeerLink.forms[formUuid].caseOperations?.[0]?.links?.push(peerLink);
		expect(
			batchTargetsMissing(withPeerLink, [
				granular(
					formUuid,
					{
						...operation,
						links: [...(operation.links ?? []), peerLink],
					},
					{
						operation: "add-link",
						uuid: OPERATION,
						value: peerLink,
						index: 1,
					},
				),
			]),
		).toBe(true);
	});

	// The three rejections above are PEER collisions: the key was already on the
	// stored operation. A collision inside the author's OWN batch is a different
	// fact — an operation born here has never been seen by anyone else, so its
	// keys cannot conflict with a peer. The batch is a command log, not a
	// minimal diff, so creating an operation that carries a link and then
	// configuring that link records both commands; the reducers no-op on the
	// second, and the batch replays to exactly the right document.
	it("accepts a same-key write/link add against an operation born in this batch", () => {
		const { doc, formUuid } = fixture();
		const born: CaseOperation = {
			...operationIn(doc, formUuid),
			uuid: asUuid("55555555-5555-4555-8555-555555555555"),
			id: "born_here",
			writes: [{ property: "note", value: value("hello") }],
			links: [
				{
					identifier: "parent",
					targetType: "household",
					target: null,
					relationship: "child" as const,
				},
			],
		};
		expect(
			batchTargetsMissing(doc, [
				{
					kind: "updateForm",
					uuid: asUuid(formUuid),
					patch: {},
					caseOperationChange: { operation: "add", value: born },
				},
				granular(formUuid, born, {
					operation: "add-write",
					uuid: born.uuid,
					value: { property: "note", value: value("hello") },
					index: 0,
				}),
				granular(formUuid, born, {
					operation: "add-link",
					uuid: born.uuid,
					value: born.links?.[0] as NonNullable<CaseOperation["links"]>[number],
					index: 0,
				}),
			]),
		).toBe(false);
	});

	it("accepts a move whose anchor is only born later in the same batch", () => {
		const { doc, formUuid } = fixture();
		const first = operationIn(doc, formUuid);
		const peer: CaseOperation = {
			...first,
			uuid: asUuid("44444444-4444-4444-8444-444444444444"),
			id: "same_batch_birth",
		};
		const move = (after: ReturnType<typeof asUuid> | null): Mutation => ({
			kind: "updateForm",
			uuid: asUuid(formUuid),
			patch: {},
			caseOperationChange: { operation: "move", uuid: OPERATION, after },
			caseOperationPatch: { operation: "move", uuid: OPERATION, after },
		});

		// A placement named by the uuid it follows cannot be shifted by a peer,
		// so there is no rank to fence: the anchor either survives and the
		// operation lands after it, or it does not and the operation appends.
		// Neither outcome is a phantom conflict.
		expect(
			batchTargetsMissing(doc, [
				move(peer.uuid),
				{
					kind: "updateForm",
					uuid: asUuid(formUuid),
					patch: {},
					caseOperationChange: { operation: "add", value: peer },
				},
			]),
		).toBe(false);

		// The MOVED operation still has to exist — that is a real conflict.
		expect(batchTargetsMissing(doc, [move(null), move(null)])).toBe(false);
	});

	it("advances births, removals, and full replacements across one batch", () => {
		const { doc, formUuid } = fixture();
		const operation = operationIn(doc, formUuid);
		const born: CaseOperation = {
			...operation,
			uuid: OTHER_OPERATION,
			id: "born",
			writes: [{ property: "note", value: value("born") }],
			links: undefined,
		};
		expect(
			batchTargetsMissing(doc, [
				{
					kind: "updateForm",
					uuid: asUuid(formUuid),
					patch: {},
					caseOperationChange: { operation: "add", value: born },
				},
				granular(
					formUuid,
					{ ...born, id: "born_renamed" },
					{
						operation: "update",
						uuid: OTHER_OPERATION,
						patch: { id: "born_renamed" },
					},
				),
			]),
		).toBe(false);

		const replaced = {
			...operation,
			writes: [{ property: "note", value: value("replacement") }],
			links: undefined,
		};
		expect(
			batchTargetsMissing(doc, [
				{
					kind: "updateForm",
					uuid: asUuid(formUuid),
					patch: {},
					caseOperationChange: {
						operation: "update",
						uuid: OPERATION,
						value: replaced,
					},
				},
				granular(
					formUuid,
					{
						...replaced,
						writes: [{ property: "note", value: value("next") }],
					},
					{
						operation: "update-write",
						uuid: OPERATION,
						property: "note",
						patch: { value: value("next") },
					},
				),
			]),
		).toBe(false);
		expect(
			batchTargetsMissing(doc, [
				{
					kind: "updateForm",
					uuid: asUuid(formUuid),
					patch: {},
					caseOperationChange: {
						operation: "update",
						uuid: OPERATION,
						value: replaced,
					},
				},
				granular(formUuid, replaced, {
					operation: "update-write",
					uuid: OPERATION,
					property: "status",
					patch: { value: value("lost") },
				}),
			]),
		).toBe(true);

		expect(
			batchTargetsMissing(doc, [
				granular(
					formUuid,
					{ ...operation, writes: undefined },
					{
						operation: "remove-write",
						uuid: OPERATION,
						property: "status",
					},
				),
				granular(formUuid, operation, {
					operation: "update-write",
					uuid: OPERATION,
					property: "status",
					patch: { value: value("too-late") },
				}),
			]),
		).toBe(true);
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
