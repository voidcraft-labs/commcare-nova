import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { applyMutation } from "@/lib/doc/mutations";
import type {
	FieldRenameMeta,
	MoveFieldResult,
} from "@/lib/doc/mutations/fields";
import type {
	BlueprintDoc,
	QuestionEntity as Field,
	FormEntity,
	ModuleEntity,
	Uuid,
} from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";

const M = (s: string) => asUuid(`mod${s}-0000-0000-0000-000000000000`);
const F = (s: string) => asUuid(`frm${s}-0000-0000-0000-000000000000`);
const Q = (s: string) => asUuid(`qst${s}-0000-0000-0000-000000000000`);

function field_(uuid: Uuid, id: string, patch: Partial<Field> = {}): Field {
	return { uuid, id, type: "text", ...patch } as Field;
}

function docWithForm(): BlueprintDoc {
	return {
		appId: "test",
		appName: "A",
		connectType: null,
		caseTypes: null,
		modules: { [M("X")]: { uuid: M("X"), name: "M" } as ModuleEntity },
		forms: {
			[F("1")]: { uuid: F("1"), name: "F", type: "survey" } as FormEntity,
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
				patch: { label: "Patient Name", required: "true" },
			});
		});
		expect(next.fields[Q("a")]?.label).toBe("Patient Name");
		expect(next.fields[Q("a")]?.required).toBe("true");
		expect(next.fields[Q("a")]?.id).toBe("name"); // Preserved
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
		expect(next.fields[Q("ref")]?.calculate).toBe("/data/grp/source + 1");
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
		expect(next.fields[Q("ref")]?.calculate).toContain("primary");
		expect(next.fields[Q("ref")]?.calculate).not.toContain("source");
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
	});
});
