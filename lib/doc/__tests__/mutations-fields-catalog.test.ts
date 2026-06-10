/**
 * Catalog sync at source (VBC Stage 0, Task 5).
 *
 * Every reducer arm that lands a field with — or changes a field to
 * have — a non-empty `case_property_on` must append the
 * `(case_type, property = field.id)` pair to `doc.caseTypes[].properties`
 * iff absent, mirroring the catalog maintenance the rename cascade
 * (`fields.ts::cascadeCasePropertyRename`) already performs on rename.
 * The catalog is the authoritative admission set for `#<type>/<prop>`
 * refs (the deep validator, inline linter, and autocomplete all read it
 * via `reachableCaseTypes`), so a writer the catalog lags makes
 * freshly-valid refs look unknown.
 *
 * Negative shapes pinned here: declared entries are never clobbered
 * (no data_type/label overwrite, no duplicates), removal never prunes,
 * and a move that doesn't rename adds nothing.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { validateBlueprintDeep } from "@/lib/commcare/validator";
import { applyMutation } from "@/lib/doc/mutations";
import type { BlueprintDoc, Mutation, Uuid } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";
import type { CaseProperty, Field, Form, Module } from "@/lib/domain";
import { buildDoc, f } from "../../__tests__/docHelpers";

const M = (s: string) => asUuid(`mod${s}-0000-0000-0000-000000000000`);
const F = (s: string) => asUuid(`frm${s}-0000-0000-0000-000000000000`);
const Q = (s: string) => asUuid(`qst${s}-0000-0000-0000-000000000000`);

/** Same loose fixture builder as `mutations-fields.test.ts`. */
function field_(
	uuid: Uuid,
	id: string,
	patch: Record<string, unknown> & { kind?: Field["kind"] } = {},
): Field {
	const { kind = "text", ...rest } = patch;
	return { uuid, id, kind, label: id, ...rest } as unknown as Field;
}

/**
 * One module (case type "patient") with two sibling forms, so tests can
 * exercise same-form sibling collisions and cross-form peers without
 * rebuilding the scaffolding per test.
 */
function docWithForms(
	caseTypes: BlueprintDoc["caseTypes"] = null,
): BlueprintDoc {
	return {
		appId: "test",
		appName: "A",
		connectType: null,
		caseTypes,
		modules: {
			[M("X")]: { uuid: M("X"), name: "M", caseType: "patient" } as Module,
		},
		forms: {
			[F("1")]: { uuid: F("1"), name: "F1", type: "followup" } as Form,
			[F("2")]: { uuid: F("2"), name: "F2", type: "followup" } as Form,
		},
		fields: {},
		moduleOrder: [M("X")],
		formOrder: { [M("X")]: [F("1"), F("2")] },
		fieldOrder: { [F("1")]: [], [F("2")]: [] },
		fieldParent: {},
	};
}

function apply(start: BlueprintDoc, ...muts: Mutation[]): BlueprintDoc {
	return produce(start, (d) => {
		for (const mut of muts) applyMutation(d, mut);
	});
}

function catalogProps(
	doc: BlueprintDoc,
	caseType: string,
): CaseProperty[] | undefined {
	return doc.caseTypes?.find((ct) => ct.name === caseType)?.properties;
}

const addField = (
	parentUuid: Uuid,
	field: Field,
	index?: number,
): Mutation => ({ kind: "addField", parentUuid, field, index });

describe("addField catalog sync", () => {
	it("appends the (case_type, field id) pair with the kind-derived data_type on a declared type", () => {
		const start = docWithForms([
			{ name: "patient", properties: [{ name: "case_name", label: "Name" }] },
		]);
		const next = apply(
			start,
			addField(
				F("1"),
				field_(Q("a"), "age", { kind: "int", case_property_on: "patient" }),
			),
		);
		expect(catalogProps(next, "patient")).toEqual([
			{ name: "case_name", label: "Name" },
			{ name: "age", label: "age", data_type: "int" },
		]);
	});

	it("is idempotent — a second writer of the same property adds nothing", () => {
		const start = docWithForms([{ name: "patient", properties: [] }]);
		const next = apply(
			start,
			addField(
				F("1"),
				field_(Q("a"), "age", { kind: "int", case_property_on: "patient" }),
			),
			addField(
				F("2"),
				field_(Q("b"), "age", { kind: "int", case_property_on: "patient" }),
			),
		);
		expect(
			catalogProps(next, "patient")?.filter((p) => p.name === "age"),
		).toHaveLength(1);
	});

	it("never clobbers a declared entry's data_type or label", () => {
		const declared: CaseProperty = {
			name: "age",
			label: "Age in years",
			data_type: "text",
		};
		const start = docWithForms([{ name: "patient", properties: [declared] }]);
		const next = apply(
			start,
			addField(
				F("1"),
				field_(Q("a"), "age", { kind: "int", case_property_on: "patient" }),
			),
		);
		expect(catalogProps(next, "patient")).toEqual([declared]);
	});

	it("creates the case-type entry when the type is undeclared", () => {
		const start = docWithForms(null);
		const next = apply(
			start,
			addField(
				F("1"),
				field_(Q("a"), "age", { kind: "int", case_property_on: "patient" }),
			),
		);
		expect(next.caseTypes).toEqual([
			{
				name: "patient",
				properties: [{ name: "age", label: "age", data_type: "int" }],
			},
		]);
	});

	it("appends a new type entry without touching declared siblings", () => {
		const start = docWithForms([{ name: "household", properties: [] }]);
		const next = apply(
			start,
			addField(
				F("1"),
				field_(Q("a"), "age", { kind: "int", case_property_on: "patient" }),
			),
		);
		expect(next.caseTypes?.map((ct) => ct.name)).toEqual([
			"household",
			"patient",
		]);
		expect(catalogProps(next, "household")).toEqual([]);
	});

	it("leaves the catalog untouched when the field has no case_property_on", () => {
		const start = docWithForms(null);
		const next = apply(start, addField(F("1"), field_(Q("a"), "age")));
		expect(next.caseTypes).toBeNull();
	});

	it("omits data_type for a hidden writer — the calculate's output type isn't pinned by the kind", () => {
		const start = docWithForms([{ name: "patient", properties: [] }]);
		const hidden = {
			uuid: Q("a"),
			id: "score",
			kind: "hidden",
			calculate: "1 + 1",
			case_property_on: "patient",
		} as unknown as Field;
		const next = apply(start, addField(F("1"), hidden));
		expect(catalogProps(next, "patient")).toEqual([
			{ name: "score", label: "score" },
		]);
	});
});

describe("updateField catalog sync", () => {
	it("appends when a patch sets case_property_on on an existing field", () => {
		const start = produce(
			docWithForms([{ name: "patient", properties: [] }]),
			(d) => {
				d.fields[Q("a")] = field_(Q("a"), "age");
				d.fieldOrder[F("1")] = [Q("a")];
			},
		);
		const next = apply(start, {
			kind: "updateField",
			uuid: Q("a"),
			targetKind: "text",
			patch: { case_property_on: "patient" },
		});
		expect(catalogProps(next, "patient")).toEqual([
			{ name: "age", label: "age", data_type: "text" },
		]);
	});

	it("appends the new pair when a patch changes the field id, without pruning the old one", () => {
		const start = produce(
			docWithForms([
				{
					name: "patient",
					properties: [{ name: "age", label: "age", data_type: "text" }],
				},
			]),
			(d) => {
				d.fields[Q("a")] = field_(Q("a"), "age", {
					case_property_on: "patient",
				});
				d.fieldOrder[F("1")] = [Q("a")];
			},
		);
		const next = apply(start, {
			kind: "updateField",
			uuid: Q("a"),
			targetKind: "text",
			patch: { id: "years" },
		});
		expect(catalogProps(next, "patient")).toEqual([
			{ name: "age", label: "age", data_type: "text" },
			{ name: "years", label: "years", data_type: "text" },
		]);
	});
});

describe("convertField catalog sync", () => {
	it("appends with the destination kind's data_type when the pair is absent", () => {
		const start = produce(
			docWithForms([{ name: "patient", properties: [] }]),
			(d) => {
				d.fields[Q("a")] = field_(Q("a"), "age", {
					kind: "int",
					case_property_on: "patient",
				});
				d.fieldOrder[F("1")] = [Q("a")];
			},
		);
		const next = apply(start, {
			kind: "convertField",
			uuid: Q("a"),
			toKind: "decimal",
		});
		expect(catalogProps(next, "patient")).toEqual([
			{ name: "age", label: "age", data_type: "decimal" },
		]);
	});

	it("leaves an existing entry untouched on convert — no data_type clobber", () => {
		const declared: CaseProperty = {
			name: "age",
			label: "age",
			data_type: "int",
		};
		const start = produce(
			docWithForms([{ name: "patient", properties: [declared] }]),
			(d) => {
				d.fields[Q("a")] = field_(Q("a"), "age", {
					kind: "int",
					case_property_on: "patient",
				});
				d.fieldOrder[F("1")] = [Q("a")];
			},
		);
		const next = apply(start, {
			kind: "convertField",
			uuid: Q("a"),
			toKind: "decimal",
		});
		expect(catalogProps(next, "patient")).toEqual([declared]);
	});
});

describe("duplicateField catalog sync", () => {
	it("registers the suffixed clone id as a new pair", () => {
		const start = produce(
			docWithForms([
				{
					name: "patient",
					properties: [{ name: "age", label: "age", data_type: "int" }],
				},
			]),
			(d) => {
				d.fields[Q("a")] = field_(Q("a"), "age", {
					kind: "int",
					case_property_on: "patient",
				});
				d.fieldOrder[F("1")] = [Q("a")];
			},
		);
		const next = apply(start, { kind: "duplicateField", uuid: Q("a") });
		expect(catalogProps(next, "patient")).toEqual([
			{ name: "age", label: "age", data_type: "int" },
			{ name: "age_2", label: "age_2", data_type: "int" },
		]);
	});
});

describe("moveField catalog sync", () => {
	it("registers the dedup-renamed id as a new pair (cross-parent move within one form)", () => {
		// `age` lives at F1's root AND inside F1's group — outdenting the
		// nested one collides with the root sibling, dedup renames it, and
		// the new (case type, property) pair lands in the catalog. Cross-FORM
		// moves never reach this path: the reducer warn-and-skips them.
		const start = produce(
			docWithForms([
				{
					name: "patient",
					properties: [{ name: "age", label: "age", data_type: "int" }],
				},
			]),
			(d) => {
				d.fields[Q("a")] = field_(Q("a"), "age", {
					kind: "int",
					case_property_on: "patient",
				});
				d.fields[Q("grp")] = field_(Q("grp"), "grp", { kind: "group" });
				d.fields[Q("b")] = field_(Q("b"), "age", {
					kind: "int",
					case_property_on: "patient",
				});
				d.fieldOrder[F("1")] = [Q("a"), Q("grp")];
				d.fieldOrder[Q("grp")] = [Q("b")];
			},
		);
		const next = apply(start, {
			kind: "moveField",
			uuid: Q("b"),
			toParentUuid: F("1"),
			toIndex: 2,
		});
		expect(next.fields[Q("b")]?.id).toBe("age_2");
		expect(catalogProps(next, "patient")).toEqual([
			{ name: "age", label: "age", data_type: "int" },
			{ name: "age_2", label: "age_2", data_type: "int" },
		]);
	});

	it("adds nothing on a move that doesn't rename", () => {
		const start = produce(docWithForms(null), (d) => {
			d.fields[Q("a")] = field_(Q("a"), "age", {
				kind: "int",
				case_property_on: "patient",
			});
			d.fields[Q("grp")] = field_(Q("grp"), "grp", { kind: "group" });
			d.fieldOrder[F("1")] = [Q("a"), Q("grp")];
			d.fieldOrder[Q("grp")] = [];
		});
		const next = apply(start, {
			kind: "moveField",
			uuid: Q("a"),
			toParentUuid: Q("grp"),
			toIndex: 0,
		});
		expect(next.caseTypes).toBeNull();
	});
});

describe("removeField — catalog is never pruned", () => {
	it("keeps the pair after its only writer is removed", () => {
		const start = docWithForms(null);
		const next = apply(
			start,
			addField(
				F("1"),
				field_(Q("a"), "age", { kind: "int", case_property_on: "patient" }),
			),
			{ kind: "removeField", uuid: Q("a") },
		);
		expect(next.fields[Q("a")]).toBeUndefined();
		expect(catalogProps(next, "patient")).toEqual([
			{ name: "age", label: "age", data_type: "int" },
		]);
	});
});

describe("renameField interplay", () => {
	it("the rename cascade moves the synced entry instead of duplicating it", () => {
		const start = docWithForms(null);
		const next = apply(
			start,
			addField(
				F("1"),
				field_(Q("a"), "age", { kind: "int", case_property_on: "patient" }),
			),
			{ kind: "renameField", uuid: Q("a"), newId: "years" },
		);
		expect(catalogProps(next, "patient")).toEqual([
			{ name: "years", label: "age", data_type: "int" },
		]);
	});

	it("a rename onto an existing property name merges — one entry, the declared one wins", () => {
		// Nothing blocks renaming a field onto another property's name (the
		// identifier verdicts check sibling FIELD ids only), so the catalog
		// pass must not mint a second entry: every by-name consumer
		// (`properties.find(...)`) is first-match, and a duplicate makes
		// resolution depend on insertion order forever (removal never
		// prunes). Merge semantics mirror `ensureCatalogProperty`: the
		// existing `newId` entry's declaration wins; the old entry is
		// dropped.
		const start = docWithForms([
			{
				name: "patient",
				properties: [
					{ name: "name", label: "Name", data_type: "text" },
					{ name: "age", label: "age", data_type: "int" },
				],
			},
		]);
		const next = apply(
			start,
			addField(
				F("1"),
				field_(Q("a"), "age", { kind: "int", case_property_on: "patient" }),
			),
			{ kind: "renameField", uuid: Q("a"), newId: "name" },
		);
		expect(catalogProps(next, "patient")).toEqual([
			{ name: "name", label: "Name", data_type: "text" },
		]);
	});
});

describe("acceptance — a writer-introduced property validates without setCaseTypes", () => {
	/**
	 * A followup form references `#patient/age` while `age` only exists as
	 * a field writer (`case_property_on: "patient"`) added AFTER the doc
	 * was scaffolded — no `setCaseTypes` ever runs. The deep validator
	 * reads the catalog (`reachableCaseTypes` over `doc.caseTypes`), so
	 * pre-sync the ref is rejected as INVALID_CASE_REF; the reducer-side
	 * catalog sync makes it validate clean.
	 */
	function scaffold(): BlueprintDoc {
		return buildDoc({
			caseTypes: null,
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							uuid: "frm-accept",
							name: "Visit",
							type: "followup",
							fields: [
								f({
									kind: "hidden",
									id: "flag",
									calculate: "#patient/age + 1",
								}),
							],
						},
					],
				},
			],
		});
	}

	const invalidCaseRefs = (doc: BlueprintDoc) =>
		validateBlueprintDeep(doc).filter(
			(e) => e.kind === "field-xpath" && e.error.code === "INVALID_CASE_REF",
		);

	it("rejects the ref while the property has no writer (the gap is real)", () => {
		expect(invalidCaseRefs(scaffold()).length).toBeGreaterThan(0);
	});

	it("validates clean once addField lands the writer", () => {
		const next = apply(
			scaffold(),
			addField(
				asUuid("frm-accept"),
				field_(Q("w"), "age", { kind: "int", case_property_on: "patient" }),
			),
		);
		expect(invalidCaseRefs(next)).toEqual([]);
	});
});
