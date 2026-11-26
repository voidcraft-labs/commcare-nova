import { produce } from "immer";
import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { duplicateFieldMutations } from "@/lib/doc/duplicateFieldMutations";
import { projectFormExpression } from "@/lib/doc/expressionText";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { withIdentityMoves } from "@/lib/doc/identityMoves";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import {
	type BlueprintDoc,
	type Mutation,
	mutationSchema,
} from "@/lib/doc/types";
import { expressionAt, proseText } from "@/lib/domain";
import {
	formField,
	literal,
	matchAll,
	term,
} from "@/lib/domain/expression/builders";
import { submissionLayout } from "@/lib/domain/submissionLayout";
import { assertAdmittedDoc } from "./admittedDoc";
import { holdFixture } from "./placementHoldFixture";

const M = testUuid("fields-module");
const F = testUuid("fields-form");
const Q = (key: string) => testUuid(`fields-${key}`);
const textField = (key: string) => ({
	uuid: Q(key),
	id: key,
	kind: "text" as const,
	label: proseText(key),
});
function fixture(): BlueprintDoc {
	const doc = buildDoc({
		modules: [
			{
				uuid: M,
				name: "Survey",
				forms: [
					{
						uuid: F,
						name: "Collect",
						type: "survey",
						fields: [
							f(textField("a")),
							f(textField("b")),
							f({
								uuid: Q("group"),
								id: "group",
								kind: "group",
								label: proseText("Group"),
								children: [f(textField("child"))],
							}),
						],
					},
				],
			},
		],
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
function replay(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): BlueprintDoc {
	return produce(doc, (draft) => {
		applyMutations(draft, mutations);
	});
}
function calculatedText(doc: BlueprintDoc): string {
	const slot = {
		entity: "field",
		uuid: Q("computed"),
		slot: "calculate",
	} as const;
	const expression = expressionAt(doc, slot);
	if (expression === undefined)
		throw new Error("Expected the stored calculation.");
	const projection = projectFormExpression(
		doc,
		slot,
		expression,
		"unavailable",
	);
	expect(projection.unresolved).toEqual([]);
	return projection.text;
}
describe("field topology and identity", () => {
	it("states the submitted row change in both directions and follows the same row on a rename", () => {
		const { doc, formUuid } = holdFixture();
		doc.forms[formUuid].dataRootName = "visit";
		const repeat = Object.values(doc.fields).find(
			(field) => field.kind === "repeat" && field.id === "visits",
		);
		const child = Object.values(doc.fields).find(
			(field) => field.id === "visit_note",
		);
		if (
			repeat?.kind !== "repeat" ||
			repeat.repeat_mode !== "query_bound" ||
			!child
		)
			throw new Error("Expected the visits repeat and note.");
		doc.publishedQuestions = [repeat.uuid, child.uuid];
		const remove: Mutation = {
			kind: "updateField",
			uuid: repeat.uuid,
			targetKind: "repeat",
			patch: { repeat_mode: "user_controlled" },
		};
		const toQuery: Mutation = {
			kind: "updateField",
			uuid: repeat.uuid,
			targetKind: "repeat",
			patch: { repeat_mode: "query_bound", data_source: repeat.data_source },
		};
		const controlled = commit(doc, [remove]);
		const expected = (from: string, to: string) => [
			{
				subject: {
					kind: "submitted-question",
					formUuid,
					fieldUuid: child.uuid,
				},
				from: { answerPath: from },
				to: { answerPath: to },
				reason: { source: "submitted-question" },
			},
		];
		const flat = "/visit/visits/visit_note";
		const row = "/visit/visits/item/visit_note";
		expect(withIdentityMoves(doc, [remove]).moves).toEqual(expected(row, flat));
		expect(
			withIdentityMoves(doc, [
				{ kind: "convertField", uuid: repeat.uuid, toKind: "group" },
			]).moves,
		).toEqual(expected(row, flat));
		expect(withIdentityMoves(controlled, [toQuery]).moves).toEqual(
			expected(flat, row),
		);
		expect(
			withIdentityMoves(doc, [
				{
					kind: "updateField",
					uuid: child.uuid,
					targetKind: "text",
					patch: { id: "comment" },
				},
			]).moves,
		).toEqual(expected(row, "/visit/visits/item/comment"));
	});

	it("names each published answer whose address changes and keeps screen-only edits quiet", () => {
		const fresh = fixture();
		const doc = { ...fresh, publishedQuestions: [Q("group"), Q("child")] };
		const rename: Mutation = {
			kind: "updateField",
			uuid: Q("group"),
			targetKind: "group",
			patch: { id: "member" },
		};
		expect(withIdentityMoves(fresh, [rename]).moves).toEqual([]);
		expect(
			withIdentityMoves(doc, [rename]).moves.map((move) => [
				move.subject,
				move.from,
				move.to,
			]),
		).toEqual([
			[
				{ kind: "submitted-question", formUuid: F, fieldUuid: Q("group") },
				{ answerPath: "/data/group" },
				{ answerPath: "/data/member" },
			],
			[
				{ kind: "submitted-question", formUuid: F, fieldUuid: Q("child") },
				{ answerPath: "/data/group/child" },
				{ answerPath: "/data/member/child" },
			],
		]);
		const rootMoves = withIdentityMoves(doc, [
			{ kind: "updateForm", uuid: F, patch: { dataRootName: "visit" } },
		]).moves;
		expect(rootMoves.map(({ from, to }) => [from, to])).toEqual([
			[{ answerPath: "/data/group" }, { answerPath: "/visit/group" }],
			[
				{ answerPath: "/data/group/child" },
				{ answerPath: "/visit/group/child" },
			],
		]);
		const move: Mutation = {
			kind: "moveField",
			where: "screen",
			uuid: Q("child"),
			toParentUuid: F,
			after: Q("b"),
		};
		expect(withIdentityMoves(doc, [move]).moves).toEqual([]);
		expect(
			withIdentityMoves(commit(doc, [move]), [
				{ ...move, where: "submission", after: null },
			]).moves.map((m) => m.to),
		).toEqual([{ answerPath: "/data/child" }]);
	});

	it("inserts at named, first and append anchors under both forms and groups", () => {
		const next = commit(fixture(), [
			{
				kind: "addField",
				parentUuid: F,
				after: Q("a"),
				field: textField("middle"),
			},
			{
				kind: "addField",
				parentUuid: Q("group"),
				after: null,
				field: textField("first"),
			},
			{ kind: "addField", parentUuid: Q("group"), field: textField("last") },
		]);
		expect(next.fieldOrder[F]).toEqual([
			Q("a"),
			Q("middle"),
			Q("b"),
			Q("group"),
		]);
		expect(next.fieldOrder[Q("group")]).toEqual([
			Q("first"),
			Q("child"),
			Q("last"),
		]);
		expect(next.fieldParent[Q("middle")]).toBe(F);
		expect(next.fieldParent[Q("last")]).toBe(Q("group"));
	});
	it("reorders and reparents the same UUID while expression text follows its current address", () => {
		const before = commit(fixture(), [
			{
				kind: "addField",
				parentUuid: F,
				field: {
					uuid: Q("computed"),
					id: "computed",
					kind: "hidden",
					calculate: term({ ...formField(Q("a")), spelling: "absolute" }),
				},
			},
		]);
		const moved = commit(before, [
			{
				kind: "moveField",
				uuid: Q("a"),
				toParentUuid: Q("group"),
				after: Q("child"),
			},
		]);
		expect(moved.fieldOrder[F]).toEqual([Q("b"), Q("group"), Q("computed")]);
		expect(moved.fieldOrder[Q("group")]).toEqual([Q("child"), Q("a")]);
		expect(calculatedText(moved)).toBe("/data/group/a");
		const renamed = commit(moved, [
			{
				kind: "updateField",
				uuid: Q("a"),
				targetKind: "text",
				patch: { id: "primary" },
			},
		]);
		expect(calculatedText(renamed)).toBe("/data/group/primary");
		const reordered = commit(renamed, [
			{
				kind: "moveField",
				uuid: Q("a"),
				toParentUuid: Q("group"),
				after: null,
			},
		]);
		expect(reordered.fieldOrder[Q("group")]).toEqual([Q("a"), Q("child")]);
	});
	it("refuses a sibling id collision instead of silently renaming the moved field", () => {
		const before = commit(fixture(), [
			{
				kind: "updateField",
				uuid: Q("child"),
				targetKind: "text",
				patch: { id: "a" },
			},
		]);
		expect(
			mutationCommitVerdict(
				before,
				[
					{
						kind: "moveField",
						uuid: Q("a"),
						toParentUuid: Q("group"),
						after: null,
					},
				],
				LOOKUP_CONTEXT_UNAVAILABLE,
			).ok,
		).toBe(false);
		expect(before.fields[Q("a")].id).toBe("a");
	});
	it("deletes the whole subtree and reverse index while leaving siblings reachable", () => {
		const next = commit(fixture(), [{ kind: "removeField", uuid: Q("group") }]);
		expect(next.fieldOrder[F]).toEqual([Q("a"), Q("b")]);
		for (const uuid of [Q("group"), Q("child")]) {
			expect(next.fields[uuid]).toBeUndefined();
			expect(next.fieldParent[uuid]).toBeUndefined();
			expect(next.fieldOrder[uuid]).toBeUndefined();
		}
	});
	it.each(["missing-parent", "leaf-parent", "missing-anchor"] as const)(
		"rejects birth against %s and stale replay cannot create an orphan",
		(scenario) => {
			const before = fixture();
			const mutation: Mutation = {
				kind: "addField",
				parentUuid:
					scenario === "missing-parent"
						? Q("gone")
						: scenario === "leaf-parent"
							? Q("a")
							: F,
				after: scenario === "missing-anchor" ? Q("gone") : null,
				field: textField("born"),
			};
			expect(
				mutationCommitVerdict(before, [mutation], LOOKUP_CONTEXT_UNAVAILABLE)
					.ok,
			).toBe(false);
			expect(toPersistableDoc(replay(before, [mutation]))).toEqual(
				toPersistableDoc(before),
			);
		},
	);
	it("does not detach a moved field when its destination anchor has disappeared", () => {
		const before = fixture();
		const mutation: Mutation = {
			kind: "moveField",
			uuid: Q("a"),
			toParentUuid: Q("group"),
			after: Q("gone"),
		};
		expect(
			mutationCommitVerdict(before, [mutation], LOOKUP_CONTEXT_UNAVAILABLE).ok,
		).toBe(false);
		expect(toPersistableDoc(replay(before, [mutation]))).toEqual(
			toPersistableDoc(before),
		);
	});
	it.each(["remove", "update", "move"] as const)(
		"replays a stale %s target without manufacturing it",
		(action) => {
			const before = fixture();
			const mutation: Mutation =
				action === "remove"
					? { kind: "removeField", uuid: Q("gone") }
					: action === "update"
						? {
								kind: "updateField",
								uuid: Q("gone"),
								targetKind: "text",
								patch: { id: "renamed" },
							}
						: {
								kind: "moveField",
								uuid: Q("gone"),
								toParentUuid: F,
								after: null,
							};
			expect(toPersistableDoc(replay(before, [mutation]))).toEqual(
				toPersistableDoc(before),
			);
		},
	);
	it("duplicates a leaf and an entire container with fresh identities and exact sibling placement", () => {
		const before = fixture();
		const leafPlan = duplicateFieldMutations(before, Q("a"));
		if (!leafPlan) throw new Error("Expected leaf duplicate plan");
		const leaf = commit(before, leafPlan.mutations);
		expect(leaf.fieldOrder[F]).toEqual([
			Q("a"),
			leafPlan.cloneUuid,
			Q("b"),
			Q("group"),
		]);
		expect(leaf.fields[leafPlan.cloneUuid]).toMatchObject({
			id: "a_2",
			kind: "text",
		});
		const groupPlan = duplicateFieldMutations(leaf, Q("group"));
		if (!groupPlan) throw new Error("Expected group duplicate plan");
		const next = commit(leaf, groupPlan.mutations);
		const children = next.fieldOrder[groupPlan.cloneUuid];
		expect(children).toHaveLength(1);
		expect(children[0]).not.toBe(Q("child"));
		expect(next.fields[children[0]]).toMatchObject({
			id: "child",
			kind: "text",
		});
		expect(next.fieldParent[children[0]]).toBe(groupPlan.cloneUuid);
		expect(duplicateFieldMutations(next, Q("gone"))).toBeUndefined();
	});
	it("carries ordinary answers on screen moves and keeps explicitly placed answers in their groups", () => {
		const source = commit(fixture(), [
			{
				kind: "moveField",
				uuid: Q("a"),
				where: "submission",
				toParentUuid: Q("group"),
				after: null,
			},
		]);
		expect(
			submissionLayout(F, source.fields, source.fieldOrder).children.get(
				Q("group"),
			),
		).toEqual([Q("child"), Q("a")]);
		const moved = commit(source, [
			{ kind: "moveField", uuid: Q("child"), toParentUuid: F, after: Q("b") },
		]);
		expect(
			submissionLayout(F, moved.fields, moved.fieldOrder).children.get(
				Q("group"),
			),
		).toEqual([Q("a")]);
		expect(
			submissionLayout(F, moved.fields, moved.fieldOrder).children.get(F),
		).toEqual([Q("b"), Q("child"), Q("group")]);
		const together = commit(moved, [
			{
				kind: "moveField",
				uuid: Q("a"),
				toParentUuid: Q("group"),
				after: null,
			},
		]);
		expect(together.fields[Q("a")].submissionPlacement).toBeUndefined();
		expect(
			submissionLayout(F, together.fields, together.fieldOrder).children.get(
				Q("group"),
			),
		).toEqual([Q("a")]);
	});

	it("refuses to place a grouped question's answer at the form root", () => {
		const verdict = mutationCommitVerdict(
			fixture(),
			[
				{
					kind: "moveField",
					uuid: Q("child"),
					where: "submission",
					toParentUuid: F,
					after: null,
				},
			],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(
			verdict.ok ? [] : verdict.findings.map((finding) => finding.code),
		).toContain("FIELD_SUBMISSION_PLACEMENT");
	});

	it("duplicates a screen while keeping its explicitly placed answer under the same external group", () => {
		const source = commit(fixture(), [
			{
				kind: "addField",
				parentUuid: F,
				field: {
					uuid: Q("receiving"),
					id: "receiving",
					kind: "group",
					label: proseText("Receiving"),
				},
			},
			{
				kind: "moveField",
				uuid: Q("child"),
				where: "submission",
				toParentUuid: Q("receiving"),
				after: null,
			},
		]);
		const clone = duplicateFieldMutations(source, Q("group"));
		if (!clone) throw new Error("Missing duplicate");
		const result = commit(source, clone.mutations);
		const [child] = result.fieldOrder[clone.cloneUuid];
		const layout = submissionLayout(F, result.fields, result.fieldOrder);
		expect(result.fields[child].id).toBe("child_2");
		expect(layout.children.get(Q("receiving"))).toEqual([Q("child"), child]);
		expect(layout.children.get(clone.cloneUuid)).toEqual([]);
		expect(result.fieldParent[child]).toBe(clone.cloneUuid);
	});
	it("duplicates an Android app question with its sent value, destinations and second invoking question", () => {
		const source = commit(fixture(), [
			{ kind: "setAppSettings", settings: { runsOnlyOn: "android" } },
			{
				kind: "addField",
				parentUuid: Q("group"),
				field: {
					...textField("meter"),
					androidApp: {
						kind: "open-app",
						action: "org.example.MEASURE",
						send: [
							{
								name: "previous",
								value: term({ ...formField(Q("child")), spelling: "absolute" }),
							},
						],
						receive: [
							{ name: "reading", question: Q("child") },
							{ name: "display", question: Q("a") },
						],
					},
				},
			},
			{
				kind: "updateField",
				targetKind: "text",
				uuid: Q("child"),
				patch: { androidApp: { kind: "use-question", question: Q("meter") } },
			},
		]);
		const plan = duplicateFieldMutations(source, Q("group"));
		if (!plan) throw new Error("Expected the group to be duplicated.");
		const copied = commit(source, plan.mutations);
		const [child, meter] = copied.fieldOrder[plan.cloneUuid];
		expect(copied.fields[child]).toMatchObject({
			androidApp: { kind: "use-question", question: meter },
		});
		expect(copied.fields[meter]).toMatchObject({
			id: "meter_2",
			androidApp: {
				send: [
					{
						name: "previous",
						value: term({ ...formField(child), spelling: "absolute" }),
					},
				],
				receive: [
					{ name: "reading", question: child },
					{ name: "display", question: Q("a") },
				],
			},
		});
		expect(copied.fields[Q("meter")]).toEqual(source.fields[Q("meter")]);
		const converted = commit(copied, [
			{
				kind: "updateField",
				uuid: child,
				targetKind: "text",
				patch: { androidApp: null },
			},
			{ kind: "convertField", uuid: meter, toKind: "barcode" },
		]);
		expect(converted.fields[meter]).toMatchObject({
			kind: "barcode",
			id: "meter_2",
		});
		expect(converted.fields[meter]).not.toHaveProperty("androidApp");
		expect(converted.fields[Q("child")]).toMatchObject({
			androidApp: { kind: "use-question", question: Q("meter") },
		});
	});
});
describe("field content and patch admission", () => {
	it("patches one slot while retaining untouched nested values by identity", () => {
		const before = commit(fixture(), [
			{
				kind: "updateField",
				uuid: Q("a"),
				targetKind: "text",
				patch: { hint: proseText("Hint"), required: matchAll() },
			},
		]);
		const next = commit(before, [
			{
				kind: "updateField",
				uuid: Q("a"),
				targetKind: "text",
				patch: { label: proseText("Patient name") },
			},
		]);
		const prevField = before.fields[Q("a")];
		const nextField = next.fields[Q("a")];
		if (prevField.kind !== "text" || nextField.kind !== "text")
			throw new Error("Expected text fields");
		expect(nextField.label).toEqual(proseText("Patient name"));
		expect(nextField.hint).toBe(prevField.hint);
		expect(nextField.required).toBe(prevField.required);
	});
	it("clears an optional nested slot after actual JSON serialization", () => {
		const before = commit(fixture(), [
			{
				kind: "updateField",
				uuid: Q("a"),
				targetKind: "text",
				patch: { hint: proseText("Hint") },
			},
		]);
		const next = commit(before, [
			{
				kind: "updateField",
				uuid: Q("a"),
				targetKind: "text",
				patch: { hint: null },
			},
		]);
		expect(Object.hasOwn(next.fields[Q("a")], "hint")).toBe(false);
	});
	it("refuses a stale target kind at admission and leaves replay content intact", () => {
		const before = fixture();
		const mutation: Mutation = {
			kind: "updateField",
			uuid: Q("a"),
			targetKind: "int",
			patch: { label: proseText("Stale") },
		};
		expect(
			mutationCommitVerdict(before, [mutation], LOOKUP_CONTEXT_UNAVAILABLE).ok,
		).toBe(false);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(toPersistableDoc(replay(before, [mutation]))).toEqual(
				toPersistableDoc(before),
			);
		} finally {
			warn.mockRestore();
		}
	});
	it("drops the count-bound slot when repeat mode changes", () => {
		const before = commit(fixture(), [
			{
				kind: "addField",
				parentUuid: F,
				field: {
					uuid: Q("repeat"),
					id: "repeat",
					kind: "repeat",
					repeat_mode: "count_bound",
					repeat_count: term(literal(5)),
				},
			},
			{ kind: "addField", parentUuid: Q("repeat"), field: textField("answer") },
		]);
		const next = commit(before, [
			{
				kind: "updateField",
				uuid: Q("repeat"),
				targetKind: "repeat",
				patch: { repeat_mode: "user_controlled" },
			},
		]);
		expect(next.fields[Q("repeat")]).toMatchObject({
			repeat_mode: "user_controlled",
		});
		expect(Object.hasOwn(next.fields[Q("repeat")], "repeat_count")).toBe(false);
		expect(next.fieldOrder[Q("repeat")]).toEqual([Q("answer")]);
	});
	it.each([
		{ kind: "int" },
		{ id: null },
		{ id: undefined },
		{ id: "" },
		{ id: "renamed", newId: "other" },
		{ label: 42 },
		{ hint: undefined },
	])(
		"rejects malformed patch %j without stripping it into a different command",
		(patch) => {
			expect(() =>
				admitMutationBatch([
					{
						kind: "updateField",
						uuid: Q("a"),
						targetKind: "text",
						patch,
					} as unknown as Mutation,
				]),
			).toThrow();
		},
	);
});
