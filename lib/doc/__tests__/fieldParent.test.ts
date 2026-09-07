import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { duplicateFieldMutations } from "@/lib/doc/duplicateFieldMutations";
import { rebuildFieldParent, toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { Mutation } from "@/lib/doc/types";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedDoc } from "./admittedDoc";

const M1 = testUuid("module-one");
const M2 = testUuid("module-two");
const F1 = testUuid("form-one");
const F2 = testUuid("form-two");
const F3 = testUuid("form-three");
const A = testUuid("field-a");
const B = testUuid("field-b");
const C = testUuid("field-c");
const GROUP = testUuid("group");
const GROUP2 = testUuid("group-two");
const REPEAT = testUuid("repeat");
const NESTED = testUuid("nested");
const NEW = testUuid("new-field");
const initialParents = {
	[A]: F1,
	[GROUP]: F1,
	[GROUP2]: F1,
	[REPEAT]: GROUP,
	[NESTED]: REPEAT,
	[B]: F2,
	[C]: F3,
};

function fixture(): BlueprintDoc {
	const doc = buildDoc({
		modules: [
			{
				uuid: M1,
				name: "One",
				forms: [
					{
						uuid: F1,
						name: "First",
						type: "survey",
						fields: [
							f({ uuid: A, kind: "text", id: "a" }),
							f({
								uuid: GROUP,
								kind: "group",
								id: "group",
								children: [
									f({
										uuid: REPEAT,
										kind: "repeat",
										id: "repeat",
										children: [f({ uuid: NESTED, kind: "text", id: "nested" })],
									}),
								],
							}),
							f({ uuid: GROUP2, kind: "group", id: "group_two", children: [] }),
						],
					},
					{
						uuid: F2,
						name: "Second",
						type: "survey",
						fields: [f({ uuid: B, kind: "text", id: "b" })],
					},
				],
			},
			{
				uuid: M2,
				name: "Two",
				forms: [
					{
						uuid: F3,
						name: "Third",
						type: "survey",
						fields: [f({ uuid: C, kind: "text", id: "c" })],
					},
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	expect(doc.fieldParent).toEqual(initialParents);
	return doc;
}

function apply(doc: BlueprintDoc, mutations: Mutation[]): BlueprintDoc {
	const verdict = mutationCommitVerdict(
		doc,
		mutations,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok, JSON.stringify(verdict.ok ? [] : verdict.findings)).toBe(
		true,
	);
	if (!verdict.ok)
		throw new Error(JSON.stringify(verdict.ok ? [] : verdict.findings));
	const store = createBlueprintDocStore();
	store.getState().load(toPersistableDoc(doc));
	store.getState().applyMany(mutations);
	const next = store.getState();
	assertAdmittedDoc(next);
	return next;
}

function without(...uuids: string[]): Record<string, string> {
	return Object.fromEntries(
		Object.entries(initialParents).filter(([uuid]) => !uuids.includes(uuid)),
	);
}

describe("derived field parents across actual store transitions", () => {
	it.each([F1, GROUP, REPEAT])(
		"records the named parent for a new field under %s",
		(parentUuid) => {
			const next = apply(fixture(), [
				{
					kind: "addField",
					parentUuid,
					field: {
						uuid: NEW,
						kind: "text",
						id: "new_field",
						label: proseText("New field"),
					},
				},
			]);
			expect(next.fieldParent).toEqual({
				...initialParents,
				[NEW]: parentUuid,
			});
		},
	);

	it.each([F1, GROUP, GROUP2])(
		"moves a nested leaf to %s without changing other parent identities",
		(toParentUuid) => {
			const next = apply(fixture(), [
				{ kind: "moveField", uuid: NESTED, toParentUuid, after: null },
			]);
			expect(next.fieldParent).toEqual({
				...initialParents,
				[NESTED]: toParentUuid,
			});
			expect(next.fieldOrder[REPEAT]).toEqual([]);
		},
	);

	it("moves a subtree under another group while retaining its internal parentage", () => {
		const next = apply(fixture(), [
			{ kind: "moveField", uuid: GROUP, toParentUuid: GROUP2, after: null },
		]);
		expect(next.fieldParent).toEqual({ ...initialParents, [GROUP]: GROUP2 });
		expect(next.fieldOrder[F1]).toEqual([A, GROUP2]);
		expect(next.fieldOrder[GROUP2]).toEqual([GROUP]);
	});

	it.each([
		{
			name: "leaf",
			mutations: [{ kind: "removeField", uuid: NESTED }],
			absent: [NESTED],
		},
		{
			name: "subtree",
			mutations: [{ kind: "removeField", uuid: GROUP }],
			absent: [GROUP, REPEAT, NESTED],
		},
		{
			name: "form",
			mutations: [{ kind: "removeForm", uuid: F1 }],
			absent: [A, GROUP, GROUP2, REPEAT, NESTED],
		},
		{
			name: "module",
			mutations: [{ kind: "removeModule", uuid: M1 }],
			absent: [A, GROUP, GROUP2, REPEAT, NESTED, B],
		},
	] satisfies { name: string; mutations: Mutation[]; absent: string[] }[])(
		"removes every derived entry owned by a deleted $name",
		({ mutations, absent }) => {
			const next = apply(fixture(), mutations);
			expect(next.fieldParent).toEqual(without(...absent));
			for (const uuid of absent)
				expect(Object.hasOwn(next.fields, uuid)).toBe(false);
		},
	);

	it("derives only the final tree after moving a child out of a deleted subtree in one batch", () => {
		const next = apply(fixture(), [
			{ kind: "moveField", uuid: NESTED, toParentUuid: F1, after: A },
			{ kind: "removeField", uuid: GROUP },
		]);
		expect(next.fieldParent).toEqual({
			...without(GROUP, REPEAT),
			[NESTED]: F1,
		});
	});

	it("gives a duplicated subtree fresh identities and the expected new parent chain", () => {
		const doc = fixture();
		const plan = duplicateFieldMutations(doc, GROUP);
		if (plan === undefined) throw new Error("duplicate plan missing");
		const next = apply(doc, plan.mutations);
		const [repeatClone] = next.fieldOrder[plan.cloneUuid];
		const [leafClone] = next.fieldOrder[repeatClone];
		expect(
			new Set([plan.cloneUuid, repeatClone, leafClone, GROUP, REPEAT, NESTED])
				.size,
		).toBe(6);
		expect(next.fieldParent).toEqual({
			...initialParents,
			[plan.cloneUuid]: F1,
			[repeatClone]: plan.cloneUuid,
			[leafClone]: repeatClone,
		});
		expect(next.fieldOrder[F1]).toEqual([A, GROUP, plan.cloneUuid, GROUP2]);
	});

	it("retains the derived index by identity for scalar edits and form moves", () => {
		const store = createBlueprintDocStore();
		store.getState().load(toPersistableDoc(fixture()));
		const parents = store.getState().fieldParent;
		const edits: Mutation[] = [
			{
				kind: "updateField",
				uuid: A,
				targetKind: "text",
				patch: { id: "renamed", label: proseText("Renamed") },
			},
			{ kind: "moveForm", uuid: F1, toModuleUuid: M2, after: F3 },
		];
		expect(
			mutationCommitVerdict(store.getState(), edits, LOOKUP_CONTEXT_UNAVAILABLE)
				.ok,
		).toBe(true);
		store.getState().applyMany(edits);
		expect(store.getState().fieldParent).toBe(parents);
		expect(store.getState().fieldParent).toEqual(initialParents);
	});

	it("loads the persisted nested tree and excludes derived and transient fields from persistence", () => {
		const store = createBlueprintDocStore();
		const persisted = toPersistableDoc(fixture());
		expect(Object.hasOwn(persisted, "fieldParent")).toBe(false);
		expect(Object.hasOwn(persisted, "refIndex")).toBe(false);
		store.getState().load(persisted);
		expect(store.getState().fieldParent).toEqual(initialParents);
		expect(toPersistableDoc(store.getState())).toEqual(persisted);
		expect(Object.hasOwn(toPersistableDoc(store.getState()), "applyMany")).toBe(
			false,
		);
	});

	it("omits an own undefined top-level clear marker", () => {
		const doc = fixture();
		Object.defineProperty(doc, "logo", { value: undefined, enumerable: true });
		expect(Object.hasOwn(doc, "logo")).toBe(true);
		expect(Object.hasOwn(toPersistableDoc(doc), "logo")).toBe(false);
	});

	it("refuses malformed duplicate parentage without publishing a partial derived index", () => {
		const doc = fixture();
		const before = doc.fieldParent;
		doc.fieldOrder[F2].push(A);
		expect(() => rebuildFieldParent(doc)).toThrow(/invalid blueprint topology/);
		expect(doc.fieldParent).toBe(before);
	});
});
