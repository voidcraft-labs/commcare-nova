import { produce } from "immer";
import { describe, expect, it, vi } from "vitest";
import { applyMutation } from "@/lib/doc/mutations";
import type {
	FieldRenameMeta,
	MoveFieldResult,
} from "@/lib/doc/mutations/fields";
import type { BlueprintDoc, Uuid } from "@/lib/doc/types";
import { asUuid, mutationSchema } from "@/lib/doc/types";
import type { Column, Field, Form, Module } from "@/lib/domain";

const M = (s: string) => asUuid(`mod${s}-0000-0000-0000-000000000000`);
const F = (s: string) => asUuid(`frm${s}-0000-0000-0000-000000000000`);
const Q = (s: string) => asUuid(`qst${s}-0000-0000-0000-000000000000`);
const C = (s: string) => asUuid(`col${s}-0000-0000-0000-000000000000`);

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
	patch: Partial<Field> & { kind?: Field["kind"] } = {},
): Field {
	const { kind = "text", ...rest } = patch;
	return { uuid, id, kind, label: id, ...rest } as unknown as Field;
}

/**
 * Cast a union `Field | undefined` to a loosely-typed shape for assertion.
 *
 * Tests assert on properties like `label` and `calculate` that live only
 * on some variants. Since the discriminant `kind` isn't being narrowed at
 * the call site, we expose a shared `asField` helper that widens the type
 * to an any-variant-has-these-keys shape purely for the assertion.
 */
type AnyField =
	| {
			uuid: Uuid;
			id: string;
			kind: string;
			label?: string;
			required?: string;
			calculate?: string;
			relevant?: string;
			validate?: string;
			default_value?: string;
	  }
	| undefined;

const asField = (f: Field | undefined): AnyField => f as AnyField;

/**
 * Narrow a column off the `calculated` arm of the `Column` discriminated
 * union so test assertions can read the `field` slot directly. Calculated
 * columns have no `field` (the expression is the source); every other
 * kind (`plain`, `date`, `phone`, `id-mapping`, `interval`) carries a
 * `field: string`. Tests seed plain columns and assert against `.field`,
 * so the helper raises a fixture-shape error rather than silently
 * widening to a partial type — the throw surface signals "the fixture
 * isn't laid out the way the test assumes" instead of letting the
 * assertion downstream blow up on `.field` being absent.
 */
function asNonCalculatedColumn(
	col: Column | undefined,
	label: string,
): Exclude<Column, { kind: "calculated" }> {
	if (col === undefined) throw new Error(`fixture: ${label} missing`);
	if (col.kind === "calculated")
		throw new Error(`fixture: ${label} is calculated`);
	return col;
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
		const next = produce(start, (d) => {
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
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "addField",
				parentUuid: F("1"),
				field: field_(Q("b"), "b"),
				index: 1,
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
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "updateField",
				uuid: Q("a"),
				targetKind: "text",
				patch: { label: "Patient Name", required: "true" },
			});
		});
		expect(asField(next.fields[Q("a")])?.label).toBe("Patient Name");
		expect(asField(next.fields[Q("a")])?.required).toBe("true");
		expect(next.fields[Q("a")]?.id).toBe("name"); // Preserved
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
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "updateField",
				uuid: Q("h"),
				// `targetKind: "text"` doesn't match the field's actual kind
				// ("hidden") — the reducer warns and no-ops. The compile-time
				// guard prevents this from being a typical authoring mistake;
				// the runtime guard catches the parallel-batch race where a
				// `convertField` lands between queue and dispatch.
				targetKind: "text",
				patch: { label: "oops", default_value: "2" },
			});
		});
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
		// Field unchanged — original calculate preserved.
		expect(asField(next.fields[Q("h")])?.calculate).toBe("1");
		expect(next.fields[Q("h")]?.kind).toBe("hidden");
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
					repeat_count: "5",
				} as Field,
			},
			fieldOrder: { [F("1")]: [Q("r")] },
		};
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const next = produce(start, (d) => {
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
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "updateField",
				uuid: Q("a"),
				targetKind: "text",
				// Force an invalid value for a required field (not a string).
				// The TS shape on the new mutation requires per-kind partial,
				// so cast through `unknown` to inject the bad value at
				// runtime — the reducer's `safeParse` is what we're testing.
				patch: { label: 42 } as unknown as Partial<{ label: string }>,
			});
		});
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
		// No-op: original label preserved (field_ defaults label to id).
		expect(asField(next.fields[Q("a")])?.label).toBe("name");
	});

	it("clears a property when the patch value is null (the wire-safe blank)", () => {
		// `null` is the on-the-wire representation of a clear: the SA's
		// `editField({ case_property_on: null })` lowers to this patch. The
		// reducer must DELETE the key (not set it to null, which fieldSchema
		// would reject). `null` is used rather than `undefined` because it
		// survives Firestore, so the clear persists in the event log.
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("a")]: field_(Q("a"), "name", { case_property_on: "child" }),
			},
			fieldOrder: { [F("1")]: [Q("a")] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "updateField",
				uuid: Q("a"),
				targetKind: "text",
				patch: { case_property_on: null },
			});
		});
		const f = next.fields[Q("a")];
		expect(f).toBeDefined();
		expect("case_property_on" in (f ?? {})).toBe(false);
	});

	it("still clears a property when the patch value is undefined (client in-memory edit)", () => {
		// Client-side edits aren't logged, so they keep using `undefined` to
		// clear. The reducer must treat `undefined` identically to `null`.
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("a")]: field_(Q("a"), "name", { case_property_on: "child" }),
			},
			fieldOrder: { [F("1")]: [Q("a")] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "updateField",
				uuid: Q("a"),
				targetKind: "text",
				patch: { case_property_on: undefined },
			});
		});
		expect("case_property_on" in (next.fields[Q("a")] ?? {})).toBe(false);
	});

	it("accepts a null patch value through mutationSchema so a blank round-trips", () => {
		// The round-trip proof: a clear is persisted as `patch:
		// { case_property_on: null }`, and `null` (unlike `undefined`) survives
		// Firestore. The update arm's patch schema must accept the `null` value
		// so the mutation parses cleanly on read.
		const parsed = mutationSchema.parse({
			kind: "updateField",
			uuid: Q("a"),
			targetKind: "text",
			patch: { case_property_on: null },
		});
		expect(parsed.kind).toBe("updateField");
		// The null survives the parse (it's the clear directive the reducer reads).
		expect(
			(parsed as { patch: { case_property_on?: string | null } }).patch
				.case_property_on,
		).toBeNull();
	});
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
		const next = produce(start, (d) => {
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
		const next = produce(start, (d) => {
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
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "moveField",
				uuid: Q("a"),
				toParentUuid: F("1"),
				toIndex: 2,
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
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "moveField",
				uuid: Q("x"),
				toParentUuid: Q("grp"),
				toIndex: 0,
			});
		});
		expect(next.fieldOrder[F("1")]).toEqual([Q("grp")]);
		expect(next.fieldOrder[Q("grp")]).toEqual([Q("x")]);
	});

	it("dedupes id against new siblings on cross-parent move", () => {
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
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "moveField",
				uuid: Q("name_a"),
				toParentUuid: Q("grp"),
				toIndex: 1,
			});
		});
		// After move, Q("name_a") must have a unique id — "name_2".
		expect(next.fields[Q("name_a")]?.id).toBe("name_2");
	});

	it("rewrites XPath references when a field moves into a group", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("src")]: field_(Q("src"), "source"),
				[Q("ref")]: field_(Q("ref"), "ref", {
					calculate: "/data/source + 1",
				}),
				[Q("grp")]: field_(Q("grp"), "grp", { kind: "group" }),
			},
			fieldOrder: {
				[F("1")]: [Q("src"), Q("ref"), Q("grp")],
				[Q("grp")]: [],
			},
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "moveField",
				uuid: Q("src"),
				toParentUuid: Q("grp"),
				toIndex: 0,
			});
		});
		// Path changed from `/data/source` to `/data/grp/source` — the
		// path-to-path rewriter updates matching absolute-path references.
		expect(asField(next.fields[Q("ref")])?.calculate).toBe(
			"/data/grp/source + 1",
		);
	});

	it("is a no-op when the target parent doesn't exist", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: { [Q("a")]: field_(Q("a"), "a") },
			fieldOrder: { [F("1")]: [Q("a")] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "moveField",
				uuid: Q("a"),
				toParentUuid: Q("missing"),
				toIndex: 0,
			});
		});
		expect(next.fieldOrder[F("1")]).toEqual([Q("a")]);
	});
});

describe("renameField", () => {
	it("updates the field's id", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: { [Q("a")]: field_(Q("a"), "old_name") },
			fieldOrder: { [F("1")]: [Q("a")] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "renameField",
				uuid: Q("a"),
				newId: "new_name",
			});
		});
		expect(next.fields[Q("a")]?.id).toBe("new_name");
	});

	it("rewrites XPath references that point to the old id", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("src")]: field_(Q("src"), "source"),
				[Q("ref")]: field_(Q("ref"), "ref", {
					calculate: "/data/source * 2",
				}),
			},
			fieldOrder: { [F("1")]: [Q("src"), Q("ref")] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "renameField",
				uuid: Q("src"),
				newId: "primary",
			});
		});
		expect(asField(next.fields[Q("ref")])?.calculate).toContain("primary");
		expect(asField(next.fields[Q("ref")])?.calculate).not.toContain("source");
	});

	it("is a no-op when the field doesn't exist", () => {
		const next = produce(docWithForm(), (d) => {
			applyMutation(d, {
				kind: "renameField",
				uuid: Q("missing"),
				newId: "x",
			});
		});
		expect(Object.keys(next.fields)).toHaveLength(0);
	});
});

describe("duplicateField", () => {
	it("duplicates a leaf field with a new uuid", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: { [Q("a")]: field_(Q("a"), "name") },
			fieldOrder: { [F("1")]: [Q("a")] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, { kind: "duplicateField", uuid: Q("a") });
		});
		// Original still exists
		expect(next.fields[Q("a")]).toBeDefined();
		// Order has two entries
		expect(next.fieldOrder[F("1")]).toHaveLength(2);
		// Second entry is a new uuid ≠ Q("a")
		const [, dupUuid] = next.fieldOrder[F("1")];
		expect(dupUuid).not.toBe(Q("a"));
		// Duplicated field has deduped id
		expect(next.fields[dupUuid]?.id).toBe("name_2");
	});

	it("inserts the duplicate right after the source", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("a")]: field_(Q("a"), "a"),
				[Q("b")]: field_(Q("b"), "b"),
			},
			fieldOrder: { [F("1")]: [Q("a"), Q("b")] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, { kind: "duplicateField", uuid: Q("a") });
		});
		expect(next.fieldOrder[F("1")]).toHaveLength(3);
		const [first, second, third] = next.fieldOrder[F("1")];
		expect(first).toBe(Q("a"));
		expect(third).toBe(Q("b"));
		// The duplicate is at index 1
		expect(next.fields[second]?.id).toBe("a_2");
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
		};
		const next = produce(start, (d) => {
			applyMutation(d, { kind: "duplicateField", uuid: Q("grp") });
		});
		// Two top-level groups
		expect(next.fieldOrder[F("1")]).toHaveLength(2);
		const [, dupGrp] = next.fieldOrder[F("1")];
		// Dup group has its own child order
		expect(next.fieldOrder[dupGrp]).toHaveLength(1);
		const [dupChild] = next.fieldOrder[dupGrp];
		// Dup child is a new uuid
		expect(dupChild).not.toBe(Q("c"));
		// But retains the same id (within the new group, no siblings conflict)
		expect(next.fields[dupChild]?.id).toBe("child");
	});

	it("is a no-op when the source doesn't exist", () => {
		const next = produce(docWithForm(), (d) => {
			applyMutation(d, { kind: "duplicateField", uuid: Q("missing") });
		});
		expect(Object.keys(next.fields)).toHaveLength(0);
	});
});

describe("moveField result metadata", () => {
	it("returns renamed metadata when cross-level dedup changes the id", () => {
		// Form has a group containing `name`; moving `name` from root into the
		// group triggers sibling dedup → `name_2`.
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("grp")]: field_(Q("grp"), "grp", { kind: "group" }),
				[Q("name_root")]: field_(Q("name_root"), "name"),
				[Q("name_grp")]: field_(Q("name_grp"), "name"),
			},
			fieldOrder: {
				[F("1")]: [Q("grp"), Q("name_root")],
				[Q("grp")]: [Q("name_grp")],
			},
		};

		let result: MoveFieldResult | undefined;
		produce(start, (d) => {
			result = applyMutation(d, {
				kind: "moveField",
				uuid: Q("name_root"),
				toParentUuid: Q("grp"),
				toIndex: 1,
			}) as MoveFieldResult;
		});

		expect(result).toBeDefined();
		expect(result?.renamed).toBeDefined();
		expect(result?.renamed?.oldId).toBe("name");
		expect(result?.renamed?.newId).toBe("name_2");
		expect(typeof result?.renamed?.xpathFieldsRewritten).toBe("number");
	});

	it("returns renamed.xpathFieldsRewritten > 0 when refs are rewritten", () => {
		// `ref` has a calculate that references `/data/source`. Moving `source`
		// into the group changes its path from `/data/source` to
		// `/data/grp/source`. Additionally, the group already has a `source`
		// field, so the moved one dedup'd to `source_2` — the rewriter
		// updates the reference to `/data/grp/source_2`.
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("grp")]: field_(Q("grp"), "grp", { kind: "group" }),
				[Q("src_a")]: field_(Q("src_a"), "source"),
				[Q("src_b")]: field_(Q("src_b"), "source"),
				[Q("ref")]: field_(Q("ref"), "ref", {
					calculate: "/data/source + 1",
				}),
			},
			fieldOrder: {
				[F("1")]: [Q("grp"), Q("src_a"), Q("ref")],
				[Q("grp")]: [Q("src_b")],
			},
		};

		let result: MoveFieldResult | undefined;
		produce(start, (d) => {
			result = applyMutation(d, {
				kind: "moveField",
				uuid: Q("src_a"),
				toParentUuid: Q("grp"),
				toIndex: 1,
			}) as MoveFieldResult;
		});

		expect(result?.renamed).toBeDefined();
		expect(result?.renamed?.xpathFieldsRewritten).toBeGreaterThan(0);
	});

	it("returns renamed === undefined when no dedup is needed", () => {
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

		let result: MoveFieldResult | undefined;
		produce(start, (d) => {
			result = applyMutation(d, {
				kind: "moveField",
				uuid: Q("x"),
				toParentUuid: Q("grp"),
				toIndex: 0,
			}) as MoveFieldResult;
		});

		expect(result).toBeDefined();
		expect(result?.renamed).toBeUndefined();
		expect(result?.droppedCrossDepthRefs).toBe(0);
	});

	it("counts dropped cross-depth hashtag refs on top-level → nested move", () => {
		// Move top-level `source` into a group. Absolute-path refs to
		// `/data/source` get rewritten to `/data/grp/source` cleanly.
		// But a hashtag ref `#form/source` embedded in a label cannot be
		// rewritten (hashtag syntax has no depth > 1). The reducer must
		// surface the count on `droppedCrossDepthRefs` so a future UI toast
		// can warn the user N references silently broke.
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("src")]: field_(Q("src"), "source"),
				[Q("grp")]: field_(Q("grp"), "grp", { kind: "group" }),
				[Q("ref")]: field_(Q("ref"), "ref", {
					// Prose label with a hashtag ref — transformBareHashtags path.
					label: "See #form/source for details",
				}),
			},
			fieldOrder: {
				[F("1")]: [Q("src"), Q("grp"), Q("ref")],
				[Q("grp")]: [],
			},
		};

		let result: MoveFieldResult | undefined;
		produce(start, (d) => {
			result = applyMutation(d, {
				kind: "moveField",
				uuid: Q("src"),
				toParentUuid: Q("grp"),
				toIndex: 0,
			}) as MoveFieldResult;
		});

		expect(result?.droppedCrossDepthRefs).toBe(1);
	});
});

describe("renameField result metadata", () => {
	it("returns xpathFieldsRewritten > 0 when sibling references exist", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("src")]: field_(Q("src"), "source"),
				[Q("ref")]: field_(Q("ref"), "ref", {
					calculate: "/data/source * 2",
				}),
			},
			fieldOrder: { [F("1")]: [Q("src"), Q("ref")] },
		};

		let result: FieldRenameMeta | undefined;
		produce(start, (d) => {
			result = applyMutation(d, {
				kind: "renameField",
				uuid: Q("src"),
				newId: "primary",
			}) as FieldRenameMeta;
		});

		expect(result).toBeDefined();
		expect(result?.xpathFieldsRewritten).toBeGreaterThan(0);
		// No case_property_on set on the renamed field → cascade counts stay zero.
		expect(result?.peerFieldsRenamed).toBe(0);
		expect(result?.columnsRewritten).toBe(0);
		expect(result?.cascadedAcrossForms).toBe(false);
	});

	it("returns xpathFieldsRewritten === 0 when no references exist", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("a")]: field_(Q("a"), "alpha"),
				[Q("b")]: field_(Q("b"), "beta"),
			},
			fieldOrder: { [F("1")]: [Q("a"), Q("b")] },
		};

		let result: FieldRenameMeta | undefined;
		produce(start, (d) => {
			result = applyMutation(d, {
				kind: "renameField",
				uuid: Q("a"),
				newId: "gamma",
			}) as FieldRenameMeta;
		});

		expect(result).toBeDefined();
		expect(result?.xpathFieldsRewritten).toBe(0);
		expect(result?.peerFieldsRenamed).toBe(0);
		expect(result?.columnsRewritten).toBe(0);
		expect(result?.cascadedAcrossForms).toBe(false);
	});

	it("returns zero metadata when renamed to the same id", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("a")]: field_(Q("a"), "alpha", {
					calculate: "/data/alpha + 1",
				}),
			},
			fieldOrder: { [F("1")]: [Q("a")] },
		};

		let result: FieldRenameMeta | undefined;
		produce(start, (d) => {
			result = applyMutation(d, {
				kind: "renameField",
				uuid: Q("a"),
				newId: "alpha",
			}) as FieldRenameMeta;
		});

		expect(result?.xpathFieldsRewritten).toBe(0);
		expect(result?.peerFieldsRenamed).toBe(0);
		expect(result?.columnsRewritten).toBe(0);
		expect(result?.cascadedAcrossForms).toBe(false);
	});
});

/**
 * Build a two-module fixture used by the cross-form cascade tests. Two
 * forms in module X both bind to case type "patient"; module Y binds to a
 * different case type so the cascade can assert scoping.
 */
function docWithTwoModulesAndForms(): BlueprintDoc {
	return {
		appId: "test",
		appName: "A",
		connectType: null,
		caseTypes: null,
		modules: {
			[M("X")]: {
				uuid: M("X"),
				id: "m_x",
				name: "ModX",
				caseType: "patient",
				caseListConfig: {
					columns: [
						{ uuid: C("xage"), kind: "plain", field: "age", header: "Age" },
						{ uuid: C("xname"), kind: "plain", field: "name", header: "Name" },
					],
					searchInputs: [],
				},
			} as Module,
			[M("Y")]: {
				uuid: M("Y"),
				id: "m_y",
				name: "ModY",
				caseType: "household",
				caseListConfig: {
					columns: [
						{ uuid: C("yage"), kind: "plain", field: "age", header: "Age" },
					],
					searchInputs: [],
				},
			} as Module,
		},
		forms: {
			[F("1")]: { uuid: F("1"), name: "F1", type: "followup" } as Form,
			[F("2")]: { uuid: F("2"), name: "F2", type: "followup" } as Form,
			[F("3")]: { uuid: F("3"), name: "F3", type: "followup" } as Form,
		},
		fields: {},
		moduleOrder: [M("X"), M("Y")],
		formOrder: { [M("X")]: [F("1"), F("2")], [M("Y")]: [F("3")] },
		fieldOrder: { [F("1")]: [], [F("2")]: [], [F("3")]: [] },
		fieldParent: {},
	};
}

describe("renameField case-property cascade", () => {
	/**
	 * Core bug the cascade exists to fix: a field whose id == case property
	 * name gets renamed in one form; another form in the same case type
	 * references the property via `#case/<oldId>` in a label; the hashtag
	 * must be rewritten.
	 */
	it("rewrites #case/<oldId> refs in other forms bound to the same case type", () => {
		const base = docWithTwoModulesAndForms();
		const start: BlueprintDoc = {
			...base,
			fields: {
				// The authoritative holder of the `age` case property lives
				// in form 1 of module X.
				[Q("src")]: field_(Q("src"), "age", { case_property_on: "patient" }),
				// Form 2 of the SAME module has a field whose label references
				// `#case/age` — this is the ref that must be rewritten.
				[Q("ref")]: field_(Q("ref"), "display", {
					label: "Patient age: #case/age",
				}),
				// Form 3 of module Y (caseType: household) ALSO has a
				// `#case/age` ref. Because Y's caseType differs, the cascade
				// must NOT touch it — the ref resolves to a different case.
				[Q("off")]: field_(Q("off"), "household_display", {
					label: "Household age: #case/age",
				}),
			},
			fieldOrder: {
				[F("1")]: [Q("src")],
				[F("2")]: [Q("ref")],
				[F("3")]: [Q("off")],
			},
		};

		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "renameField",
				uuid: Q("src"),
				newId: "age_1",
			});
		});

		// Source field's id changed.
		expect(next.fields[Q("src")]?.id).toBe("age_1");
		// Cross-form #case/ ref in same caseType rewritten.
		expect(asField(next.fields[Q("ref")])?.label).toBe(
			"Patient age: #case/age_1",
		);
		// Cross-caseType ref left alone (resolves to a different case entity).
		expect(asField(next.fields[Q("off")])?.label).toBe(
			"Household age: #case/age",
		);
	});

	it("rewrites #case/<oldId> refs in XPath fields, not just labels", () => {
		const base = docWithTwoModulesAndForms();
		const start: BlueprintDoc = {
			...base,
			fields: {
				[Q("src")]: field_(Q("src"), "age", { case_property_on: "patient" }),
				[Q("ref")]: field_(Q("ref"), "adult_check", {
					calculate: "#case/age >= 18",
					relevant: "#case/age > 0",
				}),
			},
			fieldOrder: {
				[F("1")]: [Q("src")],
				[F("2")]: [Q("ref")],
			},
		};

		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "renameField",
				uuid: Q("src"),
				newId: "age_1",
			});
		});

		expect(asField(next.fields[Q("ref")])?.calculate).toBe("#case/age_1 >= 18");
		expect(asField(next.fields[Q("ref")])?.relevant).toBe("#case/age_1 > 0");
	});

	it("rewrites #<caseType>/<oldId> per-type refs app-wide, leaving other types alone", () => {
		// Per-type refs name their case type explicitly, so a `#mother/age`
		// ref resolves to mother from ANY form that can reach it — including a
		// CHILD module's form reading mother as an ancestor. Renaming mother's
		// `age` must rewrite it there too, while a `#pregnancy/age` ref to a
		// different type that shares the property name stays untouched.
		const start: BlueprintDoc = {
			appId: "test",
			appName: "A",
			connectType: null,
			caseTypes: null,
			modules: {
				[M("X")]: {
					uuid: M("X"),
					id: "m_x",
					name: "Mothers",
					caseType: "mother",
				} as Module,
				[M("P")]: {
					uuid: M("P"),
					id: "m_p",
					name: "Pregnancies",
					caseType: "pregnancy",
				} as Module,
			},
			forms: {
				[F("1")]: { uuid: F("1"), name: "F1", type: "followup" } as Form,
				[F("2")]: { uuid: F("2"), name: "F2", type: "followup" } as Form,
			},
			fields: {
				// Authoritative holder of mother's `age` property.
				[Q("src")]: field_(Q("src"), "age", { case_property_on: "mother" }),
				// A field in the CHILD module's form references mother's `age`
				// (an ancestor) and pregnancy's own `age` (same property name,
				// different type).
				[Q("ref")]: field_(Q("ref"), "adult_check", {
					calculate: "#mother/age + #pregnancy/age",
					label: "Mother age: #mother/age",
				}),
			},
			moduleOrder: [M("X"), M("P")],
			formOrder: { [M("X")]: [F("1")], [M("P")]: [F("2")] },
			fieldOrder: { [F("1")]: [Q("src")], [F("2")]: [Q("ref")] },
			fieldParent: {},
		};

		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "renameField",
				uuid: Q("src"),
				newId: "age_years",
			});
		});

		expect(next.fields[Q("src")]?.id).toBe("age_years");
		// `#mother/age` rewritten even though the ref lives in the CHILD
		// module's form (app-wide scope); `#pregnancy/age` left verbatim.
		expect(asField(next.fields[Q("ref")])?.calculate).toBe(
			"#mother/age_years + #pregnancy/age",
		);
		// Prose ref rewritten the same way.
		expect(asField(next.fields[Q("ref")])?.label).toBe(
			"Mother age: #mother/age_years",
		);
	});

	it("rewrites caseListConfig.columns on matching modules only", () => {
		const base = docWithTwoModulesAndForms();
		const start: BlueprintDoc = {
			...base,
			fields: {
				[Q("src")]: field_(Q("src"), "age", { case_property_on: "patient" }),
			},
			fieldOrder: { [F("1")]: [Q("src")] },
		};

		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "renameField",
				uuid: Q("src"),
				newId: "age_1",
			});
		});

		// Module X (caseType: patient) columns rewritten. The `field`
		// slot rewrites in place; the column's `uuid` survives the
		// rename so undo / drag-reorder identity stays stable.
		const modX = next.modules[M("X")];
		const xCols = modX?.caseListConfig?.columns ?? [];
		expect(xCols[0]).toMatchObject({
			uuid: C("xage"),
			field: "age_1",
			header: "Age",
		});
		expect(xCols[1]).toMatchObject({
			uuid: C("xname"),
			field: "name",
		});

		// Module Y (caseType: household) columns untouched.
		const modY = next.modules[M("Y")];
		const modYCol = asNonCalculatedColumn(
			modY?.caseListConfig?.columns[0],
			"module Y column 0",
		);
		expect(modYCol.field).toBe("age");
	});

	it("preserves a column's sort + visibility slots across a field-rename rewrite", () => {
		// The rewrite mutates `column.field` in place; every other slot
		// the column carries (`uuid`, `sort`, `visibleInList`,
		// `visibleInDetail`) must survive verbatim. Without the in-
		// place-on-the-field-slot guarantee, a future regression that
		// reconstructs the column object would silently drop the
		// optional slots and undo / preview state would diverge.
		const start: BlueprintDoc = {
			appId: "test",
			appName: "A",
			connectType: null,
			caseTypes: null,
			modules: {
				[M("X")]: {
					uuid: M("X"),
					id: "m_x",
					name: "ModX",
					caseType: "patient",
					caseListConfig: {
						columns: [
							{
								uuid: C("xage"),
								kind: "plain",
								field: "age",
								header: "Age",
								sort: { direction: "asc", priority: 0 },
								visibleInList: true,
								visibleInDetail: false,
							},
						],
						searchInputs: [],
					},
				} as Module,
			},
			forms: {
				[F("1")]: { uuid: F("1"), name: "F1", type: "followup" } as Form,
			},
			fields: {
				[Q("src")]: field_(Q("src"), "age", { case_property_on: "patient" }),
			},
			moduleOrder: [M("X")],
			formOrder: { [M("X")]: [F("1")] },
			fieldOrder: { [F("1")]: [Q("src")] },
			fieldParent: {},
		};

		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "renameField",
				uuid: Q("src"),
				newId: "age_1",
			});
		});

		const col = next.modules[M("X")]?.caseListConfig?.columns[0];
		expect(col).toEqual({
			uuid: C("xage"),
			kind: "plain",
			field: "age_1",
			header: "Age",
			sort: { direction: "asc", priority: 0 },
			visibleInList: true,
			visibleInDetail: false,
		});
	});

	it("skips calculated columns during the field-rename rewrite", () => {
		// Calculated columns have no `field` slot — the expression is
		// the source — so they must not be touched by the property-
		// name-as-string rewrite path. This loop only walks the
		// column-level `field` slot; the calc arm is skipped without
		// contributing to `columnsRewritten`.
		const start: BlueprintDoc = {
			appId: "test",
			appName: "A",
			connectType: null,
			caseTypes: null,
			modules: {
				[M("X")]: {
					uuid: M("X"),
					id: "m_x",
					name: "ModX",
					caseType: "patient",
					caseListConfig: {
						columns: [
							{
								uuid: C("xcalc"),
								kind: "calculated",
								header: "Computed",
								expression: {
									kind: "term",
									term: { kind: "literal", value: 1, data_type: "int" },
								},
							},
							{
								uuid: C("xage"),
								kind: "plain",
								field: "age",
								header: "Age",
							},
						],
						searchInputs: [],
					},
				} as Module,
			},
			forms: {
				[F("1")]: { uuid: F("1"), name: "F1", type: "followup" } as Form,
			},
			fields: {
				[Q("src")]: field_(Q("src"), "age", { case_property_on: "patient" }),
			},
			moduleOrder: [M("X")],
			formOrder: { [M("X")]: [F("1")] },
			fieldOrder: { [F("1")]: [Q("src")] },
			fieldParent: {},
		};

		let result: FieldRenameMeta | undefined;
		const next = produce(start, (d) => {
			result = applyMutation(d, {
				kind: "renameField",
				uuid: Q("src"),
				newId: "age_1",
			}) as FieldRenameMeta;
		});

		const cols = next.modules[M("X")]?.caseListConfig?.columns ?? [];
		// Calculated column survives unchanged.
		expect(cols[0]).toMatchObject({
			uuid: C("xcalc"),
			kind: "calculated",
			header: "Computed",
		});
		// Plain column rewritten.
		expect(cols[1]).toMatchObject({
			uuid: C("xage"),
			kind: "plain",
			field: "age_1",
		});
		// Counter reflects the single rewritten plain column; the
		// calculated arm was skipped without contributing to the count.
		expect(result?.columnsRewritten).toBe(1);
	});

	it("renames peer fields that declare the same (id, case_property_on) pair", () => {
		// The same case property is declared by two input fields in two
		// different forms (common when multiple forms read/write the case).
		// Renaming one must rename the peer so both still write to the same
		// property. Forms may be in different modules provided the fields
		// share the same case_property_on value.
		const base = docWithTwoModulesAndForms();
		const start: BlueprintDoc = {
			...base,
			fields: {
				[Q("src")]: field_(Q("src"), "age", { case_property_on: "patient" }),
				// Peer: same id, same case_property_on, different form.
				[Q("peer")]: field_(Q("peer"), "age", { case_property_on: "patient" }),
				// Not a peer: matching id but different case_property_on.
				[Q("other")]: field_(Q("other"), "age", {
					case_property_on: "household",
				}),
			},
			fieldOrder: {
				[F("1")]: [Q("src")],
				[F("2")]: [Q("peer")],
				[F("3")]: [Q("other")],
			},
		};

		let result: FieldRenameMeta | undefined;
		const next = produce(start, (d) => {
			result = applyMutation(d, {
				kind: "renameField",
				uuid: Q("src"),
				newId: "age_1",
			}) as FieldRenameMeta;
		});

		expect(next.fields[Q("src")]?.id).toBe("age_1");
		expect(next.fields[Q("peer")]?.id).toBe("age_1");
		// Non-peer (different case_property_on) stays as-is.
		expect(next.fields[Q("other")]?.id).toBe("age");
		expect(result?.peerFieldsRenamed).toBe(1);
		expect(result?.cascadedAcrossForms).toBe(true);
	});

	it("sets cascadedAcrossForms=true only when cascade touched other forms/modules", () => {
		const base = docWithTwoModulesAndForms();
		const start: BlueprintDoc = {
			...base,
			fields: {
				// Field with case_property_on but no cross-form refs, no peers,
				// and no columns on any module. A clean case_property_on-bearing
				// rename that cascades to nothing.
				[Q("src")]: field_(Q("src"), "lonely", { case_property_on: "patient" }),
			},
			fieldOrder: { [F("1")]: [Q("src")] },
			modules: {
				...base.modules,
				// Strip columns off module X so no column match is possible.
				[M("X")]: {
					...base.modules[M("X")],
					caseListConfig: undefined,
				} as Module,
			},
		};

		let result: FieldRenameMeta | undefined;
		produce(start, (d) => {
			result = applyMutation(d, {
				kind: "renameField",
				uuid: Q("src"),
				newId: "solo",
			}) as FieldRenameMeta;
		});

		expect(result?.peerFieldsRenamed).toBe(0);
		expect(result?.columnsRewritten).toBe(0);
		expect(result?.cascadedAcrossForms).toBe(false);
	});

	it("does not touch refs in form A when a same-named field in form B is renamed", () => {
		// Regression guard for the previous implementation, which walked every
		// field in the doc and over-rewrote `/data/<id>` refs across form
		// boundaries. Two forms each have a field called `source` — renaming
		// one must not affect the other's local /data/source references.
		const base = docWithTwoModulesAndForms();
		const start: BlueprintDoc = {
			...base,
			fields: {
				[Q("src_a")]: field_(Q("src_a"), "source"),
				[Q("ref_a")]: field_(Q("ref_a"), "ref_a", {
					calculate: "/data/source + 1",
				}),
				[Q("src_b")]: field_(Q("src_b"), "source"),
				[Q("ref_b")]: field_(Q("ref_b"), "ref_b", {
					calculate: "/data/source + 1",
				}),
			},
			fieldOrder: {
				[F("1")]: [Q("src_a"), Q("ref_a")],
				[F("2")]: [Q("src_b"), Q("ref_b")],
			},
		};

		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "renameField",
				uuid: Q("src_a"),
				newId: "primary",
			});
		});

		// Form 1 ref rewritten.
		expect(asField(next.fields[Q("ref_a")])?.calculate).toBe(
			"/data/primary + 1",
		);
		// Form 2 ref untouched — same path string, different form.
		expect(asField(next.fields[Q("ref_b")])?.calculate).toBe(
			"/data/source + 1",
		);
	});

	it("counts a field with both /data/ and #case/ refs exactly once", () => {
		// A single field with both a form-local path ref AND a cross-form
		// case hashtag ref gets rewritten by BOTH passes. The distinct-field
		// counter must dedupe — the UI toast "N references updated" should
		// report one field updated, not two.
		const base = docWithTwoModulesAndForms();
		const start: BlueprintDoc = {
			...base,
			fields: {
				// Primary holder of the `age` case property, in its own form.
				[Q("src")]: field_(Q("src"), "age", { case_property_on: "patient" }),
				// Same-form ref with /data/age reached by form-local pass.
				// AND #case/age reached by the cascade pass (module X's
				// caseType is "patient" → its forms are visited).
				[Q("ref")]: field_(Q("ref"), "display", {
					calculate: "/data/age + 1",
					label: "Age: #case/age",
				}),
			},
			fieldOrder: { [F("1")]: [Q("src"), Q("ref")] },
		};

		let result: FieldRenameMeta | undefined;
		const next = produce(start, (d) => {
			result = applyMutation(d, {
				kind: "renameField",
				uuid: Q("src"),
				newId: "age_1",
			}) as FieldRenameMeta;
		});

		// Both refs updated…
		expect(asField(next.fields[Q("ref")])?.calculate).toBe("/data/age_1 + 1");
		expect(asField(next.fields[Q("ref")])?.label).toBe("Age: #case/age_1");
		// …but `ref` is still exactly one field → count is 1.
		expect(result?.xpathFieldsRewritten).toBe(1);
	});

	it("does not set cascadedAcrossForms when only same-form #case/ refs were rewritten", () => {
		// `cascadedAcrossForms` tells consumers whether a form-only refresh
		// is enough. A same-form `#case/` rewrite is still same-form — the
		// flag must stay false.
		const base = docWithTwoModulesAndForms();
		const start: BlueprintDoc = {
			...base,
			fields: {
				[Q("src")]: field_(Q("src"), "age", { case_property_on: "patient" }),
				// Both the renamed field AND the ref live in F1. Module X
				// (F1's module) has caseType "patient" so the cascade visits
				// F1 and rewrites the #case/ ref — but F1 is the primary form.
				[Q("ref")]: field_(Q("ref"), "display", {
					label: "Age: #case/age",
				}),
			},
			fieldOrder: { [F("1")]: [Q("src"), Q("ref")] },
			modules: {
				...base.modules,
				// Strip columns off module X so the column rewrite doesn't
				// independently trigger the flag.
				[M("X")]: {
					...base.modules[M("X")],
					caseListConfig: undefined,
				} as Module,
			},
		};

		let result: FieldRenameMeta | undefined;
		produce(start, (d) => {
			result = applyMutation(d, {
				kind: "renameField",
				uuid: Q("src"),
				newId: "age_1",
			}) as FieldRenameMeta;
		});

		expect(result?.xpathFieldsRewritten).toBeGreaterThan(0);
		expect(result?.cascadedAcrossForms).toBe(false);
	});

	it("sets cascadedAcrossForms=true when only columns changed (no cross-form refs)", () => {
		// Positive slice: a rename whose ONLY cascade effect is column
		// rewrites. The flag must fire so consumers do a full-blueprint
		// refresh (module-level state can't be patched with a form refresh).
		const base = docWithTwoModulesAndForms();
		const start: BlueprintDoc = {
			...base,
			fields: {
				[Q("src")]: field_(Q("src"), "age", { case_property_on: "patient" }),
			},
			fieldOrder: { [F("1")]: [Q("src")] },
		};

		let result: FieldRenameMeta | undefined;
		produce(start, (d) => {
			result = applyMutation(d, {
				kind: "renameField",
				uuid: Q("src"),
				newId: "age_1",
			}) as FieldRenameMeta;
		});

		expect(result?.columnsRewritten).toBeGreaterThan(0);
		expect(result?.peerFieldsRenamed).toBe(0);
		expect(result?.cascadedAcrossForms).toBe(true);
	});

	it("cascades to the case_property_on's case type, not the primary's module's case type (child-case scenario)", () => {
		// Child-case pattern: a field on a form hosted in a "patient" module
		// but whose `case_property_on` is a different case type ("visit"). A
		// `#case/` ref resolves against the containing module's caseType, so
		// rewrites must happen in forms of modules with caseType === "visit",
		// NOT in forms of the "patient" module.
		const start: BlueprintDoc = {
			appId: "test",
			appName: "A",
			connectType: null,
			caseTypes: null,
			modules: {
				// Host module — "patient" caseType; field writes a child
				// "visit" case property.
				[M("host")]: {
					uuid: M("host"),
					id: "m_host",
					name: "Host",
					caseType: "patient",
					caseListConfig: {
						columns: [
							// This column belongs to "patient", NOT "visit" — must
							// remain untouched by a visit.date_of_visit rename.
							{
								uuid: C("hostvd"),
								kind: "plain",
								field: "date_of_visit",
								header: "Visit Date",
							},
						],
						searchInputs: [],
					},
				} as Module,
				// Target module — "visit" caseType. Cascade touches this one.
				[M("tgt")]: {
					uuid: M("tgt"),
					id: "m_tgt",
					name: "Target",
					caseType: "visit",
					caseListConfig: {
						columns: [
							{
								uuid: C("tgtvd"),
								kind: "plain",
								field: "date_of_visit",
								header: "Visit Date",
							},
						],
						searchInputs: [],
					},
				} as Module,
			},
			forms: {
				[F("host")]: {
					uuid: F("host"),
					name: "HostForm",
					type: "registration",
				} as Form,
				[F("tgt")]: {
					uuid: F("tgt"),
					name: "TgtForm",
					type: "followup",
				} as Form,
			},
			fields: {
				// Primary: lives in host form, writes to visit case.
				[Q("src")]: field_(Q("src"), "date_of_visit", {
					case_property_on: "visit",
				}),
				// Visit-module ref — SHOULD be rewritten (same caseType).
				[Q("tgt_ref")]: field_(Q("tgt_ref"), "display", {
					label: "Visit: #case/date_of_visit",
				}),
				// Host-module ref — in a "patient" module. `#case/` here
				// resolves to patient's property of that name (which doesn't
				// exist, but that's a validator concern). Must NOT be rewritten.
				[Q("host_ref")]: field_(Q("host_ref"), "host_display", {
					label: "Host says: #case/date_of_visit",
				}),
			},
			moduleOrder: [M("host"), M("tgt")],
			formOrder: { [M("host")]: [F("host")], [M("tgt")]: [F("tgt")] },
			fieldOrder: {
				[F("host")]: [Q("src"), Q("host_ref")],
				[F("tgt")]: [Q("tgt_ref")],
			},
			fieldParent: {},
		};

		let result: FieldRenameMeta | undefined;
		const next = produce(start, (d) => {
			result = applyMutation(d, {
				kind: "renameField",
				uuid: Q("src"),
				newId: "visit_date",
			}) as FieldRenameMeta;
		});

		// Primary id updated.
		expect(next.fields[Q("src")]?.id).toBe("visit_date");
		// Visit-module ref rewritten.
		expect(asField(next.fields[Q("tgt_ref")])?.label).toBe(
			"Visit: #case/visit_date",
		);
		// Host-module ref (different caseType) untouched.
		expect(asField(next.fields[Q("host_ref")])?.label).toBe(
			"Host says: #case/date_of_visit",
		);
		// Target module's column rewritten. The fixture seeds plain
		// columns on both modules; only the plain / reserved-scalar
		// arms carry a `field` slot.
		const tgtCol = asNonCalculatedColumn(
			next.modules[M("tgt")]?.caseListConfig?.columns[0],
			"target module column 0",
		);
		expect(tgtCol.field).toBe("visit_date");
		// Host module's column untouched (belongs to "patient" caseType).
		const hostCol = asNonCalculatedColumn(
			next.modules[M("host")]?.caseListConfig?.columns[0],
			"host module column 0",
		);
		expect(hostCol.field).toBe("date_of_visit");
		expect(result?.cascadedAcrossForms).toBe(true);
	});

	it("renames peers across three or more forms", () => {
		const base = docWithTwoModulesAndForms();
		const start: BlueprintDoc = {
			...base,
			// Add a third form to module X to make three same-case peers.
			formOrder: { [M("X")]: [F("1"), F("2"), F("3")] },
			fields: {
				[Q("a")]: field_(Q("a"), "age", { case_property_on: "patient" }),
				[Q("b")]: field_(Q("b"), "age", { case_property_on: "patient" }),
				[Q("c")]: field_(Q("c"), "age", { case_property_on: "patient" }),
			},
			fieldOrder: {
				[F("1")]: [Q("a")],
				[F("2")]: [Q("b")],
				[F("3")]: [Q("c")],
			},
		};

		let result: FieldRenameMeta | undefined;
		const next = produce(start, (d) => {
			result = applyMutation(d, {
				kind: "renameField",
				uuid: Q("a"),
				newId: "age_1",
			}) as FieldRenameMeta;
		});

		expect(next.fields[Q("a")]?.id).toBe("age_1");
		expect(next.fields[Q("b")]?.id).toBe("age_1");
		expect(next.fields[Q("c")]?.id).toBe("age_1");
		expect(result?.peerFieldsRenamed).toBe(2);
	});

	it("renames a peer in a mismatched-caseType module without rewriting its #case/ refs", () => {
		// Subtle cross-case-type write pattern: peer in form F2 of a module
		// whose caseType is "household", but the peer's own `case_property_on`
		// is "patient" (it writes to a different case than its host module's
		// caseType — child-case style). Renaming the primary must:
		//   - rename the peer (same id + same case_property_on = peer),
		//   - NOT rewrite `#case/<oldId>` inside the peer's form, because
		//     `#case/` in F2 resolves against F2's module caseType
		//     ("household"), a DIFFERENT property from the one being renamed.
		const start: BlueprintDoc = {
			appId: "test",
			appName: "A",
			connectType: null,
			caseTypes: null,
			modules: {
				[M("X")]: {
					uuid: M("X"),
					id: "m_x",
					name: "ModX",
					caseType: "patient",
				} as Module,
				[M("Y")]: {
					uuid: M("Y"),
					id: "m_y",
					name: "ModY",
					caseType: "household",
				} as Module,
			},
			forms: {
				[F("1")]: { uuid: F("1"), name: "F1", type: "followup" } as Form,
				[F("2")]: { uuid: F("2"), name: "F2", type: "followup" } as Form,
			},
			fields: {
				[Q("primary")]: field_(Q("primary"), "age", {
					case_property_on: "patient",
				}),
				// Peer: same id, same case_property_on (= "patient"), but lives
				// in module Y (caseType "household") — a cross-case-type write.
				[Q("peer")]: field_(Q("peer"), "age", {
					case_property_on: "patient",
				}),
				// Neighbor in F2 with a #case/age ref. Because F2's module
				// caseType is "household", this ref means "household.age",
				// NOT "patient.age". It must stay put.
				[Q("neighbor")]: field_(Q("neighbor"), "household_display", {
					label: "Household age: #case/age",
				}),
			},
			moduleOrder: [M("X"), M("Y")],
			formOrder: { [M("X")]: [F("1")], [M("Y")]: [F("2")] },
			fieldOrder: {
				[F("1")]: [Q("primary")],
				[F("2")]: [Q("peer"), Q("neighbor")],
			},
			fieldParent: {},
		};

		let result: FieldRenameMeta | undefined;
		const next = produce(start, (d) => {
			result = applyMutation(d, {
				kind: "renameField",
				uuid: Q("primary"),
				newId: "age_1",
			}) as FieldRenameMeta;
		});

		// Peer renamed (same id + case_property_on match).
		expect(next.fields[Q("peer")]?.id).toBe("age_1");
		// Neighbor's #case/age ref untouched — different case-type namespace.
		expect(asField(next.fields[Q("neighbor")])?.label).toBe(
			"Household age: #case/age",
		);
		expect(result?.peerFieldsRenamed).toBe(1);
	});

	it("renames the matching entry in doc.caseTypes catalog for the target case type", () => {
		// The case-type catalog is the authoritative list consulted by the
		// XPath linter, the `#case/` chip hydrator, and autocomplete. A
		// cascade that leaves the catalog stale makes freshly-valid refs
		// look "unknown" to every builder-time consumer — the chip won't
		// hydrate in prose and linter rejects the new name.
		const start: BlueprintDoc = {
			appId: "test",
			appName: "A",
			connectType: null,
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "age", label: "Age" },
						{ name: "name", label: "Name" },
					],
				},
				// Second case type with an `age` property that must NOT be
				// renamed — different caseType scope.
				{
					name: "household",
					properties: [{ name: "age", label: "Household Age" }],
				},
			],
			modules: {
				[M("X")]: {
					uuid: M("X"),
					id: "m_x",
					name: "ModX",
					caseType: "patient",
				} as Module,
			},
			forms: {
				[F("1")]: { uuid: F("1"), name: "F1", type: "followup" } as Form,
			},
			fields: {
				[Q("src")]: field_(Q("src"), "age", { case_property_on: "patient" }),
			},
			moduleOrder: [M("X")],
			formOrder: { [M("X")]: [F("1")] },
			fieldOrder: { [F("1")]: [Q("src")] },
			fieldParent: {},
		};

		let result: FieldRenameMeta | undefined;
		const next = produce(start, (d) => {
			result = applyMutation(d, {
				kind: "renameField",
				uuid: Q("src"),
				newId: "age_1",
			}) as FieldRenameMeta;
		});

		const patient = next.caseTypes?.find((c) => c.name === "patient");
		const household = next.caseTypes?.find((c) => c.name === "household");
		expect(patient?.properties.map((p) => p.name)).toEqual(["age_1", "name"]);
		// Other case types must be untouched — `household.age` is a different
		// property from `patient.age`.
		expect(household?.properties.map((p) => p.name)).toEqual(["age"]);
		expect(result?.catalogEntryRenamed).toBe(true);
		expect(result?.cascadedAcrossForms).toBe(true);
	});

	it("is a safe no-op on an empty blueprint (no modules, no forms)", () => {
		const start: BlueprintDoc = {
			appId: "test",
			appName: "A",
			connectType: null,
			caseTypes: null,
			modules: {},
			forms: {},
			fields: {
				// A field with case_property_on but no module references it —
				// simulates a pre-scaffold / partially-loaded state. The
				// rename should succeed without iterating empty module state.
				[Q("orphan")]: field_(Q("orphan"), "age", {
					case_property_on: "patient",
				}),
			},
			moduleOrder: [],
			formOrder: {},
			fieldOrder: {},
			fieldParent: {},
		};

		expect(() =>
			produce(start, (d) => {
				applyMutation(d, {
					kind: "renameField",
					uuid: Q("orphan"),
					newId: "age_1",
				});
			}),
		).not.toThrow();
	});
});
