import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import {
	type BlueprintDoc,
	type Mutation,
	mutationSchema,
} from "@/lib/doc/types";
import { proseText } from "@/lib/domain";
import { assertAdmittedDoc } from "./admittedDoc";

const M = (key: string) => testUuid(`forms-module-${key}`);
const F = (key: string) => testUuid(`forms-form-${key}`);
const Q = (key: string) => testUuid(`forms-question-${key}`);
function fixture(): BlueprintDoc {
	const doc = buildDoc({
		modules: ["a", "b"].map((module) => ({
			uuid: M(module),
			name: `Module ${module}`,
			forms: ["1", "2"].map((number) => {
				const key = module + number;
				return {
					uuid: F(key),
					name: `Form ${key}`,
					type: "survey",
					fields: [
						f({
							uuid: Q(key),
							kind: "group",
							id: "group",
							children: [
								f({
									uuid: Q(`${key}-child`),
									kind: "text",
									id: "notes",
									label: proseText("Notes"),
								}),
							],
						}),
					],
				};
			}),
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
describe("form membership and content edits", () => {
	it("births a complete form at its authored anchor and leaves the prior document unchanged", () => {
		const before = fixture();
		const next = commit(before, [
			{
				kind: "addForm",
				moduleUuid: M("a"),
				after: F("a1"),
				form: { uuid: F("born"), id: "born", name: "Born", type: "survey" },
			},
			{
				kind: "addField",
				parentUuid: F("born"),
				field: {
					uuid: Q("born"),
					id: "notes",
					kind: "text",
					label: proseText("Notes"),
				},
			},
		]);
		expect(next.formOrder[M("a")]).toEqual([F("a1"), F("born"), F("a2")]);
		expect(next.fieldOrder[F("born")]).toEqual([Q("born")]);
		expect(next.forms[F("born")]).toMatchObject({ id: "born", name: "Born" });
		expect(before.forms[F("born")]).toBeUndefined();
	});
	it("removes a form and its complete nested field topology while retaining its sibling", () => {
		const next = commit(fixture(), [{ kind: "removeForm", uuid: F("a1") }]);
		expect(next.formOrder[M("a")]).toEqual([F("a2")]);
		expect(next.forms[F("a1")]).toBeUndefined();
		expect(next.fieldOrder[F("a1")]).toBeUndefined();
		for (const uuid of [Q("a1"), Q("a1-child")]) {
			expect(next.fields[uuid]).toBeUndefined();
			expect(next.fieldParent[uuid]).toBeUndefined();
			expect(next.fieldOrder[uuid]).toBeUndefined();
		}
		expect(next.fields[Q("a2-child")]).toBeDefined();
	});
	it("reorders within a module and moves across modules without losing the field tree", () => {
		const before = fixture();
		const reordered = commit(before, [
			{ kind: "moveForm", uuid: F("a1"), toModuleUuid: M("a"), after: F("a2") },
		]);
		expect(reordered.formOrder[M("a")]).toEqual([F("a2"), F("a1")]);
		const moved = commit(reordered, [
			{ kind: "moveForm", uuid: F("a1"), toModuleUuid: M("b"), after: null },
		]);
		expect(moved.formOrder[M("a")]).toEqual([F("a2")]);
		expect(moved.formOrder[M("b")]).toEqual([F("a1"), F("b1"), F("b2")]);
		expect(moved.fields[Q("a1-child")]).toEqual(before.fields[Q("a1-child")]);
		expect(moved.fieldParent[Q("a1-child")]).toBe(Q("a1"));
	});
	it("keeps semantic form id and field contents when display name and purpose change", () => {
		const before = fixture();
		const next = commit(before, [
			{ kind: "renameForm", uuid: F("a1"), newId: "Renamed" },
			{
				kind: "updateForm",
				uuid: F("a1"),
				patch: { purpose: "Collect follow-up notes" },
			},
		]);
		expect(next.forms[F("a1")]).toEqual({
			...before.forms[F("a1")],
			name: "Renamed",
			purpose: "Collect follow-up notes",
		});
		expect(next.fields).toEqual(before.fields);
	});
	it.each(["missing-destination", "missing-form", "missing-anchor"] as const)(
		"refuses %s and leaves unguarded stale replay intact",
		(scenario) => {
			const before = fixture();
			const mutation: Mutation = {
				kind: "moveForm",
				uuid: scenario === "missing-form" ? F("gone") : F("a1"),
				toModuleUuid: scenario === "missing-destination" ? M("gone") : M("b"),
				after: scenario === "missing-anchor" ? F("gone") : null,
			};
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
	it.each(["deleted-module", "deleted-anchor"] as const)(
		"refuses stale form birth against %s without materializing an orphan",
		(scenario) => {
			const before = fixture();
			const mutation: Mutation = {
				kind: "addForm",
				moduleUuid: scenario === "deleted-module" ? M("gone") : M("a"),
				after: F("gone"),
				form: { uuid: F("born"), id: "born", name: "Born", type: "survey" },
			};
			expect(
				mutationCommitVerdict(before, [mutation], LOOKUP_CONTEXT_UNAVAILABLE)
					.ok,
			).toBe(false);
			expect(
				toPersistableDoc(
					produce(before, (draft) => {
						applyMutations(draft, [mutation]);
					}),
				),
			).toEqual(toPersistableDoc(before));
		},
	);
});

describe("first case-operation collection member", () => {
	it("appends the first write and link when the optional anchor is omitted", () => {
		const operationUuid = testUuid("first-operation-members");
		const before = commit(fixture(), [
			{ kind: "declareCaseType", caseType: "patient" },
			{ kind: "declareCaseType", caseType: "household" },
			{
				kind: "setCaseTypeMeta",
				caseType: "patient",
				parent_type: "household",
				relationship: "child",
			},
			{
				kind: "addCaseProperty",
				caseType: "patient",
				property: { name: "note", label: proseText("Note"), data_type: "text" },
			},
			{
				kind: "updateForm",
				uuid: F("a1"),
				patch: {},
				caseOperationChange: {
					operation: "add",
					value: {
						uuid: operationUuid,
						id: "update_patient",
						action: "update",
						caseType: "patient",
						target: {
							kind: "expression",
							expr: {
								kind: "term",
								term: { kind: "literal", value: "patient-id" },
							},
						},
						owner: {
							kind: "term",
							term: { kind: "literal", value: "owner-id" },
						},
					},
				},
			},
		]);
		const value = {
			kind: "term" as const,
			term: { kind: "literal" as const, value: "Edited" },
		};
		const link = {
			identifier: "parent",
			targetType: "household",
			relationship: "child" as const,
			target: {
				kind: "expression" as const,
				expr: {
					kind: "term" as const,
					term: { kind: "literal" as const, value: "household-id" },
				},
			},
		};
		const next = commit(before, [
			{
				kind: "updateForm",
				uuid: F("a1"),
				patch: {},
				caseOperationPatch: {
					operation: "add-write",
					uuid: operationUuid,
					value: { property: "note", value },
				},
			},
			{
				kind: "updateForm",
				uuid: F("a1"),
				patch: {},
				caseOperationPatch: {
					operation: "add-link",
					uuid: operationUuid,
					value: link,
				},
			},
		]);
		expect(next.forms[F("a1")].caseOperations?.[0].writes).toEqual([
			{ property: "note", value },
		]);
		expect(next.forms[F("a1")].caseOperations?.[0].links).toEqual([link]);
	});
});
