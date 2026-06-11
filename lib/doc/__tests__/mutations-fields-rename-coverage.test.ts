/**
 * Rename/move rewriter coverage over the reference-slot registry
 * (`lib/domain/referenceSlots.ts`).
 *
 * Stage-0 Task 3: the rename cascade (form-local pass + case-property
 * cascade) and `moveField`'s rewrite passes must cover every applicable
 * registry slot. The first two describe blocks reproduce the two live
 * bugs that motivated the closure — `required` excluded from the old
 * hand-rolled XPath list under a stale comment, and the
 * `help` / `validate_msg` / option-label prose surfaces that the
 * validator declared as hashtag carriers but the cascade never
 * rewrote. The rest pin every newly covered slot: create a reference,
 * rename the referent, assert the reference follows — plus the
 * negative shapes (cousins sharing a leaf id, non-matching case
 * types, relation walks without an explicit destination).
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { resolveDocExpressions } from "@/lib/__tests__/docHelpers";
import { applyMutation } from "@/lib/doc/mutations";
import type { FieldRenameMeta } from "@/lib/doc/mutations/fields";
import type { BlueprintDoc, Uuid } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";
import type { Field, Form, Module } from "@/lib/domain";
import { expressionSource } from "@/lib/domain";
import {
	ancestorPath,
	eq,
	literal,
	prop,
	relationStep,
	subcasePath,
	term,
} from "@/lib/domain/predicate";

const M = (s: string) => asUuid(`mod${s}-0000-0000-0000-000000000000`);
const F = (s: string) => asUuid(`frm${s}-0000-0000-0000-000000000000`);
const Q = (s: string) => asUuid(`qst${s}-0000-0000-0000-000000000000`);
const C = (s: string) => asUuid(`col${s}-0000-0000-0000-000000000000`);
const S = (s: string) => asUuid(`sin${s}-0000-0000-0000-000000000000`);

/** Same loose fixture builder as `mutations-fields.test.ts`. */
function field_(
	uuid: Uuid,
	id: string,
	patch: Record<string, unknown> & { kind?: Field["kind"] } = {},
): Field {
	const { kind = "text", ...rest } = patch;
	return { uuid, id, kind, label: id, ...rest } as unknown as Field;
}

type AnyField =
	| {
			uuid: Uuid;
			id: string;
			kind: string;
			label?: string;
			hint?: string;
			help?: string;
			relevant?: string;
			required?: string;
			validate?: string;
			validate_msg?: string;
			calculate?: string;
			repeat_count?: string;
			data_source?: { ids_query: string };
			options?: Array<{ value: string; label: string }>;
	  }
	| undefined;

const asField = (f: Field | undefined): AnyField => f as AnyField;

/** Printed text of an AST-stored expression slot. */
function printedSlot(
	doc: BlueprintDoc,
	uuid: Uuid,
	slot: "calculate" | "relevant" | "validate" | "default_value",
): string | undefined {
	const field = doc.fields[uuid];
	return field ? expressionSource(field, slot, doc) : undefined;
}

function docWithForm(form: Partial<Form> = {}): BlueprintDoc {
	return {
		appId: "test",
		appName: "A",
		connectType: null,
		caseTypes: null,
		modules: { [M("X")]: { uuid: M("X"), name: "M" } as Module },
		forms: {
			[F("1")]: {
				uuid: F("1"),
				name: "F",
				type: "survey",
				...form,
			} as Form,
		},
		fields: {},
		moduleOrder: [M("X")],
		formOrder: { [M("X")]: [F("1")] },
		fieldOrder: { [F("1")]: [] },
		fieldParent: {},
	};
}

/** Rename field `uuid` to `newId` and return the resulting doc + meta. */
function rename(
	start: BlueprintDoc,
	uuid: Uuid,
	newId: string,
): { next: BlueprintDoc; meta: FieldRenameMeta | undefined } {
	let meta: FieldRenameMeta | undefined;
	const next = produce(resolveDocExpressions(start), (d) => {
		meta = applyMutation(d, { kind: "renameField", uuid, newId }) as
			| FieldRenameMeta
			| undefined;
	});
	return { next, meta };
}

// ── Live bug 1: `required` is an XPath surface ────────────────────

describe("renameField rewrites `required` expressions (live bug)", () => {
	it("follows a /data/ path ref in another field's required", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("age")]: field_(Q("age"), "age", { kind: "int" }),
				[Q("ref")]: field_(Q("ref"), "consent", {
					required: "/data/age > 17",
				}),
			},
			fieldOrder: { [F("1")]: [Q("age"), Q("ref")] },
		};
		const { next } = rename(start, Q("age"), "years");
		expect(asField(next.fields[Q("ref")])?.required).toBe("/data/years > 17");
	});

	it("follows a #form/ hashtag ref in required", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("age")]: field_(Q("age"), "age", { kind: "int" }),
				[Q("ref")]: field_(Q("ref"), "consent", {
					required: "#form/age > 17",
				}),
			},
			fieldOrder: { [F("1")]: [Q("age"), Q("ref")] },
		};
		const { next } = rename(start, Q("age"), "years");
		expect(asField(next.fields[Q("ref")])?.required).toBe("#form/years > 17");
	});

	it("does NOT rewrite a required ref to a cousin sharing the leaf id", () => {
		// `grp/age` and root `age` are cousins. The required expression
		// references the NESTED one (`#form/grp/age`); renaming the ROOT
		// `age` must leave it alone (full-path matching).
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("grp")]: field_(Q("grp"), "grp", { kind: "group" }),
				[Q("nested")]: field_(Q("nested"), "age", { kind: "int" }),
				[Q("root")]: field_(Q("root"), "age", { kind: "int" }),
				[Q("ref")]: field_(Q("ref"), "consent", {
					required: "#form/grp/age > 17",
				}),
			},
			fieldOrder: {
				[F("1")]: [Q("grp"), Q("root"), Q("ref")],
				[Q("grp")]: [Q("nested")],
			},
		};
		const { next } = rename(start, Q("root"), "years");
		expect(asField(next.fields[Q("ref")])?.required).toBe("#form/grp/age > 17");
	});
});

// ── Live bug 2: help / validate_msg / option-label prose ──────────

describe("renameField rewrites help/validate_msg/option-label prose (live bug)", () => {
	it("rewrites hashtag refs embedded in help text", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("age")]: field_(Q("age"), "age", { kind: "int" }),
				[Q("ref")]: field_(Q("ref"), "weight", {
					help: "Compare with #form/age before entering.",
				}),
			},
			fieldOrder: { [F("1")]: [Q("age"), Q("ref")] },
		};
		const { next } = rename(start, Q("age"), "years");
		expect(asField(next.fields[Q("ref")])?.help).toBe(
			"Compare with #form/years before entering.",
		);
	});

	it("rewrites hashtag refs embedded in validate_msg text", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("age")]: field_(Q("age"), "age", { kind: "int" }),
				[Q("ref")]: field_(Q("ref"), "weight", {
					validate: ". > #form/age",
					validate_msg: "Must exceed #form/age.",
				}),
			},
			fieldOrder: { [F("1")]: [Q("age"), Q("ref")] },
		};
		const { next } = rename(start, Q("age"), "years");
		expect(asField(next.fields[Q("ref")])?.validate_msg).toBe(
			"Must exceed #form/years.",
		);
		// The paired validate XPath rewrites too (pre-existing coverage).
		expect(printedSlot(next, Q("ref"), "validate")).toBe(". > #form/years");
	});

	it("rewrites hashtag refs in select option labels, leaving values alone", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("age")]: field_(Q("age"), "age", { kind: "int" }),
				[Q("sel")]: field_(Q("sel"), "bracket", {
					kind: "single_select",
					options: [
						{ value: "age", label: "Exactly #form/age" },
						{ value: "other", label: "Something else" },
					],
				}),
			},
			fieldOrder: { [F("1")]: [Q("age"), Q("sel")] },
		};
		const { next } = rename(start, Q("age"), "years");
		const options = asField(next.fields[Q("sel")])?.options;
		expect(options?.[0]?.label).toBe("Exactly #form/years");
		// `options[].value` is a data literal, never a reference.
		expect(options?.[0]?.value).toBe("age");
		expect(options?.[1]?.label).toBe("Something else");
	});
});

// ── Repeat slots: repeat_count + data_source.ids_query ────────────

describe("renameField rewrites repeat slots", () => {
	it("rewrites a count_bound repeat's repeat_count", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("n")]: field_(Q("n"), "n_children", { kind: "int" }),
				[Q("rep")]: field_(Q("rep"), "children", {
					kind: "repeat",
					repeat_mode: "count_bound",
					repeat_count: "/data/n_children",
				}),
			},
			fieldOrder: { [F("1")]: [Q("n"), Q("rep")], [Q("rep")]: [] },
		};
		const { next } = rename(start, Q("n"), "child_count");
		expect(asField(next.fields[Q("rep")])?.repeat_count).toBe(
			"/data/child_count",
		);
	});

	it("rewrites a query_bound repeat's data_source.ids_query", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("v")]: field_(Q("v"), "village", { kind: "text" }),
				[Q("rep")]: field_(Q("rep"), "members", {
					kind: "repeat",
					repeat_mode: "query_bound",
					data_source: {
						ids_query:
							"instance('casedb')/casedb/case[village = #form/village]/@case_id",
					},
				}),
			},
			fieldOrder: { [F("1")]: [Q("v"), Q("rep")], [Q("rep")]: [] },
		};
		const { next } = rename(start, Q("v"), "location");
		expect(asField(next.fields[Q("rep")])?.data_source?.ids_query).toBe(
			"instance('casedb')/casedb/case[village = #form/location]/@case_id",
		);
	});
});

// ── Form-level wiring: form links, close condition, connect ───────

describe("renameField rewrites the owning form's form-level wiring", () => {
	it("rewrites form_links[].condition (path and hashtag refs)", () => {
		const start: BlueprintDoc = {
			...docWithForm({
				formLinks: [
					{
						condition: "/data/refer = 'yes' and #form/refer != ''",
						target: { type: "module", moduleUuid: M("X") },
					},
				],
			}),
			fields: { [Q("r")]: field_(Q("r"), "refer") },
			fieldOrder: { [F("1")]: [Q("r")] },
		};
		const { next, meta } = rename(start, Q("r"), "referral");
		expect(next.forms[F("1")]?.formLinks?.[0]?.condition).toBe(
			"/data/referral = 'yes' and #form/referral != ''",
		);
		expect(meta?.formWiringRewritten).toBe(1);
	});

	it("rewrites form_links[].datums[].xpath but never the datum name", () => {
		const start: BlueprintDoc = {
			...docWithForm({
				formLinks: [
					{
						target: {
							type: "form",
							moduleUuid: M("X"),
							formUuid: F("1"),
						},
						datums: [{ name: "case_id", xpath: "/data/selected_case" }],
					},
				],
			}),
			fields: { [Q("s")]: field_(Q("s"), "selected_case") },
			fieldOrder: { [F("1")]: [Q("s")] },
		};
		const { next } = rename(start, Q("s"), "chosen_case");
		const link = next.forms[F("1")]?.formLinks?.[0];
		expect(link?.datums?.[0]?.xpath).toBe("/data/chosen_case");
		// The datum NAME is the target entry's session-variable token
		// (wire vocabulary), not a field reference.
		expect(link?.datums?.[0]?.name).toBe("case_id");
	});

	it("does NOT touch another form's link conditions (source-form scoping)", () => {
		// Form-link conditions evaluate against the form that OWNS the
		// link (CCHQ end-of-form navigation: workflow.py passes
		// link.xpath verbatim into the source form's stack frame). Form 2
		// has its own field named `age` and a link condition referencing
		// it; renaming form 1's `age` must not touch form 2's wiring.
		const base = docWithForm();
		const start: BlueprintDoc = {
			...base,
			forms: {
				...base.forms,
				[F("2")]: {
					uuid: F("2"),
					name: "F2",
					type: "survey",
					formLinks: [
						{
							condition: "/data/age > 17",
							target: { type: "module", moduleUuid: M("X") },
						},
					],
				} as Form,
			},
			fields: {
				[Q("a1")]: field_(Q("a1"), "age", { kind: "int" }),
				[Q("a2")]: field_(Q("a2"), "age", { kind: "int" }),
			},
			formOrder: { [M("X")]: [F("1"), F("2")] },
			fieldOrder: { [F("1")]: [Q("a1")], [F("2")]: [Q("a2")] },
		};
		const { next } = rename(start, Q("a1"), "years");
		expect(next.forms[F("2")]?.formLinks?.[0]?.condition).toBe(
			"/data/age > 17",
		);
	});

	it("a close condition follows its field's rename with zero rewrites — the ref is its uuid", () => {
		const start: BlueprintDoc = {
			...docWithForm({
				type: "close",
				closeCondition: { field: Q("o"), answer: "deceased" },
			}),
			fields: { [Q("o")]: field_(Q("o"), "outcome") },
			fieldOrder: { [F("1")]: [Q("o")] },
		};
		const { next, meta } = rename(start, Q("o"), "case_outcome");
		expect(next.forms[F("1")]?.closeCondition?.field).toBe(Q("o"));
		expect(next.forms[F("1")]?.closeCondition?.answer).toBe("deceased");
		expect(meta?.formWiringRewritten).toBe(0);
	});

	it("a cousin sharing the target's id can't confuse the ref — identity, not text", () => {
		// The id-stored era left the ref alone on ambiguity (rewriting could
		// retarget it). With the uuid stored, the ref names ONE field and
		// follows that field's rename whatever its cousins are called.
		const start: BlueprintDoc = {
			...docWithForm({
				type: "close",
				closeCondition: { field: Q("o1"), answer: "deceased" },
			}),
			fields: {
				[Q("grp")]: field_(Q("grp"), "grp", { kind: "group" }),
				[Q("o1")]: field_(Q("o1"), "outcome"),
				[Q("o2")]: field_(Q("o2"), "outcome"),
			},
			fieldOrder: {
				[F("1")]: [Q("grp"), Q("o1")],
				[Q("grp")]: [Q("o2")],
			},
		};
		const { next } = rename(start, Q("o1"), "case_outcome");
		expect(next.forms[F("1")]?.closeCondition?.field).toBe(Q("o1"));
		expect(next.fields[Q("o1")]?.id).toBe("case_outcome");
		expect(next.fields[Q("o2")]?.id).toBe("outcome");
	});

	it("rewrites the connect XPath slots (user_score, entity_id, entity_name)", () => {
		const start: BlueprintDoc = {
			...docWithForm({
				connect: {
					assessment: { user_score: "/data/score * 10" },
					deliver_unit: {
						name: "visit",
						entity_id: "concat(#form/score, '-', today())",
						entity_name: "#form/score",
					},
				},
			}),
			fields: { [Q("s")]: field_(Q("s"), "score", { kind: "int" }) },
			fieldOrder: { [F("1")]: [Q("s")] },
		};
		const { next, meta } = rename(start, Q("s"), "points");
		const connect = next.forms[F("1")]?.connect;
		expect(connect?.assessment?.user_score).toBe("/data/points * 10");
		expect(connect?.deliver_unit?.entity_id).toBe(
			"concat(#form/points, '-', today())",
		);
		expect(connect?.deliver_unit?.entity_name).toBe("#form/points");
		expect(meta?.formWiringRewritten).toBe(1);
	});
});

describe("moveField re-anchors form-level wiring", () => {
	it("re-anchors form link conditions and connect slots across a depth change", () => {
		const start: BlueprintDoc = {
			...docWithForm({
				formLinks: [
					{
						condition: "#form/score > 5",
						target: { type: "module", moduleUuid: M("X") },
					},
				],
				connect: {
					deliver_unit: { name: "visit", entity_name: "/data/score" },
				},
			}),
			fields: {
				[Q("grp")]: field_(Q("grp"), "grp", { kind: "group" }),
				[Q("s")]: field_(Q("s"), "score", { kind: "int" }),
			},
			fieldOrder: { [F("1")]: [Q("grp"), Q("s")], [Q("grp")]: [] },
		};
		const next = produce(start, (d) => {
			applyMutation(d, {
				kind: "moveField",
				uuid: Q("s"),
				toParentUuid: Q("grp"),
				toIndex: 0,
			});
		});
		expect(next.forms[F("1")]?.formLinks?.[0]?.condition).toBe(
			"#form/grp/score > 5",
		);
		expect(next.forms[F("1")]?.connect?.deliver_unit?.entity_name).toBe(
			"/data/grp/score",
		);
	});
});

// ── Case-property cascade: module AST slots ───────────────────────

/**
 * Two modules: X lists `patient` cases, Y lists `household` cases.
 * The renamed field lives in X's form and writes the `patient.age`
 * case property; per-slot tests hang module-level ASTs off X and Y to
 * assert (caseType, property) scoping.
 */
function cascadeDoc(modulePatches: {
	x?: Partial<Module>;
	y?: Partial<Module>;
}): BlueprintDoc {
	return {
		appId: "test",
		appName: "A",
		connectType: null,
		caseTypes: null,
		modules: {
			[M("X")]: {
				uuid: M("X"),
				id: "m_x",
				name: "Patients",
				caseType: "patient",
				...modulePatches.x,
			} as Module,
			[M("Y")]: {
				uuid: M("Y"),
				id: "m_y",
				name: "Households",
				caseType: "household",
				...modulePatches.y,
			} as Module,
		},
		forms: {
			[F("1")]: { uuid: F("1"), name: "F1", type: "followup" } as Form,
			[F("2")]: { uuid: F("2"), name: "F2", type: "followup" } as Form,
		},
		fields: {
			[Q("src")]: field_(Q("src"), "age", {
				kind: "int",
				case_property_on: "patient",
			}),
		},
		moduleOrder: [M("X"), M("Y")],
		formOrder: { [M("X")]: [F("1")], [M("Y")]: [F("2")] },
		fieldOrder: { [F("1")]: [Q("src")], [F("2")]: [] },
		fieldParent: {},
	};
}

describe("case-property cascade rewrites module predicate-AST slots", () => {
	it("rewrites a matching PropertyRef in caseListConfig.filter", () => {
		const start = cascadeDoc({
			x: {
				caseListConfig: {
					columns: [],
					searchInputs: [],
					filter: eq(prop("patient", "age"), literal("1")),
				},
			},
		});
		const { next, meta } = rename(start, Q("src"), "years");
		const filter = next.modules[M("X")]?.caseListConfig?.filter;
		expect(filter).toEqual(eq(prop("patient", "years"), literal("1")));
		expect(meta?.moduleRefsRewritten).toBe(1);
		expect(meta?.cascadedAcrossForms).toBe(true);
	});

	it("does NOT rewrite a PropertyRef on a different case type", () => {
		const start = cascadeDoc({
			y: {
				caseListConfig: {
					columns: [],
					searchInputs: [],
					// household's own `age` property — same name, different type.
					filter: eq(prop("household", "age"), literal("1")),
				},
			},
		});
		const { next, meta } = rename(start, Q("src"), "years");
		const filter = next.modules[M("Y")]?.caseListConfig?.filter;
		expect(filter).toEqual(eq(prop("household", "age"), literal("1")));
		expect(meta?.moduleRefsRewritten).toBe(0);
	});

	it("rewrites a PropertyRef whose relation walk lands on the renamed type", () => {
		// Household module filtering on a PATIENT property through a
		// subcase walk: origin is `household`, destination (ofCaseType)
		// is `patient` — the property lives on the DESTINATION, so the
		// rename must follow it.
		const start = cascadeDoc({
			y: {
				caseListConfig: {
					columns: [],
					searchInputs: [],
					filter: eq(
						prop("household", "age", subcasePath("parent", "patient")),
						literal("1"),
					),
				},
			},
		});
		const { next } = rename(start, Q("src"), "years");
		const filter = next.modules[M("Y")]?.caseListConfig?.filter;
		expect(filter).toEqual(
			eq(
				prop("household", "years", subcasePath("parent", "patient")),
				literal("1"),
			),
		);
	});

	it("rewrites an ancestor-walk PropertyRef matched on the LAST step's type hint", () => {
		// Renaming `household.region`: a patient-module ref reaches it via
		// `parent` with an explicit `throughCaseType: "household"` hint —
		// the walk's destination, where the property actually lives.
		const base = cascadeDoc({
			x: {
				caseListConfig: {
					columns: [],
					searchInputs: [],
					filter: eq(
						prop(
							"patient",
							"region",
							ancestorPath(relationStep("parent", "household")),
						),
						literal("north"),
					),
				},
			},
		});
		const start: BlueprintDoc = {
			...base,
			fields: {
				...base.fields,
				[Q("reg")]: field_(Q("reg"), "region", {
					case_property_on: "household",
				}),
			},
			fieldOrder: { ...base.fieldOrder, [F("2")]: [Q("reg")] },
		};
		const { next } = rename(start, Q("reg"), "zone");
		const filter = next.modules[M("X")]?.caseListConfig?.filter;
		expect(filter).toEqual(
			eq(
				prop(
					"patient",
					"zone",
					ancestorPath(relationStep("parent", "household")),
				),
				literal("north"),
			),
		);
	});

	it("does NOT rewrite a walk-qualified ref whose destination type is not encoded", () => {
		// An ancestor step WITHOUT `throughCaseType` doesn't say which
		// type the walk lands on — the rewrite cannot prove the property
		// is the renamed one, so it must leave the ref alone.
		const base = cascadeDoc({
			x: {
				caseListConfig: {
					columns: [],
					searchInputs: [],
					filter: eq(
						prop("patient", "region", ancestorPath(relationStep("parent"))),
						literal("north"),
					),
				},
			},
		});
		const start: BlueprintDoc = {
			...base,
			fields: {
				...base.fields,
				[Q("reg")]: field_(Q("reg"), "region", {
					case_property_on: "household",
				}),
			},
			fieldOrder: { ...base.fieldOrder, [F("2")]: [Q("reg")] },
		};
		const { next } = rename(start, Q("reg"), "zone");
		const filter = next.modules[M("X")]?.caseListConfig?.filter;
		expect(filter).toEqual(
			eq(
				prop("patient", "region", ancestorPath(relationStep("parent"))),
				literal("north"),
			),
		);
	});

	it("rewrites calculated column expressions", () => {
		const start = cascadeDoc({
			x: {
				caseListConfig: {
					columns: [
						{
							uuid: C("calc"),
							kind: "calculated",
							header: "Age next year",
							expression: term(prop("patient", "age")),
						},
					],
					searchInputs: [],
				},
			},
		});
		const { next, meta } = rename(start, Q("src"), "years");
		const col = next.modules[M("X")]?.caseListConfig?.columns[0];
		expect(col).toMatchObject({
			kind: "calculated",
			expression: term(prop("patient", "years")),
		});
		// Calculated columns count as AST refs, not as `columnsRewritten`
		// (that count is the property-name-as-string column rewrite).
		expect(meta?.columnsRewritten).toBe(0);
		expect(meta?.moduleRefsRewritten).toBe(1);
	});

	it("rewrites simple search-input property on the matching module only", () => {
		const inputDef = (uuid: Uuid) => ({
			uuid,
			kind: "simple" as const,
			name: "age_search",
			label: "Age",
			type: "text" as const,
			property: "age",
		});
		const start = cascadeDoc({
			x: {
				caseListConfig: {
					columns: [],
					searchInputs: [inputDef(S("x"))],
				},
			},
			y: {
				caseListConfig: {
					columns: [],
					searchInputs: [inputDef(S("y"))],
				},
			},
		});
		const { next } = rename(start, Q("src"), "years");
		const xInput = next.modules[M("X")]?.caseListConfig?.searchInputs[0];
		const yInput = next.modules[M("Y")]?.caseListConfig?.searchInputs[0];
		// Module X lists patients — its input targets patient.age → follows.
		expect(xInput).toMatchObject({ property: "years" });
		// Module Y lists households — its `age` is household.age → stays.
		expect(yInput).toMatchObject({ property: "age" });
	});

	it("rewrites a simple search-input property reached through a via walk", () => {
		// Household module searching on the PATIENT's age through a
		// subcase walk with an explicit destination type.
		const start = cascadeDoc({
			y: {
				caseListConfig: {
					columns: [],
					searchInputs: [
						{
							uuid: S("y"),
							kind: "simple" as const,
							name: "child_age",
							label: "Child age",
							type: "text" as const,
							property: "age",
							via: subcasePath("parent", "patient"),
						},
					],
				},
			},
		});
		const { next } = rename(start, Q("src"), "years");
		const yInput = next.modules[M("Y")]?.caseListConfig?.searchInputs[0];
		expect(yInput).toMatchObject({ property: "years" });
	});

	it("rewrites advanced search-input predicates and input defaults", () => {
		const start = cascadeDoc({
			x: {
				caseListConfig: {
					columns: [],
					searchInputs: [
						{
							uuid: S("adv"),
							kind: "advanced" as const,
							name: "age_filter",
							label: "Age filter",
							type: "text" as const,
							predicate: eq(prop("patient", "age"), literal("18")),
							default: term(prop("patient", "age")),
						},
					],
				},
			},
		});
		const { next, meta } = rename(start, Q("src"), "years");
		const inputDef = next.modules[M("X")]?.caseListConfig?.searchInputs[0];
		expect(inputDef).toMatchObject({
			predicate: eq(prop("patient", "years"), literal("18")),
			default: term(prop("patient", "years")),
		});
		expect(meta?.moduleRefsRewritten).toBe(2);
	});

	it("rewrites searchButtonDisplayCondition and excludedOwnerIds", () => {
		const start = cascadeDoc({
			x: {
				caseSearchConfig: {
					searchButtonDisplayCondition: eq(prop("patient", "age"), literal("")),
					excludedOwnerIds: term(prop("patient", "age")),
				},
			},
		});
		const { next, meta } = rename(start, Q("src"), "years");
		const search = next.modules[M("X")]?.caseSearchConfig;
		expect(search?.searchButtonDisplayCondition).toEqual(
			eq(prop("patient", "years"), literal("")),
		);
		expect(search?.excludedOwnerIds).toEqual(term(prop("patient", "years")));
		expect(meta?.moduleRefsRewritten).toBe(2);
		expect(meta?.cascadedAcrossForms).toBe(true);
	});

	it("rewrites case hashtags in another form's form-level wiring (phase-2 pass)", () => {
		// A form in a matching-caseType module references the renamed
		// case property in its form-link condition via `#case/` — the
		// cascade's hashtag pass must reach form-level slots, not just
		// field slots.
		const base = cascadeDoc({});
		const start: BlueprintDoc = {
			...base,
			forms: {
				...base.forms,
				[F("3")]: {
					uuid: F("3"),
					name: "F3",
					type: "followup",
					formLinks: [
						{
							condition: "#case/age > 17 and #patient/age > 17",
							target: { type: "module", moduleUuid: M("X") },
						},
					],
				} as Form,
			},
			formOrder: { ...base.formOrder, [M("X")]: [F("1"), F("3")] },
			fieldOrder: { ...base.fieldOrder, [F("3")]: [] },
		};
		const { next, meta } = rename(start, Q("src"), "years");
		expect(next.forms[F("3")]?.formLinks?.[0]?.condition).toBe(
			"#case/years > 17 and #patient/years > 17",
		);
		expect(meta?.formWiringRewritten).toBe(1);
		expect(meta?.cascadedAcrossForms).toBe(true);
	});
});

// ── Renamed-container descendants ──────────────────────────────────

describe("renameField re-anchors refs to a renamed CONTAINER's descendants", () => {
	it("rewrites descendant hashtag + absolute refs on XPath surfaces", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("grp")]: field_(Q("grp"), "grp", { kind: "group" }),
				[Q("inner")]: field_(Q("inner"), "inner"),
				[Q("ref")]: field_(Q("ref"), "watcher", {
					relevant: "#form/grp/inner = '1' and /data/grp/inner != ''",
				}),
			},
			fieldOrder: {
				[F("1")]: [Q("grp"), Q("ref")],
				[Q("grp")]: [Q("inner")],
			},
		};
		const { next } = rename(start, Q("grp"), "grp2");
		expect(printedSlot(next, Q("ref"), "relevant")).toBe(
			"#form/grp2/inner = '1' and /data/grp2/inner != ''",
		);
	});

	it("rewrites descendant hashtag refs embedded in prose surfaces", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("grp")]: field_(Q("grp"), "grp", { kind: "group" }),
				[Q("inner")]: field_(Q("inner"), "inner"),
				[Q("ref")]: field_(Q("ref"), "watcher", {
					label: "Compare with #form/grp/inner today",
				}),
			},
			fieldOrder: {
				[F("1")]: [Q("grp"), Q("ref")],
				[Q("grp")]: [Q("inner")],
			},
		};
		const { next } = rename(start, Q("grp"), "grp2");
		expect(asField(next.fields[Q("ref")])?.label).toBe(
			"Compare with #form/grp2/inner today",
		);
	});

	it("leaves a same-leaf cousin's descendant hashtag untouched", () => {
		// `other/inner` shares the `inner` leaf but is anchored under a
		// different container — renaming `grp` never touches it.
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("grp")]: field_(Q("grp"), "grp", { kind: "group" }),
				[Q("inner")]: field_(Q("inner"), "inner"),
				[Q("other")]: field_(Q("other"), "other", { kind: "group" }),
				[Q("inner2")]: field_(Q("inner2"), "inner"),
				[Q("ref")]: field_(Q("ref"), "watcher", {
					relevant: "#form/other/inner = '1'",
				}),
			},
			fieldOrder: {
				[F("1")]: [Q("grp"), Q("other"), Q("ref")],
				[Q("grp")]: [Q("inner")],
				[Q("other")]: [Q("inner2")],
			},
		};
		const { next } = rename(start, Q("grp"), "grp2");
		expect(printedSlot(next, Q("ref"), "relevant")).toBe(
			"#form/other/inner = '1'",
		);
	});
});
