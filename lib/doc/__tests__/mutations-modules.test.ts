import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import {
	type BlueprintDoc,
	type Mutation,
	mutationSchema,
} from "@/lib/doc/types";
import { plainColumn, proseText, type Uuid } from "@/lib/domain";
import { assertAdmittedDoc } from "./admittedDoc";

const M = (key: string) => testUuid(`modules-module-${key}`);
const F = (key: string) => testUuid(`modules-form-${key}`);
const Q = (key: string) => testUuid(`modules-field-${key}`);
function fixture(keys = ["a", "c"]): BlueprintDoc {
	const doc = buildDoc({
		modules: keys.map((key) => ({
			uuid: M(key),
			id: `module_${key}`,
			name: key.toUpperCase(),
			forms: [
				{
					uuid: F(key),
					name: `Form ${key}`,
					type: "survey",
					fields: [
						{
							uuid: Q(key),
							kind: "text",
							id: "notes",
							label: proseText("Notes"),
						},
					],
				},
			],
		})),
	});
	assertAdmittedDoc(doc);
	return doc;
}
function commit(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): BlueprintDoc {
	const parsed = mutations.map((mutation) =>
		mutationSchema.parse(JSON.parse(JSON.stringify(mutation))),
	);
	const verdict = mutationCommitVerdict(
		doc,
		parsed,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	return verdict.nextDoc;
}
function birth(
	key: string,
	after?: Uuid | null,
	parentModuleUuid?: Uuid,
): Mutation[] {
	return [
		{
			kind: "addModule",
			module: {
				uuid: M(key),
				id: `module_${key}`,
				name: key.toUpperCase(),
				...(parentModuleUuid === undefined ? {} : { parentModuleUuid }),
			},
			...(after === undefined ? {} : { after }),
		},
		{
			kind: "addForm",
			moduleUuid: M(key),
			form: {
				uuid: F(key),
				id: `form_${key}`,
				name: `Form ${key}`,
				type: "survey",
			},
		},
		{
			kind: "addField",
			parentUuid: F(key),
			field: {
				uuid: Q(key),
				id: "notes",
				kind: "text",
				label: proseText("Notes"),
			},
		},
	];
}
function nested(): BlueprintDoc {
	return commit(fixture(), [
		...birth("b", null, M("a")),
		...birth("d", null, M("c")),
	]);
}
describe("module topology", () => {
	it.each([undefined, null, M("a")] as const)(
		"births a complete module at anchor %s",
		(after) => {
			const before = fixture();
			const next = commit(before, birth("b", after));
			expect(next.moduleOrder).toEqual(
				after === undefined
					? [M("a"), M("c"), M("b")]
					: after === null
						? [M("b"), M("a"), M("c")]
						: [M("a"), M("b"), M("c")],
			);
			expect(next.formOrder[M("b")]).toEqual([F("b")]);
			expect(next.fieldOrder[F("b")]).toEqual([Q("b")]);
			expect(before.modules[M("b")]).toBeUndefined();
		},
	);
	it("cascades module removal through form and field identities and orders", () => {
		const next = commit(fixture(), [{ kind: "removeModule", uuid: M("a") }]);
		expect(next.moduleOrder).toEqual([M("c")]);
		expect(next.modules[M("a")]).toBeUndefined();
		expect(next.formOrder[M("a")]).toBeUndefined();
		expect(next.forms[F("a")]).toBeUndefined();
		expect(next.fieldOrder[F("a")]).toBeUndefined();
		expect(next.fields[Q("a")]).toBeUndefined();
		expect(next.fieldParent[Q("a")]).toBeUndefined();
		expect(next.fields[Q("c")]).toBeDefined();
	});
	it("refuses a parent removal until children leave and then removes that subtree in order", () => {
		const before = nested();
		expect(before.moduleOrder).toEqual([M("a"), M("b"), M("c"), M("d")]);
		expect(
			mutationCommitVerdict(
				before,
				[{ kind: "removeModule", uuid: M("a") }],
				LOOKUP_CONTEXT_UNAVAILABLE,
			).ok,
		).toBe(false);
		expect(
			toPersistableDoc(
				produce(before, (draft) => {
					applyMutations(draft, [{ kind: "removeModule", uuid: M("a") }]);
				}),
			),
		).toEqual(toPersistableDoc(before));
		expect(
			commit(before, [
				{ kind: "removeModule", uuid: M("b") },
				{ kind: "removeModule", uuid: M("a") },
			]).moduleOrder,
		).toEqual([M("c"), M("d")]);
	});
	it("moves a root together with its child block", () => {
		expect(
			commit(nested(), [{ kind: "moveModule", uuid: M("a"), after: M("c") }])
				.moduleOrder,
		).toEqual([M("c"), M("d"), M("a"), M("b")]);
	});
	it("distinguishes preserved parentage, promotion to root and explicit reparenting", () => {
		const before = nested();
		const preserved = commit(before, [
			{ kind: "moveModule", uuid: M("b"), after: null },
		]);
		expect(preserved.modules[M("b")].parentModuleUuid).toBe(M("a"));
		const promoted = commit(before, [
			{
				kind: "moveModule",
				uuid: M("b"),
				parentModuleUuid: null,
				after: M("c"),
			},
		]);
		expect(Object.hasOwn(promoted.modules[M("b")], "parentModuleUuid")).toBe(
			false,
		);
		expect(promoted.moduleOrder).toEqual([M("a"), M("c"), M("d"), M("b")]);
		const reparented = commit(before, [
			{
				kind: "moveModule",
				uuid: M("b"),
				parentModuleUuid: M("c"),
				after: M("d"),
			},
		]);
		expect(reparented.modules[M("b")].parentModuleUuid).toBe(M("c"));
		expect(reparented.moduleOrder).toEqual([M("a"), M("c"), M("d"), M("b")]);
	});
	it("preserves fresh parentage when a stale narrow reorder arrives", () => {
		const peer = commit(nested(), [
			{
				kind: "moveModule",
				uuid: M("b"),
				parentModuleUuid: M("c"),
				after: M("d"),
			},
		]);
		const merged = commit(peer, [
			{ kind: "moveModule", uuid: M("b"), after: null },
		]);
		expect(merged.modules[M("b")].parentModuleUuid).toBe(M("c"));
		expect(merged.moduleOrder).toEqual([M("a"), M("c"), M("b"), M("d")]);
	});
	it("changes display name and purpose while preserving semantic module id and descendants", () => {
		const before = fixture();
		const next = commit(before, [
			{ kind: "renameModule", uuid: M("a"), newId: "Renamed" },
			{
				kind: "updateModule",
				uuid: M("a"),
				patch: { purpose: "Record visits" },
			},
		]);
		expect(next.modules[M("a")]).toEqual({
			...before.modules[M("a")],
			name: "Renamed",
			purpose: "Record visits",
		});
		expect(next.forms).toEqual(before.forms);
	});
	it.each<Mutation>([
		{ kind: "moveModule", uuid: M("a"), after: M("gone") },
		{ kind: "moveModule", uuid: M("gone"), after: null },
		{ kind: "renameModule", uuid: M("gone"), newId: "New" },
		{ kind: "updateModule", uuid: M("gone"), patch: { purpose: "Missing" } },
	])(
		"refuses a stale target and keeps unguarded replay unchanged: $kind",
		(mutation) => {
			const before = fixture();
			expect(
				mutationCommitVerdict(before, [mutation], LOOKUP_CONTEXT_UNAVAILABLE)
					.ok,
			).toBe(false);
			const replayed = produce(before, (draft) => {
				applyMutations(draft, [mutation]);
			});
			expect(toPersistableDoc(replayed)).toEqual(toPersistableDoc(before));
		},
	);
});
describe("case-list birth and independent screen sequences", () => {
	function viewer() {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "age", label: proseText("Age"), data_type: "int" },
						{ name: "village", label: proseText("Village"), data_type: "text" },
					],
				},
			],
			modules: [
				{
					uuid: M("a"),
					name: "Patients",
					caseType: "patient",
					caseListOnly: true,
					caseListConfig: {
						columns: [
							plainColumn(Q("name"), "case_name", "Name"),
							plainColumn(Q("age"), "age", "Age"),
						],
						listColumnOrder: [Q("name"), Q("age")],
						detailColumnOrder: [Q("age"), Q("name")],
						searchInputs: [],
					},
				},
			],
		});
		assertAdmittedDoc(doc);
		return doc;
	}
	it("ensures a config in the same batch as its type and first column", () => {
		const next = commit(fixture(), [
			{ kind: "declareCaseType", caseType: "patient" },
			{
				kind: "updateModule",
				uuid: M("a"),
				patch: { caseType: "patient" },
				ensureCaseListConfig: true,
			},
			{
				kind: "addColumn",
				moduleUuid: M("a"),
				column: plainColumn(Q("name"), "case_name", "Name"),
				afterInList: null,
				afterInDetail: null,
			},
		]);
		expect(next.modules[M("a")].caseListConfig).toEqual({
			columns: [plainColumn(Q("name"), "case_name", "Name")],
			listColumnOrder: [Q("name")],
			detailColumnOrder: [Q("name")],
			searchInputs: [],
		});
	});
	it("leaves an existing peer-populated config intact on ensure", () => {
		const before = viewer();
		const next = commit(before, [
			{
				kind: "updateModule",
				uuid: M("a"),
				patch: {},
				ensureCaseListConfig: true,
			},
		]);
		expect(next.modules[M("a")].caseListConfig).toEqual(
			before.modules[M("a")].caseListConfig,
		);
	});
	it("adds to each screen at its separate anchor and removes from both", () => {
		const before = viewer();
		const next = commit(before, [
			{
				kind: "addColumn",
				moduleUuid: M("a"),
				column: plainColumn(Q("village"), "village", "Village"),
				afterInList: null,
				afterInDetail: Q("age"),
			},
		]);
		expect(next.modules[M("a")].caseListConfig?.listColumnOrder).toEqual([
			Q("village"),
			Q("name"),
			Q("age"),
		]);
		expect(next.modules[M("a")].caseListConfig?.detailColumnOrder).toEqual([
			Q("age"),
			Q("village"),
			Q("name"),
		]);
		const removed = commit(next, [
			{ kind: "removeColumn", moduleUuid: M("a"), uuid: Q("age") },
		]);
		expect(
			removed.modules[M("a")].caseListConfig?.columns.map(
				(column) => column.uuid,
			),
		).toEqual([Q("name"), Q("village")]);
		expect(removed.modules[M("a")].caseListConfig?.listColumnOrder).toEqual([
			Q("village"),
			Q("name"),
		]);
		expect(removed.modules[M("a")].caseListConfig?.detailColumnOrder).toEqual([
			Q("village"),
			Q("name"),
		]);
	});
});
