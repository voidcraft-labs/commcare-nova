import { produce } from "immer";
import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import { createBlueprintDocStore } from "@/lib/doc/store";
import {
	type BlueprintDoc,
	type Mutation,
	mutationSchema,
} from "@/lib/doc/types";
import {
	canonicalProseTemplate,
	expressionSource,
	proseText,
} from "@/lib/domain";
import { assertAdmittedDoc } from "./admittedDoc";

const Q = (key: string) => testUuid(`move-reference-${key}`);
function fixture(): BlueprintDoc {
	const doc = buildDoc({
		modules: [
			{
				name: "Survey",
				forms: [
					{
						uuid: Q("form"),
						name: "First",
						type: "survey",
						fields: [
							f({
								uuid: Q("outer"),
								id: "outer",
								kind: "group",
								label: proseText("Outer"),
								children: [],
							}),
							f({
								uuid: Q("group"),
								id: "group",
								kind: "group",
								label: proseText("Group"),
								children: [
									f({
										uuid: Q("child"),
										id: "child",
										kind: "text",
										label: proseText("Child"),
									}),
									f({
										uuid: Q("inner"),
										id: "inner",
										kind: "group",
										label: proseText("Inner"),
										children: [],
									}),
								],
							}),
							f({
								uuid: Q("watch"),
								id: "watch",
								kind: "hidden",
								calculate:
									"#form/group/child = '1' and /data/group/child != ''",
							}),
							f({
								uuid: Q("label"),
								id: "label",
								kind: "text",
								label: canonicalProseTemplate([
									{ kind: "text", text: "Compare " },
									{ kind: "field-ref", uuid: Q("child") },
								]),
							}),
						],
					},
					{
						uuid: Q("other-form"),
						name: "Second",
						type: "survey",
						fields: [
							f({
								uuid: Q("other-group"),
								id: "group",
								kind: "group",
								label: proseText("Group"),
								children: [
									f({
										uuid: Q("other-child"),
										id: "child",
										kind: "text",
										label: proseText("Other child"),
									}),
								],
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
describe("field moves project stable references", () => {
	it("moves the container and descendant references through store edit, undo and redo without rewriting AST values", () => {
		const before = fixture();
		const store = createBlueprintDocStore();
		store.getState().load(before);
		store.getState().startTracking();
		const originalExpression = before.fields[Q("watch")];
		const originalLabel = before.fields[Q("label")];
		const mutation = mutationSchema.parse(
			JSON.parse(
				JSON.stringify({
					kind: "moveField",
					uuid: Q("group"),
					toParentUuid: Q("outer"),
					after: null,
				}),
			),
		);
		expect(
			mutationCommitVerdict(before, [mutation], LOOKUP_CONTEXT_UNAVAILABLE).ok,
		).toBe(true);
		store.getState().applyMany([mutation]);
		const moved = store.getState();
		assertAdmittedDoc({
			...toPersistableDoc(moved),
			fieldParent: moved.fieldParent,
		});
		expect(expressionSource(moved.fields[Q("watch")], "calculate", moved)).toBe(
			"#form/outer/group/child = '1' and /data/outer/group/child != ''",
		);
		expect(expressionSource(moved.fields[Q("label")], "label", moved)).toBe(
			"Compare #form/outer/group/child",
		);
		expect(moved.fields[Q("watch")]).toEqual(originalExpression);
		expect(moved.fields[Q("label")]).toEqual(originalLabel);
		store.getState().undo();
		expect(
			expressionSource(
				store.getState().fields[Q("watch")],
				"calculate",
				store.getState(),
			),
		).toBe("#form/group/child = '1' and /data/group/child != ''");
		store.getState().redo();
		expect(store.getState().fieldParent[Q("group")]).toBe(Q("outer"));
	});
	it.each(["other-form", "other-group", "group", "inner", "child"] as const)(
		"refuses move into %s and unguarded replay preserves topology",
		(destination) => {
			const before = fixture();
			const mutation: Mutation = {
				kind: "moveField",
				uuid: Q("group"),
				toParentUuid: Q(destination),
				after: null,
			};
			expect(
				mutationCommitVerdict(before, [mutation], LOOKUP_CONTEXT_UNAVAILABLE)
					.ok,
			).toBe(false);
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				expect(
					toPersistableDoc(
						produce(before, (draft) => {
							applyMutations(draft, [mutation]);
						}),
					),
				).toEqual(toPersistableDoc(before));
			} finally {
				warn.mockRestore();
			}
		},
	);
	it("refuses an orphan at the actual store load boundary", () => {
		const malformed = fixture();
		malformed.fields[Q("orphan")] = {
			uuid: Q("orphan"),
			id: "orphan",
			kind: "group",
			label: proseText("Orphan"),
		};
		malformed.fieldOrder[Q("orphan")] = [];
		expect(() => createBlueprintDocStore().getState().load(malformed)).toThrow(
			/invalid blueprint topology/,
		);
	});
});
