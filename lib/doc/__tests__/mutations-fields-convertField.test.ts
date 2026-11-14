import { produce } from "immer";
import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import { createBlueprintDocStore } from "@/lib/doc/store";
import {
	type BlueprintDoc,
	type Mutation,
	mutationSchema,
} from "@/lib/doc/types";
import {
	type FieldKind,
	NEW_APP_SETTINGS,
	type Platform,
	proseText,
} from "@/lib/domain";
import { literal, matchAll, now, term } from "@/lib/domain/expression/builders";
import { assertAdmittedDoc } from "./admittedDoc";

const Q = testUuid("conversion-subject");
const CHILD = testUuid("conversion-child");
function fixture(
	field: Parameters<typeof f>[0],
	runsOnlyOn?: Platform,
): BlueprintDoc {
	const doc = buildDoc({
		...(runsOnlyOn === undefined
			? {}
			: { appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn } }),
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Collect",
						type: "survey",
						fields: [
							f({
								uuid: Q,
								// A hidden value has no label.
								...(field.kind !== "hidden" && { label: proseText("Answer") }),
								...field,
							}),
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
				required: matchAll(),
				relevant: matchAll(),
				hint: proseText("Instructions"),
			});
			const next = convert(before, toKind);
			expect(next.fields[Q]).toEqual({ ...before.fields[Q], kind: toKind });
			expect(next.fieldOrder).toEqual(before.fieldOrder);
			expect(next.fieldParent).toEqual(before.fieldParent);
		},
	);
	it("drops a Text question's number keypad where the target kind has none, and keeps the rest", () => {
		const phone = fixture({
			id: "answer",
			kind: "text",
			keypad: "numbers",
			validate: "string-length(.) > 3",
		});
		const { keypad, ...withoutKeypad } = phone.fields[Q] as Record<
			string,
			unknown
		>;
		expect(keypad).toBe("numbers");
		for (const toKind of ["secret", "barcode"] as const)
			expect(convert(phone, toKind).fields[Q]).toEqual({
				...withoutKeypad,
				kind: toKind,
			});
	});
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
		// Born a group again, a labelled one holding no add-entries repeat
		// shows on one screen.
		expect(convert(repeated, "group").fields).toEqual({
			...before.fields,
			[Q]: { ...before.fields[Q], fieldList: true },
		});
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
			fieldList: true,
		});
	});
	it("refuses converting a query repeat to a group while a nested query reads its row identity", () => {
		const before = fixture({
			id: "items",
			kind: "repeat",
			repeat_mode: "query_bound",
			data_source: { ids_query: "'a b'" },
			children: [
				f({
					uuid: CHILD,
					id: "child_ids",
					kind: "hidden",
					calculate: "if(current()/../@id = 'a', 'a1 a2', 'b1')",
				}),
				f({
					id: "children",
					kind: "repeat",
					repeat_mode: "query_bound",
					data_source: { ids_query: "#form/items/child_ids" },
					children: [f({ id: "answer", kind: "text", label: "Answer" })],
				}),
			],
		});
		const reader = before.fields[CHILD];
		if (reader.kind !== "hidden") throw new Error("The row reader is missing.");
		expect(reader.calculate).toMatchObject({
			kind: "if",
			cond: {
				left: {
					kind: "term",
					term: { kind: "repeat-row", repeat: Q, attribute: "id" },
				},
			},
		});
		const original = structuredClone(before);
		const mutation = mutationSchema.parse(
			JSON.parse(
				JSON.stringify({ kind: "convertField", uuid: Q, toKind: "group" }),
			),
		);
		const verdict = mutationCommitVerdict(
			before,
			[mutation],
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict).toMatchObject({
			ok: false,
			findings: [
				{
					code: "INVALID_REF",
					location: {
						fieldUuid: CHILD,
						fieldId: "child_ids",
						field: "calculate",
					},
					details: {
						checkCode: "unknown-form-field",
						path: "if.cond.left",
						storedRef: "dangling-identity",
					},
				},
			],
		});
		expect(before).toEqual(original);
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
			relevant: matchAll(),
			default_value: term(literal("unnamed")),
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
					: "single_select";
		const mutation: Mutation = { kind: "convertField", uuid: Q, toKind };
		expect(
			mutationCommitVerdict(before, [mutation], LOOKUP_CONTEXT_UNAVAILABLE).ok,
		).toBe(false);
		// Structural conversions and missing seeds have reducer guards.
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
	it("admits a conversion to a hidden value that carries neither a calculate nor a default", () => {
		const before = fixture({ id: "answer", kind: "text" });
		const mutation: Mutation = {
			kind: "convertField",
			uuid: Q,
			toKind: "hidden",
		};
		expect(
			mutationCommitVerdict(before, [mutation], LOOKUP_CONTEXT_UNAVAILABLE).ok,
		).toBe(true);
	});
	it("converts a date-and-time question to a hidden value, keeping its identity, visibility and starting value", () => {
		const before = fixture({
			id: "answer",
			kind: "datetime",
			hint: proseText("When"),
			required: "true()",
			relevant: "true()",
			validate: ". <= now()",
			default_value: "now()",
		});
		expect(convert(before, "hidden").fields[Q]).toEqual({
			uuid: Q,
			id: "answer",
			kind: "hidden",
			relevant: matchAll(),
			default_value: now(),
		});
	});
	it.each(["datetime", "text"] as const)(
		"converts a hidden value back to %s with a label seed, the inverse of an offered conversion",
		(toKind) => {
			const before = fixture(
				{
					id: "answer",
					kind: "hidden",
					relevant: "true()",
				},
				// A date-and-time question runs on Android alone.
				toKind === "datetime" ? "android" : undefined,
			);
			expect(
				convert(before, toKind, { label: proseText("Answer again") }).fields[Q],
			).toEqual({
				uuid: Q,
				id: "answer",
				kind: toKind,
				label: proseText("Answer again"),
				relevant: matchAll(),
			});
		},
	);
	it.each([
		["hidden", "datetime", "no label seed"],
		["hidden", "text", "no label seed"],
		["hidden", "int", "neither kind lists the other"],
		["text", "date", "neither kind lists the other"],
	] as const)(
		"refuses %s to %s at the real gate when %s",
		(fromKind, toKind, _why) => {
			const before = fixture(
				fromKind === "hidden"
					? { id: "answer", kind: "hidden" }
					: { id: "answer", kind: fromKind },
			);
			const mutation: Mutation = {
				kind: "convertField",
				uuid: Q,
				toKind,
				...(toKind === "int" && { label: proseText("Answer") }),
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

describe("a group's one-screen layout across a conversion", () => {
	const INNER_REPEAT = testUuid("conversion-inner-repeat");
	function repeatHolding(inner: "question" | "user-repeat"): BlueprintDoc {
		return fixture({
			id: "answer",
			kind: "repeat",
			repeat_mode: "count_bound",
			repeat_count: "2",
			children: [
				inner === "question"
					? f({
							uuid: CHILD,
							id: "child",
							kind: "text",
							label: proseText("Child"),
						})
					: f({
							uuid: INNER_REPEAT,
							id: "visits",
							kind: "repeat",
							label: proseText("Visits"),
							repeat_mode: "user_controlled",
							children: [
								f({
									uuid: CHILD,
									id: "child",
									kind: "text",
									label: proseText("Child"),
								}),
							],
						}),
			],
		});
	}
	function trackedStore(doc: BlueprintDoc) {
		const store = createBlueprintDocStore();
		store.getState().load(doc);
		store.getState().startTracking();
		return store;
	}

	it("gives a labelled group the flag when nothing inside adds entries", () => {
		const group = convert(repeatHolding("question"), "group");
		expect(group.fields[Q]).toMatchObject({ kind: "group", fieldList: true });
	});

	it("leaves the flag off a group holding a repeat workers add entries to", () => {
		const group = convert(repeatHolding("user-repeat"), "group");
		expect(group.fields[Q]?.kind).toBe("group");
		expect(group.fields[Q]).not.toHaveProperty("fieldList");
	});

	it("leaves the flag off an unlabelled group", () => {
		const before = fixture({
			id: "answer",
			kind: "repeat",
			repeat_mode: "user_controlled",
			label: proseText(""),
			children: [f({ uuid: CHILD, id: "child", kind: "text" })],
		});
		expect(convert(before, "group").fields[Q]).not.toHaveProperty("fieldList");
	});

	it("drops the flag when a group becomes a repeat", () => {
		const before = fixture({
			id: "answer",
			kind: "group",
			fieldList: true,
			children: [f({ uuid: CHILD, id: "child", kind: "text" })],
		});
		const repeated = convert(before, "repeat");
		expect(repeated.fields[Q]).toMatchObject({ kind: "repeat" });
		expect(repeated.fields[Q]).not.toHaveProperty("fieldList");
	});

	it("restores a repeat with no flag when the conversion to a group is undone", () => {
		const before = repeatHolding("question");
		const store = trackedStore(before);
		store
			.getState()
			.applyMany(
				admitMutationBatch([
					{ kind: "convertField", uuid: Q, toKind: "group" },
				]),
			);
		expect(store.getState().fields[Q]).toMatchObject({ fieldList: true });
		store.getState().undo();
		expect(toPersistableDoc(store.getState()).fields).toEqual(
			toPersistableDoc(before).fields,
		);
	});

	it.each([
		["holding the flag", true],
		["without the flag", false],
	])(
		"restores a group %s when its conversion to a repeat is undone",
		(_label, fieldList) => {
			const before = fixture({
				id: "answer",
				kind: "group",
				...(fieldList && { fieldList: true }),
				children: [f({ uuid: CHILD, id: "child", kind: "text" })],
			});
			const store = trackedStore(before);
			store
				.getState()
				.applyMany(
					admitMutationBatch([
						{ kind: "convertField", uuid: Q, toKind: "repeat" },
					]),
				);
			expect(store.getState().fields[Q]).not.toHaveProperty("fieldList");
			const inverse = store.getState().undoBatch();
			if (inverse === undefined) throw new Error("Expected an undo step.");
			const verdict = mutationCommitVerdict(
				{
					...toPersistableDoc(store.getState()),
					fieldParent: store.getState().fieldParent,
				} as BlueprintDoc,
				inverse,
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			expect(verdict.ok ? [] : verdict.findings).toEqual([]);
			store.getState().undo();
			expect(toPersistableDoc(store.getState()).fields).toEqual(
				toPersistableDoc(before).fields,
			);
		},
	);
});
