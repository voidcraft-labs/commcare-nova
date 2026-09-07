import { produce } from "immer";
import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f, xp } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import {
	type BlueprintDoc,
	type Mutation,
	mutationSchema,
} from "@/lib/doc/types";
import { type FieldKind, proseText } from "@/lib/domain";
import { assertAdmittedDoc } from "./admittedDoc";

const Q = testUuid("conversion-subject");
const CHILD = testUuid("conversion-child");
function fixture(field: Parameters<typeof f>[0]): BlueprintDoc {
	const doc = buildDoc({
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Collect",
						type: "survey",
						fields: [
							f({ uuid: Q, label: proseText("Answer"), ...field }),
							f({ id: "spare", kind: "text", label: proseText("Spare") }),
						],
					},
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	return doc;
}
function convert(
	doc: BlueprintDoc,
	toKind: FieldKind,
	extra: Partial<Extract<Mutation, { kind: "convertField" }>> = {},
): BlueprintDoc {
	const mutation = mutationSchema.parse(
		JSON.parse(
			JSON.stringify({ kind: "convertField", uuid: Q, toKind, ...extra }),
		),
	);
	const verdict = mutationCommitVerdict(
		doc,
		[mutation],
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	return verdict.nextDoc;
}
const options = [
	{ uuid: testUuid("conversion-red"), value: "red", label: proseText("Red") },
	{
		uuid: testUuid("conversion-blue"),
		value: "blue",
		label: proseText("Blue"),
	},
];
describe("admitted field conversion", () => {
	it.each([
		["text", "secret"],
		["secret", "text"],
		["int", "decimal"],
		["decimal", "int"],
		["date", "time"],
		["datetime", "date"],
		["image", "audio"],
		["video", "signature"],
		["text", "barcode"],
		["barcode", "text"],
	] as const)(
		"%s to %s preserves the authored identity and common slots",
		(kind, toKind) => {
			const before = fixture({
				id: "answer",
				kind,
				required: xp("true()"),
				relevant: xp("true()"),
				hint: proseText("Instructions"),
			});
			const next = convert(before, toKind);
			expect(next.fields[Q]).toEqual({ ...before.fields[Q], kind: toKind });
			expect(next.fieldOrder).toEqual(before.fieldOrder);
			expect(next.fieldParent).toEqual(before.fieldParent);
		},
	);
	it("preserves nontrivial numeric validation and text default values", () => {
		const numeric = fixture({ id: "answer", kind: "int", validate: ". > 0" });
		expect(convert(numeric, "decimal").fields[Q]).toEqual({
			...numeric.fields[Q],
			kind: "decimal",
		});
		const text = fixture({
			id: "answer",
			kind: "text",
			default_value: "'unknown'",
			validate: "string-length(.) > 0",
		});
		expect(convert(text, "barcode").fields[Q]).toEqual({
			...text.fields[Q],
			kind: "barcode",
		});
	});
	it.each([
		["single_select", "multi_select"],
		["multi_select", "single_select"],
	] as const)(
		"%s to %s keeps option identities and complete authored values",
		(kind, toKind) => {
			const before = fixture({
				id: "answer",
				kind,
				optionsSource: { kind: "inline", options },
			});
			expect(convert(before, toKind).fields[Q]).toEqual({
				...before.fields[Q],
				kind: toKind,
			});
		},
	);
	it("seeds new option identities at the conversion boundary then drops the source on conversion back to text", () => {
		const before = fixture({
			id: "answer",
			kind: "text",
			hint: proseText("Choose a color"),
		});
		const selected = convert(before, "single_select", {
			optionsSource: { kind: "inline", options },
		});
		expect(selected.fields[Q]).toEqual({
			...before.fields[Q],
			kind: "single_select",
			optionsSource: { kind: "inline", options },
		});
		expect(convert(selected, "text").fields[Q]).toEqual(before.fields[Q]);
	});
	it("converts a populated group to a repeat and back while preserving all descendants", () => {
		const before = fixture({
			id: "answer",
			kind: "group",
			relevant: "true()",
			children: [
				f({
					uuid: CHILD,
					id: "child",
					kind: "text",
					label: proseText("Child"),
				}),
			],
		});
		const repeated = convert(before, "repeat");
		expect(repeated.fields[Q]).toEqual({
			...before.fields[Q],
			kind: "repeat",
			repeat_mode: "user_controlled",
		});
		expect(repeated.fieldOrder[Q]).toEqual([CHILD]);
		expect(repeated.fieldParent[CHILD]).toBe(Q);
		expect(convert(repeated, "group").fields).toEqual(before.fields);
	});
	it("removes repeat-specific count settings when becoming a group", () => {
		const before = fixture({
			id: "answer",
			kind: "repeat",
			repeat_mode: "count_bound",
			repeat_count: "3",
			children: [
				f({
					uuid: CHILD,
					id: "child",
					kind: "text",
					label: proseText("Child"),
				}),
			],
		});
		expect(convert(before, "group").fields[Q]).toEqual({
			uuid: Q,
			id: "answer",
			kind: "group",
			label: proseText("Answer"),
		});
	});
	it("keeps the hidden value and visibility expression while removing visible control content", () => {
		const before = fixture({
			id: "answer",
			kind: "text",
			hint: proseText("Hint"),
			required: "true()",
			relevant: "true()",
			validate: "string-length(.) > 0",
			default_value: "'unnamed'",
		});
		expect(convert(before, "hidden").fields[Q]).toEqual({
			uuid: Q,
			id: "answer",
			kind: "hidden",
			relevant: xp("true()"),
			default_value: xp("'unnamed'"),
		});
	});
	it("leaves the same kind unchanged", () => {
		const before = fixture({ id: "answer", kind: "text" });
		expect(convert(before, "text").fields[Q]).toBe(before.fields[Q]);
	});
	it.each([
		"leaf-to-container",
		"container-to-leaf",
		"missing-option-seed",
		"hidden-without-value",
	] as const)("refuses %s at the real gate", (scenario) => {
		const before = fixture(
			scenario === "container-to-leaf"
				? {
						id: "answer",
						kind: "group",
						children: [
							f({
								uuid: CHILD,
								id: "child",
								kind: "text",
								label: proseText("Child"),
							}),
						],
					}
				: { id: "answer", kind: "text" },
		);
		const toKind =
			scenario === "leaf-to-container"
				? "group"
				: scenario === "container-to-leaf"
					? "text"
					: scenario === "missing-option-seed"
						? "single_select"
						: "hidden";
		const mutation: Mutation = { kind: "convertField", uuid: Q, toKind };
		expect(
			mutationCommitVerdict(before, [mutation], LOOKUP_CONTEXT_UNAVAILABLE).ok,
		).toBe(false);
		// The schema can represent an empty hidden value, so its semantic refusal belongs
		// to the commit gate. Structural conversions and missing seeds have reducer guards.
		if (scenario === "hidden-without-value") return;
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
	});
	it("replays an unknown subject without manufacturing a field", () => {
		const before = fixture({ id: "answer", kind: "text" });
		expect(
			toPersistableDoc(
				produce(before, (draft) => {
					applyMutations(draft, [
						{ kind: "convertField", uuid: testUuid("gone"), toKind: "secret" },
					]);
				}),
			),
		).toEqual(toPersistableDoc(before));
	});
});
