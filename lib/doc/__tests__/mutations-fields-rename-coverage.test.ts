/**
 * Rename/move rewriter coverage over the reference-slot registry
 * (`lib/domain/referenceSlots.ts`).
 *
 * The registry must cover every applicable reference carrier. The first two
 * describe blocks preserve regressions that once came from hand-written slot
 * lists. Every field reference now stores identity, so rename/move changes only
 * its friendly projection; structural `(caseType, property)` references still
 * use their dedicated semantic cascade.
 */

import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	resolveCaseListConfig,
	resolveDocExpressions,
} from "@/lib/__tests__/docHelpers";
import { applyMutation } from "@/lib/doc/mutations";
import type { BlueprintDoc, Uuid } from "@/lib/doc/types";

import type { Field, Form, Module } from "@/lib/domain";
import {
	expressionSource,
	formExpressionSource,
	type ProseTemplate,
	printProseTemplate,
	printXPath,
	proseText,
	xpathPrintContext,
} from "@/lib/domain";
import {
	ancestorPath,
	eq,
	literal,
	prop,
	relationStep,
	subcasePath,
	term,
} from "@/lib/domain/predicate";

const M = (s: string) => testUuid(`mod${s}-0000-0000-0000-000000000000`);
const F = (s: string) => testUuid(`frm${s}-0000-0000-0000-000000000000`);
const Q = (s: string) => testUuid(`qst${s}-0000-0000-0000-000000000000`);
const C = (s: string) => testUuid(`col${s}-0000-0000-0000-000000000000`);
const S = (s: string) => testUuid(`sin${s}-0000-0000-0000-000000000000`);

/** Same loose fixture builder as `mutations-fields.test.ts`. */
function field_(
	uuid: Uuid,
	id: string,
	patch: Record<string, unknown> & { kind?: Field["kind"] } = {},
): Field {
	const { kind = "text", ...rest } = patch;
	return { uuid, id, kind, label: proseText(id), ...rest } as unknown as Field;
}

type AnyField =
	| {
			uuid: Uuid;
			id: string;
			kind: string;
			label?: ProseTemplate;
			hint?: ProseTemplate;
			help?: ProseTemplate;
			relevant?: string;
			required?: string;
			validate?: string;
			validate_msg?: ProseTemplate;
			calculate?: string;
			repeat_count?: string;
			data_source?: { ids_query: string };
			optionsSource?: {
				kind: "inline";
				options: Array<{
					uuid: Uuid;
					value: string;
					label: ProseTemplate;
				}>;
			};
	  }
	| undefined;

const asField = (f: Field | undefined): AnyField => f as AnyField;

function proseFieldRef(uuid: Uuid, prefix = "", suffix = ""): ProseTemplate {
	return {
		parts: [
			...(prefix.length > 0 ? [{ kind: "text" as const, text: prefix }] : []),
			{ kind: "field-ref", uuid },
			...(suffix.length > 0 ? [{ kind: "text" as const, text: suffix }] : []),
		],
	};
}

/** Printed text of an AST-stored expression slot. */
function printedSlot(
	doc: BlueprintDoc,
	uuid: Uuid,
	slot:
		| "calculate"
		| "relevant"
		| "validate"
		| "default_value"
		| "required"
		| "repeat_count"
		| "ids_query",
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

/** Update field `uuid` through the single canonical id-patch path. */
function updateFieldId(
	start: BlueprintDoc,
	uuid: Uuid,
	id: string,
): { next: BlueprintDoc } {
	const targetKind = start.fields[uuid]?.kind;
	if (targetKind === undefined) {
		throw new Error(`fixture: field ${uuid} missing`);
	}
	const next = produce(resolveDocExpressions(start), (d) => {
		applyMutation(d, {
			kind: "updateField",
			uuid,
			targetKind,
			patch: { id },
		} as Parameters<typeof applyMutation>[1]);
	});
	return { next };
}

// ── Live bug 1: `required` is an XPath surface ────────────────────

describe("updateField id patch rewrites `required` expressions", () => {
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
		const { next } = updateFieldId(start, Q("age"), "years");
		expect(printedSlot(next, Q("ref"), "required")).toBe("/data/years > 17");
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
		const { next } = updateFieldId(start, Q("age"), "years");
		expect(printedSlot(next, Q("ref"), "required")).toBe("#form/years > 17");
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
		const { next } = updateFieldId(start, Q("root"), "years");
		expect(printedSlot(next, Q("ref"), "required")).toBe("#form/grp/age > 17");
	});
});

// ── Live bug 2: help / validate_msg / option-label prose ──────────

describe("updateField id patch preserves identity-backed help/validate_msg/option-label prose", () => {
	it("projects a help reference through the field's current name", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("age")]: field_(Q("age"), "age", { kind: "int" }),
				[Q("ref")]: field_(Q("ref"), "weight", {
					help: proseFieldRef(Q("age"), "Compare with ", " before entering."),
				}),
			},
			fieldOrder: { [F("1")]: [Q("age"), Q("ref")] },
		};
		const { next } = updateFieldId(start, Q("age"), "years");
		const help = asField(next.fields[Q("ref")])?.help;
		if (!help) throw new Error("expected help template");
		expect(printProseTemplate(help, next)).toBe(
			"Compare with #form/years before entering.",
		);
	});

	it("projects a validation-message reference through the field's current name", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("age")]: field_(Q("age"), "age", { kind: "int" }),
				[Q("ref")]: field_(Q("ref"), "weight", {
					validate: ". > #form/age",
					validate_msg: proseFieldRef(Q("age"), "Must exceed ", "."),
				}),
			},
			fieldOrder: { [F("1")]: [Q("age"), Q("ref")] },
		};
		const { next } = updateFieldId(start, Q("age"), "years");
		const validateMessage = asField(next.fields[Q("ref")])?.validate_msg;
		if (!validateMessage) throw new Error("expected validation template");
		expect(printProseTemplate(validateMessage, next)).toBe(
			"Must exceed #form/years.",
		);
		// The paired validate XPath rewrites too (pre-existing coverage).
		expect(printedSlot(next, Q("ref"), "validate")).toBe(". > #form/years");
	});

	it("projects select-option references while leaving values alone", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("age")]: field_(Q("age"), "age", { kind: "int" }),
				[Q("sel")]: field_(Q("sel"), "bracket", {
					kind: "single_select",
					optionsSource: {
						kind: "inline",
						options: [
							{
								uuid: Q("option-age"),
								value: "age",
								label: proseFieldRef(Q("age"), "Exactly "),
							},
							{
								uuid: Q("option-other"),
								value: "other",
								label: proseText("Something else"),
							},
						],
					},
				}),
			},
			fieldOrder: { [F("1")]: [Q("age"), Q("sel")] },
		};
		const { next } = updateFieldId(start, Q("age"), "years");
		const options = asField(next.fields[Q("sel")])?.optionsSource?.options;
		if (!options?.[0] || !options[1]) {
			throw new Error("expected both inline options");
		}
		expect(printProseTemplate(options[0].label, next)).toBe(
			"Exactly #form/years",
		);
		// `optionsSource.options[].value` is a data literal, never a reference.
		expect(options[0].value).toBe("age");
		expect(printProseTemplate(options[1].label, next)).toBe("Something else");
	});
});

// ── Repeat slots: repeat_count + data_source.ids_query ────────────

describe("repeat slots follow renames at print", () => {
	it("a count_bound repeat's repeat_count resolves to the new name", () => {
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
		const { next } = updateFieldId(start, Q("n"), "child_count");
		expect(printedSlot(next, Q("rep"), "repeat_count")).toBe(
			"/data/child_count",
		);
	});

	it("a query_bound repeat's data_source.ids_query resolves to the new name", () => {
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
		const { next } = updateFieldId(start, Q("v"), "location");
		expect(printedSlot(next, Q("rep"), "ids_query")).toBe(
			"instance('casedb')/casedb/case[village = #form/location]/@case_id",
		);
	});
});

// ── Form-level wiring: form links, close condition, connect ───────

describe("updateField id patch rewrites the owning form's form-level wiring", () => {
	it("form_links[].condition follows an id patch at print", () => {
		const start: BlueprintDoc = {
			...docWithForm({
				formLinks: [
					{
						condition: "/data/refer = 'yes' and #form/refer != ''",
						target: { type: "module", moduleUuid: M("X") },
					},
				] as unknown as Form["formLinks"],
			}),
			fields: { [Q("r")]: field_(Q("r"), "refer") },
			fieldOrder: { [F("1")]: [Q("r")] },
		};
		const { next } = updateFieldId(start, Q("r"), "referral");
		const condition = next.forms[F("1")]?.formLinks?.[0]?.condition;
		expect(condition && printXPath(condition, xpathPrintContext(next))).toBe(
			"/data/referral = 'yes' and #form/referral != ''",
		);
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
				] as unknown as Form["formLinks"],
			}),
			fields: { [Q("s")]: field_(Q("s"), "selected_case") },
			fieldOrder: { [F("1")]: [Q("s")] },
		};
		const { next } = updateFieldId(start, Q("s"), "chosen_case");
		const link = next.forms[F("1")]?.formLinks?.[0];
		const datumXPath = link?.datums?.[0]?.xpath;
		expect(datumXPath && printXPath(datumXPath, xpathPrintContext(next))).toBe(
			"/data/chosen_case",
		);
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
				} as unknown as Form,
			},
			fields: {
				[Q("a1")]: field_(Q("a1"), "age", { kind: "int" }),
				[Q("a2")]: field_(Q("a2"), "age", { kind: "int" }),
			},
			formOrder: { [M("X")]: [F("1"), F("2")] },
			fieldOrder: { [F("1")]: [Q("a1")], [F("2")]: [Q("a2")] },
		};
		const { next } = updateFieldId(start, Q("a1"), "years");
		const otherCondition = next.forms[F("2")]?.formLinks?.[0]?.condition;
		expect(
			otherCondition && printXPath(otherCondition, xpathPrintContext(next)),
		).toBe("/data/age > 17");
	});

	it("a close condition keeps its field UUID through an id patch", () => {
		const start: BlueprintDoc = {
			...docWithForm({
				type: "close",
				closeCondition: { field: Q("o"), answer: "deceased" },
			}),
			fields: { [Q("o")]: field_(Q("o"), "outcome") },
			fieldOrder: { [F("1")]: [Q("o")] },
		};
		const { next } = updateFieldId(start, Q("o"), "case_outcome");
		expect(next.forms[F("1")]?.closeCondition?.field).toBe(Q("o"));
		expect(next.forms[F("1")]?.closeCondition?.answer).toBe("deceased");
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
		const { next } = updateFieldId(start, Q("o1"), "case_outcome");
		expect(next.forms[F("1")]?.closeCondition?.field).toBe(Q("o1"));
		expect(next.fields[Q("o1")]?.id).toBe("case_outcome");
		expect(next.fields[Q("o2")]?.id).toBe("outcome");
	});

	it("connect XPath slots follow an id patch at print", () => {
		const start: BlueprintDoc = {
			...docWithForm({
				connect: {
					assessment: { user_score: "/data/score * 10" },
					deliver_unit: {
						name: "visit",
						entity_id: "concat(#form/score, '-', today())",
						entity_name: "#form/score",
					},
				} as unknown as Form["connect"],
			}),
			fields: { [Q("s")]: field_(Q("s"), "score", { kind: "int" }) },
			fieldOrder: { [F("1")]: [Q("s")] },
		};
		const { next } = updateFieldId(start, Q("s"), "points");
		const form = next.forms[F("1")];
		if (!form) throw new Error("fixture form missing");
		expect(formExpressionSource(form, "assessment_user_score", next)).toBe(
			"/data/points * 10",
		);
		expect(formExpressionSource(form, "deliver_entity_id", next)).toBe(
			"concat(#form/points, '-', today())",
		);
		expect(formExpressionSource(form, "deliver_entity_name", next)).toBe(
			"#form/points",
		);
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
				] as unknown as Form["formLinks"],
				connect: {
					deliver_unit: { name: "visit", entity_name: "/data/score" },
				} as unknown as Form["connect"],
			}),
			fields: {
				[Q("grp")]: field_(Q("grp"), "grp", { kind: "group" }),
				[Q("s")]: field_(Q("s"), "score", { kind: "int" }),
			},
			fieldOrder: { [F("1")]: [Q("grp"), Q("s")], [Q("grp")]: [] },
		};
		const next = produce(resolveDocExpressions(start), (d) => {
			applyMutation(d, {
				kind: "moveField",
				uuid: Q("s"),
				toParentUuid: Q("grp"),
				after: null,
			});
		});
		const movedCondition = next.forms[F("1")]?.formLinks?.[0]?.condition;
		expect(
			movedCondition && printXPath(movedCondition, xpathPrintContext(next)),
		).toBe("#form/grp/score > 5");
		const movedForm = next.forms[F("1")];
		if (!movedForm) throw new Error("fixture form missing");
		expect(formExpressionSource(movedForm, "deliver_entity_name", next)).toBe(
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
	it("rewrites module and form display conditions", () => {
		const base = cascadeDoc({
			x: {
				displayCondition: eq(prop("patient", "age"), literal(18)),
			},
		});
		const form = base.forms[F("1")];
		if (!form) throw new Error("fixture form missing");
		const start: BlueprintDoc = {
			...base,
			forms: {
				...base.forms,
				[F("1")]: {
					...form,
					displayCondition: eq(prop("patient", "age"), literal(18)),
				} as Form,
			},
		};
		const { next } = updateFieldId(start, Q("src"), "years");
		expect(next.modules[M("X")]?.displayCondition).toEqual(
			eq(prop("patient", "years"), literal(18)),
		);
		expect(next.forms[F("1")]?.displayCondition).toEqual(
			eq(prop("patient", "years"), literal(18)),
		);
	});

	it("rewrites a matching PropertyRef in caseListConfig.filter", () => {
		const start = cascadeDoc({
			x: {
				caseListConfig: resolveCaseListConfig({
					columns: [],
					searchInputs: [],
					filter: eq(prop("patient", "age"), literal("1")),
				}),
			},
		});
		const { next } = updateFieldId(start, Q("src"), "years");
		const filter = next.modules[M("X")]?.caseListConfig?.filter;
		expect(filter).toEqual(eq(prop("patient", "years"), literal("1")));
	});

	it("does NOT rewrite a PropertyRef on a different case type", () => {
		const start = cascadeDoc({
			y: {
				caseListConfig: resolveCaseListConfig({
					columns: [],
					searchInputs: [],
					// household's own `age` property — same name, different type.
					filter: eq(prop("household", "age"), literal("1")),
				}),
			},
		});
		const { next } = updateFieldId(start, Q("src"), "years");
		const filter = next.modules[M("Y")]?.caseListConfig?.filter;
		expect(filter).toEqual(eq(prop("household", "age"), literal("1")));
	});

	it("rewrites a PropertyRef whose relation walk lands on the renamed type", () => {
		// Household module filtering on a PATIENT property through a
		// subcase walk: origin is `household`, destination (ofCaseType)
		// is `patient` — the property lives on the DESTINATION, so the
		// rename must follow it.
		const start = cascadeDoc({
			y: {
				caseListConfig: resolveCaseListConfig({
					columns: [],
					searchInputs: [],
					filter: eq(
						prop("household", "age", subcasePath("parent", "patient")),
						literal("1"),
					),
				}),
			},
		});
		const { next } = updateFieldId(start, Q("src"), "years");
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
				caseListConfig: resolveCaseListConfig({
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
				}),
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
		const { next } = updateFieldId(start, Q("reg"), "zone");
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
				caseListConfig: resolveCaseListConfig({
					columns: [],
					searchInputs: [],
					filter: eq(
						prop("patient", "region", ancestorPath(relationStep("parent"))),
						literal("north"),
					),
				}),
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
		const { next } = updateFieldId(start, Q("reg"), "zone");
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
				caseListConfig: resolveCaseListConfig({
					columns: [
						{
							uuid: C("calc"),
							kind: "calculated",
							header: "Age next year",
							expression: term(prop("patient", "age")),
						},
					],
					searchInputs: [],
				}),
			},
		});
		const { next } = updateFieldId(start, Q("src"), "years");
		const col = next.modules[M("X")]?.caseListConfig?.columns[0];
		expect(col).toMatchObject({
			kind: "calculated",
			expression: term(prop("patient", "years")),
		});
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
				caseListConfig: resolveCaseListConfig({
					columns: [],
					searchInputs: [inputDef(S("x"))],
				}),
			},
			y: {
				caseListConfig: resolveCaseListConfig({
					columns: [],
					searchInputs: [inputDef(S("y"))],
				}),
			},
		});
		const { next } = updateFieldId(start, Q("src"), "years");
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
				caseListConfig: resolveCaseListConfig({
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
				}),
			},
		});
		const { next } = updateFieldId(start, Q("src"), "years");
		const yInput = next.modules[M("Y")]?.caseListConfig?.searchInputs[0];
		expect(yInput).toMatchObject({ property: "years" });
	});

	it("rewrites advanced search-input predicates and input defaults", () => {
		const start = cascadeDoc({
			x: {
				caseListConfig: resolveCaseListConfig({
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
				}),
			},
		});
		const { next } = updateFieldId(start, Q("src"), "years");
		const inputDef = next.modules[M("X")]?.caseListConfig?.searchInputs[0];
		expect(inputDef).toMatchObject({
			predicate: eq(prop("patient", "years"), literal("18")),
			default: term(prop("patient", "years")),
		});
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
		const { next } = updateFieldId(start, Q("src"), "years");
		const search = next.modules[M("X")]?.caseSearchConfig;
		expect(search?.searchButtonDisplayCondition).toEqual(
			eq(prop("patient", "years"), literal("")),
		);
		expect(search?.excludedOwnerIds).toEqual(term(prop("patient", "years")));
	});

	it("rewrites case hashtags in another form's form-level wiring", () => {
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
							condition: {
								parts: [
									{
										kind: "case-ref",
										caseType: "patient",
										property: "age",
									},
									{ kind: "text", text: " > 17 and " },
									{
										kind: "case-ref",
										caseType: "patient",
										property: "age",
									},
									{ kind: "text", text: " > 17" },
								],
							},
							target: { type: "module", moduleUuid: M("X") },
						},
					],
				} as unknown as Form,
			},
			formOrder: { ...base.formOrder, [M("X")]: [F("1"), F("3")] },
			fieldOrder: { ...base.fieldOrder, [F("3")]: [] },
		};
		const { next } = updateFieldId(start, Q("src"), "years");
		const f3Condition = next.forms[F("3")]?.formLinks?.[0]?.condition;
		expect(
			f3Condition && printXPath(f3Condition, xpathPrintContext(next)),
		).toBe("#patient/years > 17 and #patient/years > 17");
	});
});

// ── Renamed-container descendants ──────────────────────────────────

describe("updateField id patch re-anchors refs to a renamed container's descendants", () => {
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
		const { next } = updateFieldId(start, Q("grp"), "grp2");
		expect(printedSlot(next, Q("ref"), "relevant")).toBe(
			"#form/grp2/inner = '1' and /data/grp2/inner != ''",
		);
	});

	it("projects descendant field refs through a renamed container", () => {
		const start: BlueprintDoc = {
			...docWithForm(),
			fields: {
				[Q("grp")]: field_(Q("grp"), "grp", { kind: "group" }),
				[Q("inner")]: field_(Q("inner"), "inner"),
				[Q("ref")]: field_(Q("ref"), "watcher", {
					label: proseFieldRef(Q("inner"), "Compare with ", " today"),
				}),
			},
			fieldOrder: {
				[F("1")]: [Q("grp"), Q("ref")],
				[Q("grp")]: [Q("inner")],
			},
		};
		const { next } = updateFieldId(start, Q("grp"), "grp2");
		const label = asField(next.fields[Q("ref")])?.label;
		if (!label) throw new Error("expected field label template");
		expect(printProseTemplate(label, next)).toBe(
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
		const { next } = updateFieldId(start, Q("grp"), "grp2");
		expect(printedSlot(next, Q("ref"), "relevant")).toBe(
			"#form/other/inner = '1'",
		);
	});
});
