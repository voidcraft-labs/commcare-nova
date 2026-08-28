import { produce } from "immer";
import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { resolveDocExpressions, xp } from "@/lib/__tests__/docHelpers";
import { duplicateFieldMutations } from "@/lib/doc/duplicateFieldMutations";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { applyMutation, applyMutations } from "@/lib/doc/mutations";
import type { BlueprintDoc, Mutation, Uuid } from "@/lib/doc/types";
import { mutationSchema } from "@/lib/doc/types";
import type { Field, Form, Module } from "@/lib/domain";
import { expressionSource } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

const M = (s: string) => testUuid(`mod${s}-0000-0000-0000-000000000000`);
const F = (s: string) => testUuid(`frm${s}-0000-0000-0000-000000000000`);
const Q = (s: string) => testUuid(`qst${s}-0000-0000-0000-000000000000`);

/**
 * Build a Field fixture for tests.
 *
 * The domain `Field` type is a discriminated union keyed on `kind`. Callers
 * may override `kind` via the patch (e.g. `kind: "group"`); the default is
 * "text" for leaf fields. Label defaults to the id so the text-variant
 * required-label invariant is satisfied. We cast through `unknown` because
 * the wide test-time patch shape doesn't narrow to any single variant.
 */
function field_(
	uuid: Uuid,
	id: string,
	// Wide on purpose: fixtures author expression slots as STRINGS and
	// `resolveDocExpressions` converts them against the assembled doc.
	patch: Record<string, unknown> & { kind?: Field["kind"] } = {},
): Field {
	const { kind = "text", ...rest } = patch;
	return { uuid, id, kind, label: proseText(id), ...rest } as unknown as Field;
}

/** The printed text of an AST-stored expression slot — what the old
 *  string assertions used to read directly off the field. */
function slotText(
	doc: BlueprintDoc,
	uuid: Uuid,
	slot: "calculate" | "relevant" | "validate" | "default_value" | "required",
): string | undefined {
	const field = doc.fields[uuid];
	return field ? expressionSource(field, slot, doc) : undefined;
}

function proseSlotText(
	doc: BlueprintDoc,
	uuid: Uuid,
	slot: "label" | "hint" | "help" | "validate_msg",
): string | undefined {
	const field = doc.fields[uuid];
	return field ? expressionSource(field, slot, doc) : undefined;
}

function updateFieldIdMutation(
	doc: BlueprintDoc,
	uuid: Uuid,
	id: string,
): Mutation {
	return {
		kind: "updateField",
		uuid,
		targetKind: doc.fields[uuid]?.kind ?? "text",
		patch: { id },
	} as Mutation;
}

function docWithForm(): BlueprintDoc {
	return {
		appId: "test",
		appName: "A",
		connectType: null,
		caseTypes: null,
		modules: { [M("X")]: { uuid: M("X"), name: "M" } as Module },
		forms: {
			[F("1")]: { uuid: F("1"), name: "F", type: "survey" } as Form,
		},
		fields: {},
		moduleOrder: [M("X")],
		formOrder: { [M("X")]: [F("1")] },
		fieldOrder: { [F("1")]: [] },
		fieldParent: {},
	};
}

describe("addField", () => {
	it("appends under a form uuid", () => {
		const next = produce(docWithForm(), (d) => {
			applyMutation(d, {
				kind: "addField",
				parentUuid: F("1"),
				field: field_(Q("a"), "name"),
			});
		});
		expect(next.fieldOrder[F("1")]).toEqual([Q("a")]);
		expect(next.fields[Q("a")]?.id).toBe("name");
	});

	it("appends under a group uuid", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: { [Q("grp")]: field_(Q("grp"), "grp", { kind: "group" }) },
			fieldOrder: { [F("1")]: [Q("grp")], [Q("grp")]: [] },
		};
		const next = produce(resolveDocExpressions(start), (d) => {
			applyMutation(d, {
				kind: "addField",
				parentUuid: Q("grp"),
				field: field_(Q("c"), "child"),
			});
		});
		expect(next.fieldOrder[Q("grp")]).toEqual([Q("c")]);
	});

	it("respects index when inserting", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("a")]: field_(Q("a"), "a"),
				[Q("c")]: field_(Q("c"), "c"),
			},
			fieldOrder: { [F("1")]: [Q("a"), Q("c")] },
		};
		const next = produce(resolveDocExpressions(start), (d) => {
			applyMutation(d, {
				kind: "addField",
				parentUuid: F("1"),
				field: field_(Q("b"), "b"),
				after: Q("a"),
			});
		});
		expect(next.fieldOrder[F("1")]).toEqual([Q("a"), Q("b"), Q("c")]);
	});

	it("is a no-op when parent doesn't exist", () => {
		const next = produce(docWithForm(), (d) => {
			applyMutation(d, {
				kind: "addField",
				parentUuid: F("missing"),
				field: field_(Q("a"), "a"),
			});
		});
		expect(next.fields[Q("a")]).toBeUndefined();
	});
});

describe("updateField", () => {
	it("applies a partial patch", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: { [Q("a")]: field_(Q("a"), "name") },
			fieldOrder: { [F("1")]: [Q("a")] },
		};
		const next = produce(resolveDocExpressions(start), (d) => {
			applyMutation(d, {
				kind: "updateField",
				uuid: Q("a"),
				targetKind: "text",
				patch: { label: proseText("Patient Name"), required: xp("true") },
			});
		});
		expect(proseSlotText(next, Q("a"), "label")).toBe("Patient Name");
		expect(slotText(next, Q("a"), "required")).toBe("true");
		expect(next.fields[Q("a")]?.id).toBe("name"); // Preserved
	});

	it("preserves reference identity for every untouched nested slot", () => {
		const start = resolveDocExpressions({
			...docWithForm(),
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name") },
						{ name: "age", label: proseText("Age") },
					],
				},
			],
			fields: {
				[Q("a")]: field_(Q("a"), "name", {
					required: "true()",
					hint: proseText("Kept by reference"),
					caseWrite: { caseType: "patient", property: "case_name" },
				}),
			},
			fieldOrder: { [F("1")]: [Q("a")] },
		});
		const previousField = start.fields[Q("a")] as Extract<
			Field,
			{ kind: "text" }
		>;
		const next = produce(start, (draft) => {
			applyMutation(draft, {
				kind: "updateField",
				uuid: Q("a"),
				targetKind: "text",
				patch: { caseWrite: { caseType: "patient", property: "age" } },
			});
		});
		const nextField = next.fields[Q("a")] as Extract<Field, { kind: "text" }>;

		expect(nextField.required).toBe(previousField.required);
		expect(nextField.label).toBe(previousField.label);
		expect(nextField.hint).toBe(previousField.hint);
		expect(nextField.caseWrite).not.toBe(previousField.caseWrite);
		expect(nextField.caseWrite).toEqual({
			caseType: "patient",
			property: "age",
		});
	});

	it("skips a stale patch when the field's kind drifted from targetKind", () => {
		// Stale-mutation case: `targetKind` was captured against the field's
		// kind at the time the mutation was queued, but the field has since
		// been converted (or the wrong kind was supplied). The reducer must
		// recognize the drift and skip the patch rather than merging keys
		// that don't belong to the current kind.
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("h")]: field_(Q("h"), "computed", {
					kind: "hidden",
					calculate: "1",
				}),
			},
			fieldOrder: { [F("1")]: [Q("h")] },
		};
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const next = produce(resolveDocExpressions(start), (d) => {
			applyMutation(d, {
				kind: "updateField",
				uuid: Q("h"),
				// `targetKind: "text"` doesn't match the field's actual kind
				// ("hidden") — the reducer warns and no-ops. The compile-time
				// guard prevents this from being a typical authoring mistake;
				// the runtime guard catches the parallel-batch race where a
				// `convertField` lands between queue and dispatch.
				targetKind: "text",
				patch: { label: proseText("oops"), default_value: xp("2") },
			});
		});
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
		// Field unchanged — original calculate preserved.
		expect(slotText(next, Q("h"), "calculate")).toBe("1");
		expect(next.fields[Q("h")]?.kind).toBe("hidden");
	});

	it("rejects a re-kind patch as one non-canonical command", () => {
		// `convertField` is the single kind-change path (it owns the
		// convertibility gate; a patch-merge has no equivalent and would
		// happily turn a group with children into a leaf, orphaning the
		// subtree). Admission is strict and atomic: it must not strip `kind`
		// and apply the remaining label as a partial command.
		expect(() =>
			admitMutationBatch([
				{
					kind: "updateField",
					uuid: Q("grp"),
					targetKind: "group",
					patch: {
						kind: "text",
						label: proseText("Renamed"),
					},
				} as unknown as Mutation,
			]),
		).toThrow();
	});

	it("rejects an immutable kind key at the wire boundary", () => {
		// The final mutation dialect is strict. A kind change has one owner:
		// `convertField`; `updateField` never accepts an alternate spelling.
		const mut = {
			kind: "updateField",
			uuid: Q("a"),
			targetKind: "text",
			patch: { kind: "int", hint: proseText("patched") },
		} as unknown as Mutation;
		expect(() => admitMutationBatch([mut])).toThrow();
		expect(mutationSchema.safeParse(mut).success).toBe(false);
	});

	it("drops stale mode-specific keys when repeat_mode changes", () => {
		// Mode-switch on a repeat field: count_bound → user_controlled.
		// `repeat_count` lives only on count_bound; user_controlled rejects
		// it (the variant schemas are strict). The reducer must end up with
		// a clean user_controlled field — not skip the patch with a parse
		// failure because the spread-merged object still carries the
		// stale `repeat_count` key.
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("r")]: {
					uuid: Q("r"),
					id: "r",
					kind: "repeat",
					repeat_mode: "count_bound",
					repeat_count: xp("5"),
				} as Field,
			},
			fieldOrder: { [F("1")]: [Q("r")], [Q("r")]: [] },
		};
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const next = produce(resolveDocExpressions(start), (d) => {
			applyMutation(d, {
				kind: "updateField",
				uuid: Q("r"),
				targetKind: "repeat",
				patch: { repeat_mode: "user_controlled" },
			});
		});
		warn.mockRestore();
		const r = next.fields[Q("r")] as
			| (Field & {
					repeat_mode: string;
					repeat_count?: string;
			  })
			| undefined;
		expect(r?.repeat_mode).toBe("user_controlled");
		expect("repeat_count" in (r ?? {})).toBe(false);
	});

	it("is a no-op and warns when the merged result fails schema validation", () => {
		// A text field requires `label`. Supplying `{ label: undefined }` via
		// a pathological patch would produce an invalid merged entity; the
		// reducer must reject the patch (no-op) and log the validation issue.
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: { [Q("a")]: field_(Q("a"), "name") },
			fieldOrder: { [F("1")]: [Q("a")] },
		};
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const next = produce(resolveDocExpressions(start), (d) => {
			applyMutation(d, {
				kind: "updateField",
				uuid: Q("a"),
				targetKind: "text",
				// Force an invalid value for a required field (not a string).
				// The TS shape on the new mutation requires per-kind partial,
				// so cast through `unknown` to inject the bad value at
				// runtime — the reducer's `safeParse` is what we're testing.
				patch: { label: 42 } as unknown as Partial<{
					label: ReturnType<typeof proseText>;
				}>,
			});
		});
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
		// No-op: original label preserved (field_ defaults label to id).
		expect(proseSlotText(next, Q("a"), "label")).toBe("name");
	});

	it("clears caseWrite when the patch value is null (the wire-safe blank)", () => {
		// `null` is the on-the-wire representation of a clear: the SA's
		// `editField({ caseWrite: null })` lowers to this patch. The
		// reducer must DELETE the key (not set it to null, which fieldSchema
		// would reject). `null` is used rather than `undefined` because it
		// survives JSON serialization, so the clear persists in the event log.
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("a")]: field_(Q("a"), "name", {
					caseWrite: { caseType: "child", property: "name" },
				}),
			},
			fieldOrder: { [F("1")]: [Q("a")] },
		};
		const next = produce(resolveDocExpressions(start), (d) => {
			applyMutation(d, {
				kind: "updateField",
				uuid: Q("a"),
				targetKind: "text",
				patch: { caseWrite: null },
			});
		});
		const f = next.fields[Q("a")];
		expect(f).toBeDefined();
		expect("caseWrite" in (f ?? {})).toBe(false);
	});

	it("rejects undefined instead of treating it as a second clear spelling", () => {
		expect(() =>
			admitMutationBatch([
				{
					kind: "updateField",
					uuid: Q("a"),
					targetKind: "text",
					patch: { caseWrite: undefined },
				} as unknown as Mutation,
			]),
		).toThrow();
	});

	it("accepts a null patch value through mutationSchema so a blank round-trips", () => {
		// The round-trip proof: a clear is persisted as `patch:
		// { caseWrite: null }`, and `null` (unlike `undefined`) survives
		// JSON serialization. The update arm's patch schema must accept the `null` value
		// so the mutation parses cleanly on read.
		const parsed = mutationSchema.parse({
			kind: "updateField",
			uuid: Q("a"),
			targetKind: "text",
			patch: { caseWrite: null },
		});
		expect(parsed.kind).toBe("updateField");
		// The null survives the parse (it's the clear directive the reducer reads).
		expect(
			(
				parsed as {
					patch: {
						caseWrite?: { caseType: string; property: string } | null;
					};
				}
			).patch.caseWrite,
		).toBeNull();
	});

	it.each([
		["null", { id: null }],
		["undefined", { id: undefined }],
		["empty", { id: "" }],
		["unknown key", { id: "years", newId: "alternate-dialect" }],
	])(
		"rejects a %s id patch at canonical mutation admission",
		(_label, patch) => {
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

describe("removeField", () => {
	it("removes a leaf field and splices its parent's order", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("a")]: field_(Q("a"), "a"),
				[Q("b")]: field_(Q("b"), "b"),
			},
			fieldOrder: { [F("1")]: [Q("a"), Q("b")] },
		};
		const next = produce(resolveDocExpressions(start), (d) => {
			applyMutation(d, { kind: "removeField", uuid: Q("a") });
		});
		expect(next.fields[Q("a")]).toBeUndefined();
		expect(next.fields[Q("b")]).toBeDefined();
		expect(next.fieldOrder[F("1")]).toEqual([Q("b")]);
	});

	it("cascades to group children", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("grp")]: field_(Q("grp"), "grp", { kind: "group" }),
				[Q("c1")]: field_(Q("c1"), "c1"),
				[Q("c2")]: field_(Q("c2"), "c2"),
			},
			fieldOrder: {
				[F("1")]: [Q("grp")],
				[Q("grp")]: [Q("c1"), Q("c2")],
			},
		};
		const next = produce(resolveDocExpressions(start), (d) => {
			applyMutation(d, { kind: "removeField", uuid: Q("grp") });
		});
		expect(next.fields[Q("grp")]).toBeUndefined();
		expect(next.fields[Q("c1")]).toBeUndefined();
		expect(next.fields[Q("c2")]).toBeUndefined();
		expect(next.fieldOrder[Q("grp")]).toBeUndefined();
	});

	it("is a no-op when the field doesn't exist", () => {
		const next = produce(docWithForm(), (d) => {
			applyMutation(d, { kind: "removeField", uuid: Q("missing") });
		});
		expect(Object.keys(next.fields)).toHaveLength(0);
	});
});

describe("moveField", () => {
	it("moves within the same parent (reorder)", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("a")]: field_(Q("a"), "a"),
				[Q("b")]: field_(Q("b"), "b"),
				[Q("c")]: field_(Q("c"), "c"),
			},
			fieldOrder: { [F("1")]: [Q("a"), Q("b"), Q("c")] },
		};
		const next = produce(resolveDocExpressions(start), (d) => {
			applyMutation(d, {
				kind: "moveField",
				uuid: Q("a"),
				toParentUuid: F("1"),
				after: Q("c"),
			});
		});
		expect(next.fieldOrder[F("1")]).toEqual([Q("b"), Q("c"), Q("a")]);
	});

	it("moves across parents", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("grp")]: field_(Q("grp"), "grp", { kind: "group" }),
				[Q("x")]: field_(Q("x"), "x"),
			},
			fieldOrder: {
				[F("1")]: [Q("grp"), Q("x")],
				[Q("grp")]: [],
			},
		};
		const next = produce(resolveDocExpressions(start), (d) => {
			applyMutation(d, {
				kind: "moveField",
				uuid: Q("x"),
				toParentUuid: Q("grp"),
				after: null,
			});
		});
		expect(next.fieldOrder[F("1")]).toEqual([Q("grp")]);
		expect(next.fieldOrder[Q("grp")]).toEqual([Q("x")]);
	});

	it("preserves the field id on a direct cross-parent move", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("grp")]: field_(Q("grp"), "grp", { kind: "group" }),
				[Q("name_a")]: field_(Q("name_a"), "name"),
				[Q("name_b")]: field_(Q("name_b"), "name"), // Same id, different group
			},
			fieldOrder: {
				[F("1")]: [Q("grp"), Q("name_a")],
				[Q("grp")]: [Q("name_b")],
			},
		};
		const next = produce(resolveDocExpressions(start), (d) => {
			applyMutation(d, {
				kind: "moveField",
				uuid: Q("name_a"),
				toParentUuid: Q("grp"),
				after: Q("name_b"),
			});
		});
		// Identity-sensitive moves never mint a replacement node name. The
		// authoritative admission layer rejects a sibling collision before
		// this reducer runs.
		expect(next.fields[Q("name_a")]?.id).toBe("name");
	});

	it("rewrites XPath references when a field moves into a group", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("src")]: field_(Q("src"), "source"),
				// `calculate` lives on the hidden kind only — fixtures put
				// expressions where the schema (and so the registry's
				// per-kind slot projection) actually declares them.
				[Q("ref")]: field_(Q("ref"), "ref", {
					kind: "hidden",
					calculate: "/data/source + 1",
				}),
				[Q("grp")]: field_(Q("grp"), "grp", { kind: "group" }),
			},
			fieldOrder: {
				[F("1")]: [Q("src"), Q("ref"), Q("grp")],
				[Q("grp")]: [],
			},
		};
		const next = produce(resolveDocExpressions(start), (d) => {
			applyMutation(d, {
				kind: "moveField",
				uuid: Q("src"),
				toParentUuid: Q("grp"),
				after: null,
			});
		});
		// Path changed from `/data/source` to `/data/grp/source`. Nothing
		// rewrote the stored slot — the reference is an identity leaf, and
		// printing resolves it to the moved field's current path.
		expect(slotText(next, Q("ref"), "calculate")).toBe("/data/grp/source + 1");
	});

	it("is a no-op when the target parent doesn't exist", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: { [Q("a")]: field_(Q("a"), "a") },
			fieldOrder: { [F("1")]: [Q("a")] },
		};
		const next = produce(resolveDocExpressions(start), (d) => {
			applyMutation(d, {
				kind: "moveField",
				uuid: Q("a"),
				toParentUuid: Q("missing"),
				after: null,
			});
		});
		expect(next.fieldOrder[F("1")]).toEqual([Q("a")]);
	});
});

describe("updateField id patch", () => {
	it("updates the field's id", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: { [Q("a")]: field_(Q("a"), "old_name") },
			fieldOrder: { [F("1")]: [Q("a")] },
		};
		const next = produce(resolveDocExpressions(start), (d) => {
			applyMutation(d, updateFieldIdMutation(d, Q("a"), "new_name"));
		});
		expect(next.fields[Q("a")]?.id).toBe("new_name");
	});

	it("prints identity-backed XPath references through the field's new id", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("src")]: field_(Q("src"), "source"),
				[Q("ref")]: field_(Q("ref"), "ref", {
					kind: "hidden",
					calculate: "/data/source * 2",
				}),
			},
			fieldOrder: { [F("1")]: [Q("src"), Q("ref")] },
		};
		const next = produce(resolveDocExpressions(start), (d) => {
			applyMutation(d, updateFieldIdMutation(d, Q("src"), "primary"));
		});
		expect(slotText(next, Q("ref"), "calculate")).toContain("primary");
		expect(slotText(next, Q("ref"), "calculate")).not.toContain("source");
	});

	it("does not manufacture a field when direct reduction targets a missing uuid", () => {
		const next = produce(docWithForm(), (d) => {
			applyMutation(d, updateFieldIdMutation(d, Q("missing"), "x"));
		});
		expect(next.fields[Q("missing")]).toBeUndefined();
	});
});

describe("duplicateFieldMutations", () => {
	/** Plan the duplicate and apply it, the way the builder gesture does. */
	function duplicate(
		doc: BlueprintDoc,
		uuid: Uuid,
	): { next: BlueprintDoc; cloneUuid: Uuid | undefined } {
		const plan = duplicateFieldMutations(doc, uuid);
		if (plan === undefined) return { next: doc, cloneUuid: undefined };
		return {
			next: produce(doc, (d) => {
				applyMutations(d, plan.mutations);
			}),
			cloneUuid: plan.cloneUuid,
		};
	}

	it("duplicates a leaf field with a new uuid", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: { [Q("a")]: field_(Q("a"), "name") },
			fieldOrder: { [F("1")]: [Q("a")] },
			fieldParent: { [Q("a")]: F("1") },
		};
		const { next, cloneUuid } = duplicate(resolveDocExpressions(start), Q("a"));
		expect(next.fields[Q("a")]).toBeDefined();
		expect(next.fieldOrder[F("1")]).toEqual([Q("a"), cloneUuid]);
		expect(cloneUuid).not.toBe(Q("a"));
		// The clone's id is deduped against its new siblings.
		expect(cloneUuid && next.fields[cloneUuid]?.id).toBe("name_2");
	});

	it("inserts the duplicate right after the source", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("a")]: field_(Q("a"), "a"),
				[Q("b")]: field_(Q("b"), "b"),
			},
			fieldOrder: { [F("1")]: [Q("a"), Q("b")] },
			fieldParent: { [Q("a")]: F("1"), [Q("b")]: F("1") },
		};
		const { next, cloneUuid } = duplicate(resolveDocExpressions(start), Q("a"));
		expect(next.fieldOrder[F("1")]).toEqual([Q("a"), cloneUuid, Q("b")]);
		expect(cloneUuid && next.fields[cloneUuid]?.id).toBe("a_2");
	});

	it("deep-clones a group with new uuids for all descendants", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("grp")]: field_(Q("grp"), "grp", { kind: "group" }),
				[Q("c")]: field_(Q("c"), "child"),
			},
			fieldOrder: {
				[F("1")]: [Q("grp")],
				[Q("grp")]: [Q("c")],
			},
			fieldParent: { [Q("grp")]: F("1"), [Q("c")]: Q("grp") },
		};
		const { next, cloneUuid } = duplicate(
			resolveDocExpressions(start),
			Q("grp"),
		);
		expect(next.fieldOrder[F("1")]).toEqual([Q("grp"), cloneUuid]);
		const cloneChildren = cloneUuid ? next.fieldOrder[cloneUuid] : [];
		expect(cloneChildren).toHaveLength(1);
		const [cloneChild] = cloneChildren;
		expect(cloneChild).not.toBe(Q("c"));
		// The child keeps its id: inside the new group nothing conflicts.
		expect(next.fields[cloneChild]?.id).toBe("child");
	});

	it("plans nothing when the source doesn't exist", () => {
		expect(
			duplicateFieldMutations(docWithForm(), Q("missing")),
		).toBeUndefined();
	});
});
