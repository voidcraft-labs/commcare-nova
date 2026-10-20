/**
 * Every step of the cutover over the frozen pre-step fixtures (part 09 §5,
 * §15): the stored document each step writes and each notice line it
 * makes, the blockers it raises, and the whole transform's output, which
 * the head schema, the commit gate and export readiness admit, whose every
 * expression reads back through its own print, and which a second
 * application leaves unchanged.
 *
 * The plausible failures are a step that rewrites the wrong value (a
 * literal bound to the wrong choice, a division that keeps or loses its
 * integer meaning, a declaration of the wrong type), a lift that loses a
 * spelling the author's text carried (a relative path, an untyped query's
 * case type), a blocker that never fires or fires on an admitted document,
 * and a transform that is not a fixed point. Each observation reads the
 * stored target or the transform's result, never a helper's own output.
 *
 * The manifest names which step, class, blocker, blocking rule and reason
 * each fixture witnesses; the last block holds that each of them is
 * exercised here, or names the module that owns it.
 */

import { describe, expect, it } from "vitest";
import {
	exportReadinessFindings,
	mutationCommitVerdict,
} from "@/lib/doc/commitVerdicts";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { PersistableDoc } from "@/lib/domain/blueprint";
import type { Expression } from "@/lib/domain/expression/types";
import { walkExpression } from "@/lib/domain/expression/walk";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { roundTripFailures, transformApp } from "../transform";
import {
	CUTOVER_BLOCKER_CODES,
	CUTOVER_STOP_CODES,
	EXPRESSIONS_STEP_IDS,
	type TransformResult,
} from "../types";
import {
	carriersOfDoc,
	derivedCaseSchemas,
	fixtureCarriers,
	fixtureContext,
	MANIFEST,
	manifestFixture,
	transformFixture,
	transformWithFault,
} from "./transformHarness";

const results = new Map<string, TransformResult>();
function result(id: string): TransformResult {
	let cached = results.get(id);
	if (cached === undefined) {
		cached = transformFixture(id);
		results.set(id, cached);
	}
	return cached;
}

function target(id: string): PersistableDoc {
	const doc = result(id).target;
	if (doc === undefined) throw new Error(`${id} has no target`);
	return doc;
}

function field(id: string, fieldId: string, nth = 0) {
	const found = Object.values(target(id).fields).filter(
		(entry) => entry.id === fieldId,
	);
	const entry = found[nth];
	if (entry === undefined) throw new Error(`${id} has no field ${fieldId}`);
	return entry as unknown as Record<string, unknown>;
}

function form(id: string, formId: string) {
	const entry = Object.values(target(id).forms).find(
		(candidate) => candidate.id === formId,
	);
	if (entry === undefined) throw new Error(`${id} has no form ${formId}`);
	return entry;
}

function terms(expression: unknown): Record<string, unknown>[] {
	const found: Record<string, unknown>[] = [];
	walkExpression(expression as Expression, {
		visitTerm: (term) => found.push(term as unknown as Record<string, unknown>),
	});
	return found;
}

function classCount(id: string, step: string, cls: string): number {
	return (
		result(id).classes.find(
			(entry) => entry.step === step && entry.class === cls,
		)?.count ?? 0
	);
}

function blocker(r: TransformResult, code: string) {
	return r.blockers.find((entry) => entry.code === code);
}

function writeValue(id: string, formId: string, property: string): unknown {
	return form(id, formId)
		.caseOperations?.flatMap((operation) => operation.writes ?? [])
		.find((write) => write.property === property)?.value;
}

const CLEAN = MANIFEST.filter(
	(fixture) =>
		fixture.blockers.length === 0 && (fixture.faults ?? []).length === 0,
).map((fixture) => fixture.id);

describe("the transform's whole output", () => {
	it.each(CLEAN)(
		"%s lifts to a target the head schema, gate and export readiness admit, whose expressions read back",
		(id) => {
			const r = result(id);
			expect(r.blockers).toEqual([]);
			const doc = hydratePersistedBlueprint(target(id));
			const ctx = fixtureContext(manifestFixture(id));
			expect(mutationCommitVerdict(doc, [], ctx.lookupContext).ok).toBe(true);
			expect(
				exportReadinessFindings(doc, ctx.lookupContext, ctx.mediaAssets),
			).toEqual([]);
			expect(roundTripFailures(doc, { lookup: ctx.lookupContext })).toBe(0);
		},
	);

	it.each(
		MANIFEST.map((fixture) => fixture.id).filter(
			(id) => result(id).target !== undefined,
		),
	)("a second application to %s's output changes nothing", (id) => {
		const first = result(id);
		const ctx = fixtureContext(manifestFixture(id));
		// The second run reads the store as the drift writer leaves it after
		// the first: every stored row equal to the target's derivation.
		const second = transformApp(carriersOfDoc(target(id)), {
			...ctx,
			storedCaseSchemas: derivedCaseSchemas(target(id)),
		});
		expect(second.target && canonicalJsonDigest(second.target)).toBe(
			canonicalJsonDigest(target(id)),
		);
		expect(second.changes).toEqual([]);
		expect(second.schemaChanges).toEqual([]);
		// A declaration that met stored values was made; it is not made again.
		expect(second.blockers).toEqual(
			first.blockers.filter(
				(entry) =>
					entry.code !== "declared-property-has-stored-values" &&
					entry.code !== "case-schema-unplanned",
			),
		);
		expect(
			second.classes.filter(
				(entry) => entry.class !== "structural" && entry.class !== "lifted",
			),
		).toEqual([]);
	});
});

describe("step 1, catalog-rules", () => {
	it("deletes the three retired slots and names each property and what it held", () => {
		const property = target("catalog-rules")
			.caseTypes?.flatMap((caseType) => caseType.properties)
			.find((entry) => entry.name === "age") as Record<string, unknown>;
		expect(property).toBeDefined();
		for (const key of ["required", "validation", "validation_msg"])
			expect(Object.hasOwn(property, key)).toBe(false);
		expect(result("catalog-rules").changes).toEqual([
			{
				reason: "case-property-rules-removed",
				entity: {
					type: "app",
					nameAtMigration: target("catalog-rules").appName,
				},
				detail: {
					caseType: "patient",
					property: "age",
					rules: "required,validation,validation-message",
				},
			},
		]);
	});
	it("names only the rules a property held, and removes an empty one unnamed", () => {
		const carriers = fixtureCarriers("catalog-rules");
		const catalog = JSON.parse(carriers.root.case_types_text ?? "[]") as {
			properties: Record<string, unknown>[];
		}[];
		const properties = catalog[0]?.properties ?? [];
		const age = properties.find((entry) => entry.name === "age");
		if (age === undefined) throw new Error("catalog-rules has no age");
		// An empty expression and a blank message hold no rule.
		age.validation = { parts: [] };
		age.validation_msg = { parts: [{ kind: "text", text: "  " }] };
		// A property whose every rule is empty gets no line at all.
		properties.push({
			name: "weight",
			label: { parts: [{ kind: "text", text: "Weight" }] },
			required: { parts: [] },
		});
		const r = transformApp(
			{
				...carriers,
				root: { ...carriers.root, case_types_text: JSON.stringify(catalog) },
			},
			fixtureContext(manifestFixture("catalog-rules")),
		);
		const stored = r.target?.caseTypes?.flatMap(
			(caseType) => caseType.properties,
		) as Record<string, unknown>[] | undefined;
		for (const name of ["age", "weight"]) {
			const property = stored?.find((entry) => entry.name === name);
			expect(property, name).toBeDefined();
			for (const key of ["required", "validation", "validation_msg"])
				expect(Object.hasOwn(property ?? {}, key), `${name}.${key}`).toBe(
					false,
				);
		}
		expect(
			r.changes
				.filter((change) => change.reason === "case-property-rules-removed")
				.map((change) => change.detail),
		).toEqual([{ caseType: "patient", property: "age", rules: "required" }]);
		expect(r.classes.filter((entry) => entry.step === "catalog-rules")).toEqual(
			[{ step: "catalog-rules", class: "required", count: 1 }],
		);
	});
});

describe("step 2, form-link-datum-names", () => {
	it("resolves a manual datum id to the selected case the target entry supplies", () => {
		const link = form("form-link-manual", "register_frog").formLinks?.[0];
		const frogCare = Object.values(target("form-link-manual").modules).find(
			(module) => module.id === "frog_care",
		);
		expect(link?.datums?.[0]?.name).toEqual({
			kind: "selected-case",
			module: frogCare?.uuid,
		});
		expect(link?.datums?.[0]?.xpath).toEqual({
			kind: "term",
			term: { kind: "literal", value: "explicit-frog" },
		});
		expect(result("form-link-manual").changes).toEqual([]);
	});

	it("refuses a name no selection of the target carries", () => {
		const fault = manifestFixture("required-slot-guards").faults?.find(
			(entry) => entry.blocker === "form-link-datum-unresolved",
		);
		if (fault === undefined) throw new Error("no datum fault");
		const r = transformWithFault("required-slot-guards", fault);
		expect(blocker(r, "form-link-datum-unresolved")).toEqual({
			code: "form-link-datum-unresolved",
			count: 1,
			findingCodes: [],
		});
		expect(r.target).toBeUndefined();
	});
});

describe("step 3, record-expressions", () => {
	it("makes a division over two integers a quotient and keeps the others' bytes", () => {
		expect(writeValue("arithmetic", "calculate", "quotient")).toMatchObject({
			kind: "arith",
			op: "quotient",
		});
		expect(writeValue("arithmetic", "calculate", "large")).toMatchObject({
			kind: "arith",
			op: "quotient",
			left: { kind: "term", term: { kind: "literal", value: 2147483648 } },
		});
		expect(writeValue("arithmetic", "calculate", "mixed")).toMatchObject({
			kind: "arith",
			op: "div",
		});
		expect(writeValue("arithmetic", "calculate", "remainder")).toMatchObject({
			kind: "arith",
			op: "mod",
		});
		expect(classCount("arithmetic", "record-expressions", "quotient")).toBe(2);
		// Meaning and bytes are unchanged, so no line is written.
		expect(result("arithmetic").changes).toEqual([]);
	});

	it("binds a literal opposite a static select to its choice in eq, neq, in and switch", () => {
		const choice = field("choices", "choice");
		const many = field("choices", "choices");
		const options = (entry: Record<string, unknown>) =>
			(entry.optionsSource as { options: { value: string; uuid: string }[] })
				.options;
		const option = (value: string) =>
			options(choice).find((entry) => entry.value === value)?.uuid;
		const condition = form("choices", "visit").caseOperations?.[0]?.condition;
		expect(condition).toMatchObject({
			kind: "and",
			clauses: [
				{
					kind: "eq",
					right: {
						kind: "term",
						term: { kind: "choice", options: [option("yes")] },
					},
				},
				{
					kind: "neq",
					right: {
						kind: "term",
						term: { kind: "choice", options: [option("no")] },
					},
				},
				{
					kind: "in",
					values: [
						{ kind: "choice", options: [option("yes")] },
						{ kind: "choice", options: [option("no")] },
					],
				},
				{
					kind: "eq",
					right: {
						kind: "term",
						term: {
							kind: "choice",
							field: many.uuid,
							options: options(many).map((entry) => entry.uuid),
						},
					},
				},
			],
		});
		expect(writeValue("choices", "visit", "answer")).toMatchObject({
			kind: "switch",
			cases: [
				{
					when: {
						kind: "choice",
						field: choice.uuid,
						options: [option("yes")],
					},
				},
			],
		});
		expect(classCount("choices", "record-expressions", "choice")).toBe(2);
	});

	it("carries a record filter's bytes unchanged", () => {
		const row = fixtureCarriers("search-behavior").rows.find(
			(entry) => entry.kind === "module",
		);
		const module = target("search-behavior").modules[row?.uuid as never];
		expect(module?.caseListConfig?.filter).toEqual(
			JSON.parse(row?.data_text ?? "{}").caseListConfig.filter,
		);
		expect(
			classCount("search-behavior", "record-expressions", "structural"),
		).toBe(1);
	});
});

describe("step 4, form-logic-lift", () => {
	it("respells to the canonical print, keeps relative spellings and lifts an empty condition to absence", () => {
		expect(field("form-logic", "same_row").calculate).toEqual({
			kind: "term",
			term: {
				kind: "field",
				uuid: field("form-logic", "answer").uuid,
				spelling: "relative",
			},
		});
		expect(field("form-logic", "canonical").calculate).toMatchObject({
			kind: "arith",
			op: "+",
		});
		expect(
			Object.hasOwn(field("form-logic", "optional_empty"), "relevant"),
		).toBe(false);
		expect(classCount("form-logic", "form-logic-lift", "respelled")).toBe(1);
		expect(classCount("form-logic", "form-logic-lift", "empty")).toBe(1);
		expect(result("form-logic").changes).toContainEqual({
			reason: "expressions-respelled",
			entity: { type: "app", nameAtMigration: target("form-logic").appName },
			detail: { count: "1" },
		});
	});

	it("lifts choices in defaults and comparisons, and keeps a literal no option holds", () => {
		const choice = field("choices", "choice");
		expect(choice.default_value).toMatchObject({
			kind: "term",
			term: { kind: "choice", field: choice.uuid },
		});
		expect(
			(
				field("choices", "choices").default_value as {
					term: { options: unknown[] };
				}
			).term.options,
		).toHaveLength(2);
		expect(field("choices", "condition").relevant).toMatchObject({
			kind: "eq",
			right: { kind: "term", term: { kind: "choice", field: choice.uuid } },
		});
		expect(field("choices", "unmatched").relevant).toMatchObject({
			kind: "eq",
			right: { kind: "term", term: { kind: "literal", value: "retired" } },
		});
		// One line for the app: two record values and three form slots.
		expect(result("choices").changes).toContainEqual({
			reason: "expressions-follow-choices",
			entity: { type: "app", nameAtMigration: target("choices").appName },
			detail: { count: "5" },
		});
	});

	it("types case queries by literal, by case id and by the one declaring type, and reads the session", () => {
		const module = Object.values(target("case-query-bindings").modules)[0];
		expect(field("case-query-bindings", "typed").calculate).toMatchObject({
			kind: "project",
			of: {
				kind: "cases",
				source: "casedb",
				where: [
					{ right: { term: { kind: "case-type", caseType: "patient" } } },
				],
			},
			value: { kind: "prop", caseType: "patient", property: "known" },
		});
		expect(field("case-query-bindings", "unique").calculate).toEqual({
			kind: "project",
			of: { kind: "cases", source: "casedb", where: [] },
			value: { kind: "prop", caseType: "patient", property: "known" },
		});
		expect(field("case-query-bindings", "standard").calculate).toEqual({
			kind: "project",
			of: { kind: "cases", source: "casedb", where: [] },
			value: { kind: "prop", property: "case_id" },
		});
		expect(field("case-query-bindings", "by_id").calculate).toMatchObject({
			value: { kind: "prop", caseType: "patient", property: "known" },
		});
		expect(field("case-query-bindings", "selected").calculate).toEqual({
			kind: "term",
			term: {
				kind: "session-datum",
				datum: { kind: "selected-case", module: module?.uuid },
			},
		});
		expect(
			classCount("case-query-bindings", "form-logic-lift", "case-query"),
		).toBe(4);
		expect(
			classCount("case-query-bindings", "form-logic-lift", "session-datum"),
		).toBe(2);
	});

	it("lifts relative reads across a repeat, the current row's id and a query-bound repeat", () => {
		const id = "container-query-conditional-relative";
		const items = field(id, "items");
		expect(field(id, "item_id").calculate).toEqual({
			kind: "term",
			term: {
				kind: "repeat-row",
				repeat: items.uuid,
				attribute: "id",
				spelling: "current",
			},
		});
		expect(field(id, "confirm").relevant).toMatchObject({
			left: {
				term: {
					kind: "field",
					uuid: field(id, "show").uuid,
					spelling: "relative",
				},
			},
		});
		expect(items.repeat_mode).toBe("query_bound");
		expect(
			(items.data_source as { ids_query?: unknown }).ids_query,
		).toBeDefined();
		expect(classCount(id, "form-logic-lift", "relative")).toBe(4);
	});

	it("keeps a date-and-time ordering as an ordering of the two answers", () => {
		const start = String(field("targeted-datetime-ordering", "start").uuid);
		const order = Object.values(
			target("targeted-datetime-ordering").fields,
		).find(
			(entry) =>
				entry.id === "order" &&
				JSON.stringify((entry as { calculate?: unknown }).calculate).includes(
					start,
				),
		) as unknown as { calculate: unknown };
		expect(order.calculate).toMatchObject({
			kind: "if",
			cond: { kind: "lt", left: { term: { kind: "field", uuid: start } } },
		});
	});

	it("refuses an untyped query that no case type or several declare, with the parser's codes", () => {
		const r = result("untyped-case-query");
		expect(blocker(r, "expression-parse-refused")).toEqual({
			code: "expression-parse-refused",
			count: 2,
			findingCodes: ["case-query-untyped"],
		});
		const refusals = r.places.filter(
			(place) => place.code === "expression-parse-refused",
		);
		expect(refusals.map((place) => place.text?.split("\n")[0]).sort()).toEqual([
			"instance('casedb')/casedb/case/ambiguous",
			"instance('casedb')/casedb/case/unknown",
		]);
		expect(r.target).toBeUndefined();
	});

	it.each([
		["empty-datum-guard", ["formLinks", 0, "datums", 0, "xpath"]],
		["empty-repeat-count-guard", ["repeat_count"]],
		["empty-ids-query-guard", ["data_source", "ids_query"]],
	])("refuses an empty required slot (%s)", (_cls, path) => {
		const fault = manifestFixture("required-slot-guards").faults?.find(
			(entry) => JSON.stringify(entry.path) === JSON.stringify(path),
		);
		if (fault === undefined) throw new Error("no fault");
		const r = transformWithFault("required-slot-guards", fault);
		expect(blocker(r, "empty-required-expression")).toEqual({
			code: "empty-required-expression",
			count: 1,
			findingCodes: [],
		});
		expect(r.target).toBeUndefined();
	});

	it("names a leaf the frozen printer cannot resolve old-reference-dangling", () => {
		const fault = manifestFixture("context-and-guards").faults?.find(
			(entry) => entry.blocker === "old-reference-dangling",
		);
		if (fault === undefined) throw new Error("no fault");
		const r = transformWithFault("context-and-guards", fault);
		expect(blocker(r, "old-reference-dangling")).toMatchObject({ count: 1 });
		expect(r.target).toBeUndefined();
	});
});

describe("step 5, declare-read-properties", () => {
	it("declares each property a typed read names, by the least type its reads admit", () => {
		const declared = target("declare-read-properties")
			.caseTypes?.find((caseType) => caseType.name === "patient")
			?.properties.filter((property) => property.name.startsWith("new_"));
		expect(
			declared?.map(({ name, data_type, label }) => ({
				name,
				data_type,
				label,
			})),
		).toEqual(
			[
				["new_text", "text"],
				["new_number", "decimal"],
				["new_date", "date"],
				["new_moment", "datetime"],
			]
				.sort(([a], [b]) => (a < b ? -1 : 1))
				.map(([name, data_type]) => ({
					name,
					data_type,
					label: { parts: [{ kind: "text", text: name }] },
				})),
		);
		expect(
			result("declare-read-properties").changes.filter(
				(change) => change.reason === "case-property-declared",
			),
		).toContainEqual({
			reason: "case-property-declared",
			entity: {
				type: "app",
				nameAtMigration: target("declare-read-properties").appName,
			},
			detail: {
				caseType: "patient",
				property: "new_number",
				dataType: "decimal",
				form: form("declare-read-properties", "visit").name,
			},
		});
		expect(result("declare-read-properties").schemaChanges).toContainEqual({
			caseType: "patient",
			property: "new_moment",
			from: null,
			to: "datetime",
			source: "declared",
		});
	});

	it("leaves a property whose reads admit no common type undeclared, as a blocker", () => {
		const r = result("conflicting-read-types");
		expect(blocker(r, "declared-property-type-conflict")).toEqual({
			code: "declared-property-type-conflict",
			count: 1,
			findingCodes: [],
		});
		expect(
			r.changes.some((change) => change.reason === "case-property-declared"),
		).toBe(false);
	});

	it("refuses to declare a key the app's cases already hold", () => {
		expect(
			blocker(
				result("orphan-read-property"),
				"declared-property-has-stored-values",
			),
		).toEqual({
			code: "declared-property-has-stored-values",
			count: 1,
			findingCodes: [],
		});
	});
});

describe("step 6, repeat-read-first-row", () => {
	it("reads the first row where one value is needed, and names the read", () => {
		const rows = field("form-logic", "rows").uuid;
		const summary = field("form-logic", "summary");
		const read = terms(summary.calculate).find(
			(term) =>
				term.kind === "field" &&
				term.uuid === field("form-logic", "answer").uuid,
		);
		expect(read?.filters).toEqual([
			{
				step: { kind: "field", uuid: rows },
				where: [{ kind: "term", term: { kind: "literal", value: 1 } }],
			},
		]);
		expect(result("form-logic").changes).toContainEqual({
			reason: "repeat-read-takes-first-row",
			entity: { type: "field", uuid: summary.uuid, nameAtMigration: "summary" },
			detail: {
				form: form("form-logic", "visit").name,
				question: "answer",
				repeat: "rows",
			},
		});
	});

	it("leaves a several-value read in prose for the author", () => {
		const r = result("prose-repeat-read");
		expect(
			classCount("prose-repeat-read", "repeat-read-first-row", "first-row"),
		).toBe(0);
		expect(blocker(r, "target-gate")?.findingReasons).toContain(
			"XPATH_MANY_VALUES:repeat",
		);
	});
});

describe("step 7, lift-round-trip", () => {
	it("is a defect of the stack when a lifted tree does not survive its print", () => {
		const fault = manifestFixture("context-and-guards").faults?.find(
			(entry) => entry.blocker === "round-trip",
		);
		if (fault === undefined) throw new Error("no fault");
		const r = transformWithFault("context-and-guards", fault);
		expect(blocker(r, "round-trip")).toEqual({
			code: "round-trip",
			count: 1,
			findingCodes: [],
		});
	});
});

describe("after the last step", () => {
	it.each([
		["hidden-writer-mismatch", "HIDDEN_VALUE_WRITER_TYPE_MISMATCH"],
		["relative-cycle", "CYCLE"],
		["select-preload-write", "SELECT_PRELOAD_WRITE_NOT_AN_OPTION"],
		["record-inference", "CASE_LIST_FILTER_TYPE_ERROR"],
		["day-only-comparison", "XPATH_INCOMPATIBLE_VALUES:day-only-on-device"],
	])("%s is a target-gate blocker by %s", (id, finding) => {
		const gate = blocker(result(id), "target-gate");
		expect([
			...(gate?.findingCodes ?? []),
			...(gate?.findingReasons ?? []),
		]).toContain(finding);
	});

	it("reads a batch form's selected cases as one value as a target-gate blocker", () => {
		const fault = manifestFixture("selected-cases-scalar").faults?.[0];
		if (fault === undefined) throw new Error("no fault");
		const gate = blocker(
			transformWithFault("selected-cases-scalar", fault),
			"target-gate",
		);
		expect(gate?.findingReasons).toContain("XPATH_MANY_VALUES:selected-cases");
	});

	it("plans a property inference newly types, and refuses a schema difference no step planned", () => {
		expect(result("hidden-inference").schemaChanges).toEqual([
			{
				caseType: "patient",
				property: "score",
				from: "text",
				to: "int",
				source: "inferred",
			},
		]);
		// The fixture's stored row holds a property the target does not derive.
		const unplanned = transformApp(
			fixtureCarriers("context-and-guards"),
			fixtureContext(manifestFixture("context-and-guards")),
		);
		expect(blocker(unplanned, "case-schema-unplanned")).toMatchObject({
			count: 1,
		});
	});

	it.each(["target-parse", "target-export-readiness"])(
		"reports a target the head refuses as %s",
		(code) => {
			const fault = manifestFixture("context-and-guards").faults?.find(
				(entry) => entry.blocker === code,
			);
			if (fault === undefined) throw new Error("no fault");
			const r = transformWithFault("context-and-guards", fault);
			expect(blocker(r, code as never)).toMatchObject({ code });
		},
	);
});

/**
 * What each manifest class, blocking rule and reason looks like in the
 * transform's result. A reason the transform does not write names the
 * module that does; the transform's part is its input.
 */
const fault = (id: string, blockerCode: string) => {
	const entry = manifestFixture(id).faults?.find(
		(candidate) => candidate.blocker === blockerCode,
	);
	if (entry === undefined) throw new Error(`${id} has no ${blockerCode} fault`);
	return entry;
};
const guard = (path: string) => () => {
	const entry = manifestFixture("required-slot-guards").faults?.find(
		(candidate) => JSON.stringify(candidate.path) === path,
	);
	if (entry === undefined) throw new Error(`no fault at ${path}`);
	expect(
		blocker(
			transformWithFault("required-slot-guards", entry),
			"empty-required-expression",
		),
	).toBeDefined();
};
const hasClass = (step: string, cls: string) => (id: string) =>
	expect(classCount(id, step, cls)).toBeGreaterThan(0);
const CLASS_WITNESSES: Record<string, (id: string) => void> = {
	"datetime-ordering": (id) =>
		expect(
			Object.values(target(id).fields).some(
				(entry) =>
					(entry as { calculate?: { cond?: { kind?: string } } }).calculate
						?.cond?.kind === "lt",
			),
		).toBe(true),
	"relative-across-repeat": hasClass("form-logic-lift", "relative"),
	"current-repeat-row": (id) =>
		expect(field(id, "item_id").calculate).toMatchObject({
			term: { kind: "repeat-row", spelling: "current" },
		}),
	"query-bound-repeat": (id) =>
		expect(field(id, "items")).toMatchObject({ repeat_mode: "query_bound" }),
	"manual-datum": hasClass("form-link-datum-names", "datum-name"),
	"record-integer-division": hasClass("record-expressions", "quotient"),
	"record-decimal-division": (id) =>
		expect(writeValue(id, "calculate", "mixed")).toMatchObject({ op: "div" }),
	"catalog-required": hasClass("catalog-rules", "required"),
	"catalog-validation": hasClass("catalog-rules", "validation"),
	"catalog-validation-message": hasClass("catalog-rules", "validation-message"),
	"select-literal-default": (id) =>
		expect(field(id, "choice").default_value).toMatchObject({
			term: { kind: "choice" },
		}),
	"select-comparison": (id) =>
		expect(field(id, "condition").relevant).toMatchObject({
			right: { term: { kind: "choice" } },
		}),
	"record-choice-eq": hasClass("record-expressions", "choice"),
	"record-choice-neq": (id) =>
		expect(JSON.stringify(form(id, "visit").caseOperations)).toMatch(
			/"kind":"neq".*?"kind":"choice"/u,
		),
	"record-choice-in": (id) =>
		expect(JSON.stringify(form(id, "visit").caseOperations)).toMatch(
			/"kind":"in".*?"values":\[\{"kind":"choice"/u,
		),
	"record-choice-switch": (id) =>
		expect(writeValue(id, "visit", "answer")).toMatchObject({
			cases: [{ when: { kind: "choice" } }],
		}),
	"multi-select-choice": (id) =>
		expect(
			(field(id, "choices").default_value as { term: { options: unknown[] } })
				.term.options,
		).toHaveLength(2),
	"unmatched-choice-literal": (id) =>
		expect(field(id, "unmatched").relevant).toMatchObject({
			right: { term: { kind: "literal", value: "retired" } },
		}),
	"canonical-respelling": hasClass("form-logic-lift", "respelled"),
	"relative-inside-repeat": (id) =>
		expect(field(id, "same_row").calculate).toMatchObject({
			term: { spelling: "relative" },
		}),
	"empty-optional": hasClass("form-logic-lift", "empty"),
	"structural-many-value": hasClass("repeat-read-first-row", "first-row"),
	"typed-case-query": (id) =>
		expect(field(id, "typed").calculate).toMatchObject({
			of: { where: [{ right: { term: { kind: "case-type" } } }] },
		}),
	"unique-untyped-case-query": (id) =>
		expect(field(id, "unique").calculate).toMatchObject({
			of: { where: [] },
			value: { caseType: "patient" },
		}),
	"standard-untyped-case-query": (id) =>
		expect(field(id, "standard").calculate).toMatchObject({
			value: { kind: "prop", property: "case_id" },
		}),
	"known-case-id-query": (id) =>
		expect(field(id, "by_id").calculate).toMatchObject({
			value: { caseType: "patient" },
		}),
	"session-selected-case": hasClass("form-logic-lift", "session-datum"),
	"declare-text": (id) =>
		expect(JSON.stringify(result(id).changes)).toContain('"dataType":"text"'),
	"declare-decimal": (id) =>
		expect(JSON.stringify(result(id).changes)).toContain(
			'"dataType":"decimal"',
		),
	"declare-date": (id) =>
		expect(JSON.stringify(result(id).changes)).toContain('"dataType":"date"'),
	"declare-datetime": (id) =>
		expect(JSON.stringify(result(id).changes)).toContain(
			'"dataType":"datetime"',
		),
	"ambiguous-untyped-query": (id) =>
		expect(
			result(id).places.some((place) => place.text?.includes("/ambiguous")),
		).toBe(true),
	"unknown-untyped-query": (id) =>
		expect(
			result(id).places.some((place) => place.text?.includes("/unknown")),
		).toBe(true),
	"hidden-writer-inference": (id) =>
		expect(result(id).schemaChanges).toContainEqual(
			expect.objectContaining({ source: "inferred" }),
		),
	// Selected by `behavior.ts`; the transform's part is the filter it carries.
	"effective-search-today": hasClass("record-expressions", "structural"),
	"effective-search-datetime-equality": hasClass(
		"record-expressions",
		"structural",
	),
	"empty-datum-guard": guard(
		JSON.stringify(["formLinks", 0, "datums", 0, "xpath"]),
	),
	"empty-repeat-count-guard": guard(JSON.stringify(["repeat_count"])),
	"empty-ids-query-guard": guard(JSON.stringify(["data_source", "ids_query"])),
	"unresolved-datum-guard": () =>
		expect(
			blocker(
				transformWithFault(
					"required-slot-guards",
					fault("required-slot-guards", "form-link-datum-unresolved"),
				),
				"form-link-datum-unresolved",
			),
		).toBeDefined(),
};

const gateHas = (finding: string) => (r: TransformResult) => {
	const gate = blocker(r, "target-gate");
	expect([
		...(gate?.findingCodes ?? []),
		...(gate?.findingReasons ?? []),
	]).toContain(finding);
};
const RULE_WITNESSES: Record<string, (id: string) => void> = {
	HIDDEN_VALUE_WRITER_TYPE_MISMATCH: (id) =>
		gateHas("HIDDEN_VALUE_WRITER_TYPE_MISMATCH")(result(id)),
	CYCLE: (id) => gateHas("CYCLE")(result(id)),
	"record-verdict-moved-by-inference": (id) =>
		gateHas("CASE_LIST_FILTER_TYPE_ERROR:incompatible-values")(result(id)),
	SELECT_PRELOAD_WRITE_NOT_AN_OPTION: (id) =>
		gateHas("SELECT_PRELOAD_WRITE_NOT_AN_OPTION")(result(id)),
	"case-query-untyped": (id) =>
		expect(
			blocker(result(id), "expression-parse-refused")?.findingCodes,
		).toContain("case-query-untyped"),
	"selected-cases-as-one-value": (id) =>
		gateHas("XPATH_MANY_VALUES:selected-cases")(
			transformWithFault(id, fault(id, "target-gate")),
		),
	"prose-repeat-read-as-one-value": (id) =>
		gateHas("XPATH_MANY_VALUES:repeat")(result(id)),
	"day-only-on-device": (id) =>
		gateHas("XPATH_INCOMPATIBLE_VALUES:day-only-on-device")(result(id)),
};

/** The reasons whose lines the steps write, and where every other reason is written. */
const WRITTEN_HERE = new Set([
	"case-property-rules-removed",
	"expressions-follow-choices",
	"expressions-respelled",
	"case-property-declared",
	"repeat-read-takes-first-row",
]);
const WRITTEN_ELSEWHERE: Record<string, (id: string) => void> = {
	// `behavior.ts` selects these from the target the transform returns.
	"search-today-is-workers-day": (id) =>
		expect(result(id).target).toBeDefined(),
	"search-date-time-equality-matches": (id) =>
		expect(result(id).target).toBeDefined(),
	"date-time-comparison-compares-moments": (id) =>
		expect(result(id).target).toBeDefined(),
	// `behavior.ts` reads each inferred schema change the transform plans.
	"case-property-type-now-known": (id) =>
		expect(
			result(id).schemaChanges.some((change) => change.source === "inferred"),
		).toBe(true),
	// The plan's: private work, deployments and their entry points.
	"unsaved-assistant-work-discarded": () => undefined,
	"deep-links-need-republish": () => undefined,
	"expressions-sent-at-next-publish": () => undefined,
};

/** The blockers the transform owns, each met by its fixture as stored or under its fault. */
function blockerWitness(id: string, code: string) {
	const entry = manifestFixture(id).faults?.find(
		(candidate) => candidate.blocker === code,
	);
	const r = entry === undefined ? result(id) : transformWithFault(id, entry);
	expect(blocker(r, code)).toBeDefined();
}

describe("the manifest's witnesses", () => {
	it("name every step and every blocker of part 09", () => {
		const steps = new Set(MANIFEST.flatMap((fixture) => fixture.steps));
		expect([...steps].sort()).toEqual([...EXPRESSIONS_STEP_IDS].sort());
		const blockers = new Set(MANIFEST.flatMap((fixture) => fixture.blockers));
		expect([...blockers].sort()).toEqual(
			[...CUTOVER_BLOCKER_CODES, ...CUTOVER_STOP_CODES].sort(),
		);
	});

	it.each(
		MANIFEST.flatMap((fixture) =>
			fixture.classes.map((cls) => [fixture.id, cls]),
		),
	)("%s witnesses class %s", (id, cls) => {
		const witness = CLASS_WITNESSES[cls];
		expect(witness, cls).toBeDefined();
		witness(id);
	});

	it.each(
		MANIFEST.flatMap((fixture) =>
			fixture.rules.map((rule) => [fixture.id, rule]),
		),
	)("%s witnesses blocking rule %s", (id, rule) => {
		const witness = RULE_WITNESSES[rule];
		expect(witness, rule).toBeDefined();
		witness(id);
	});

	it.each(
		MANIFEST.flatMap((fixture) =>
			fixture.blockers
				.filter(
					(code) => !(CUTOVER_STOP_CODES as readonly string[]).includes(code),
				)
				.map((code) => [fixture.id, code]),
		),
	)("%s witnesses blocker %s", (id, code) => blockerWitness(id, code));

	it.each(
		MANIFEST.flatMap((fixture) =>
			fixture.reasons.map((reason) => [fixture.id, reason]),
		),
	)("%s witnesses reason %s", (id, reason) => {
		if (WRITTEN_HERE.has(reason))
			expect(result(id).changes.map((change) => change.reason)).toContain(
				reason,
			);
		else {
			const witness = WRITTEN_ELSEWHERE[reason];
			expect(witness, reason).toBeDefined();
			witness(id);
			expect(result(id).changes.map((change) => change.reason)).not.toContain(
				reason,
			);
		}
	});
});
