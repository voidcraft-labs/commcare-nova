// lib/domain/expression/__tests__/typeChecker.test.ts
//
// Acceptance tests for the schema-driven predicate type checker. Each
// `it` pins one operand-type rule by constructing a small predicate via
// the builders and asserting the type checker's verdict on it. The
// catalog is structural input to this checker. Carrier compatibility and
// complete document admission are separate gates, not established here.
//
// Coverage spans three concentric layers: (1) comparison-operator
// rules (resolution, ordering, compatibility), (2) recursion through
// logical wrappers (errors deep inside `and` / `or` / `not` /
// `when-input-present` still surface), (3) special-case widenings
// (numeric promotion both directions, select-to-text, null-as-universal,
// session-user / session-context refs, boolean literals).

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	f,
	parseFixtureExpression,
} from "@/lib/__tests__/docHelpers";
import {
	type BlueprintDoc,
	type CaseType,
	calculatedColumn,
	caseTypeSchema,
} from "@/lib/domain";
import type { CasePropertyDataType } from "@/lib/domain/casePropertyTypes";
import { advancedSearchInputDef } from "@/lib/domain/modules";
import { proseText } from "@/lib/domain/prose";
import {
	ancestorPath,
	and,
	anyRelationPath,
	arith,
	between,
	coalesce,
	concat,
	count,
	dateAdd,
	dateCoerce,
	dateLiteral,
	datetimeCoerce,
	double,
	eq,
	exists,
	fixedLocation,
	formatDate,
	gt,
	ifExpr,
	input,
	isBlank,
	isIn,
	literal,
	lt,
	match,
	matchAll,
	matchesPattern,
	matchNone,
	missing,
	multiSelectAll,
	multiSelectAny,
	not,
	now,
	or,
	ownerLocationAtLevel,
	prop,
	qualifiedLiteral,
	relationStep,
	selfPath,
	sessionContext,
	sessionUser,
	subcasePath,
	switchCase,
	switchExpr,
	term,
	timeLiteral,
	today,
	whenInput,
	within,
} from "../builders";
import { recordQueryContext, slotContext } from "../context";
import {
	type CheckOutcome,
	checkExpression,
	inferRecordQuery,
	scalarDataType,
	typeOf,
} from "../typeChecker";
import type { Expression, ExpressionSlotRef } from "../types";

type QueryFixture = Parameters<typeof recordQueryContext>[0] & {
	readonly ownerValues?: boolean;
	readonly patternMatching?: boolean;
};
const resultOf = (outcome: CheckOutcome) =>
	outcome.errors.length === 0
		? { ok: true as const }
		: { ok: false as const, errors: outcome.errors };
const SLOT_MODULE = testUuid("checker-slots-module");
const SLOT_FORM = testUuid("checker-slots-form");
const SLOT_OPERATION = testUuid("checker-slots-operation");
const SLOT_INPUT = testUuid("checker-slots-input");
function authoredSlot(
	options: QueryFixture,
	kind: "owner" | "assignment" | "pattern" | "default",
	expression: Expression,
	destination?: CasePropertyDataType,
) {
	const caseType =
		options.currentCaseType ?? options.caseTypes[0]?.name ?? "patient";
	const inputs = (options.knownInputs ?? []).map((input) =>
		advancedSearchInputDef(
			input.uuid,
			input.name,
			input.name,
			"text",
			matchAll(),
		),
	);
	if (!inputs.some((input) => input.uuid === SLOT_INPUT))
		inputs.push(
			advancedSearchInputDef(
				SLOT_INPUT,
				"answer",
				"Answer",
				kind === "default" && destination === "date" ? "date" : "text",
				matchAll(),
			),
		);
	const caseTypes = options.caseTypes.map((type) =>
		type.name === caseType && destination !== undefined
			? {
					...type,
					properties: [
						...type.properties,
						{
							name: "test_destination",
							data_type: destination,
							label: proseText("Destination"),
						},
					],
				}
			: type,
	);
	let doc = buildDoc({
		caseTypes: [...caseTypes],
		modules: [
			{
				uuid: SLOT_MODULE,
				name: "Records",
				caseType,
				caseListConfig: { ...caseListConfig([]), searchInputs: inputs },
				caseSearchConfig: {},
				forms: [
					{
						uuid: SLOT_FORM,
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: "Note" })],
					},
				],
			},
		],
	});
	doc = {
		...doc,
		organizationLevels: { ...options.organizationLevels },
		forms: {
			...doc.forms,
			[SLOT_FORM]: {
				...doc.forms[SLOT_FORM],
				caseOperations: [
					{
						uuid: SLOT_OPERATION,
						id: "save",
						action: "update",
						caseType,
						target: { kind: "session" },
						writes: [{ property: "test_destination", value: expression }],
					},
				],
			},
		},
	};
	const slot =
		kind === "owner"
			? {
					entity: "form" as const,
					uuid: SLOT_FORM,
					slot: "case_operation_owner" as const,
					member: { operationUuid: SLOT_OPERATION },
				}
			: kind === "assignment"
				? {
						entity: "form" as const,
						uuid: SLOT_FORM,
						slot: "case_operation_write_value" as const,
						member: {
							operationUuid: SLOT_OPERATION,
							property: "test_destination",
						},
					}
				: {
						entity: "module" as const,
						uuid: SLOT_MODULE,
						slot:
							kind === "pattern"
								? ("search_input_required_when" as const)
								: ("search_input_default" as const),
						member: { searchInputUuid: SLOT_INPUT },
					};
	const ctx = slotContext(doc, slot, new Map());
	if (ctx === undefined)
		throw new Error("The checker fixture has no real owning slot.");
	return ctx;
}
function conditionVerdict(expression: Expression, options: QueryFixture) {
	return resultOf(
		options.patternMatching
			? checkExpression(
					expression,
					authoredSlot(options, "pattern", expression),
				)
			: inferRecordQuery(expression, recordQueryContext(options), "condition"),
	);
}
function valueVerdict(
	expression: Expression,
	options: QueryFixture,
	expected?: CasePropertyDataType,
) {
	return resultOf(
		options.ownerValues || expected !== undefined
			? checkExpression(
					expression,
					authoredSlot(
						options,
						options.ownerValues ? "owner" : "default",
						expression,
						expected,
					),
				)
			: inferRecordQuery(expression, recordQueryContext(options)),
	);
}
function assignmentVerdict(
	expression: Expression,
	options: QueryFixture,
	destinations: readonly CasePropertyDataType[],
) {
	const errors = destinations.flatMap(
		(destination) =>
			checkExpression(
				expression,
				authoredSlot(options, "assignment", expression, destination),
			).errors,
	);
	return resultOf({ type: undefined, errors });
}

import { MATCH_MODES, MULTI_SELECT_QUANTIFIERS } from "../types";

// Single fixture reused across every test. Includes one property of
// each data-type family exercised by the type-rule matrix: text
// (unordered), int (ordered numeric), decimal (numeric promotion
// counterpart), date / datetime / time (three temporal kinds — used to
// verify they don't widen across each other and to exercise each
// ordered-temporal arm of `ORDERED_TYPES`), single_select and
// multi_select (string-coerced, with options — covers both arms of the
// match text-shaped allow-list and the select-to-text widening).
const PATIENT = caseTypeSchema.parse({
	name: "patient",
	properties: [
		{ name: "case_name", label: proseText("Case name"), data_type: "text" },
		{ name: "age", label: proseText("Age"), data_type: "int" },
		{ name: "weight_kg", label: proseText("Weight"), data_type: "decimal" },
		{ name: "dob", label: proseText("DOB"), data_type: "date" },
		{ name: "last_seen", label: proseText("Last seen"), data_type: "datetime" },
		{
			name: "appointment_time",
			label: proseText("Appointment time"),
			data_type: "time",
		},
		{
			name: "status",
			label: proseText("Status"),
			data_type: "single_select",
			options: [
				{ value: "open", label: proseText("Open") },
				{ value: "closed", label: proseText("Closed") },
			],
		},
		{
			name: "tags",
			label: proseText("Tags"),
			data_type: "multi_select",
			options: [
				{ value: "vip", label: proseText("VIP") },
				{ value: "urgent", label: proseText("Urgent") },
			],
		},
	],
});

// Default context — no declared search inputs. Tests that exercise
// input-ref behavior shadow `knownInputs` locally so the default fixture
// stays readable.
const ctx = {
	caseTypes: [PATIENT],
	knownInputs: [],
};

// Geopoint-extended fixture used by the within-distance describe block.
// The base PATIENT fixture omits a geopoint property because the
// comparison-operator tests don't exercise geo, and adding one to the
// shared fixture would force every comparison test to acknowledge it.
// `ctxWithGeo` derives from `ctx` so the within-distance tests share
// the rest of the property set without divergence from the base.
const ctxWithGeo = {
	...ctx,
	caseTypes: [
		{
			...PATIENT,
			properties: [
				...PATIENT.properties,
				{
					name: "location",
					label: proseText("Location"),
					data_type: "geopoint" as const,
				},
			],
		},
	],
};

describe("conditionVerdict — comparison operators", () => {
	it("accepts int = int", () => {
		const p = eq(prop("patient", "age"), literal(42));
		const result = conditionVerdict(p, ctx);
		expect(result.ok).toBe(true);
	});

	it("accepts text = text", () => {
		const p = eq(prop("patient", "case_name"), literal("Alice"));
		const result = conditionVerdict(p, ctx);
		expect(result.ok).toBe(true);
	});

	it("accepts only the canonical built-in case status values", () => {
		expect(
			conditionVerdict(eq(prop("patient", "status"), literal("open")), ctx).ok,
		).toBe(true);
		expect(
			conditionVerdict(eq(literal("closed"), prop("patient", "status")), ctx)
				.ok,
		).toBe(true);

		const result = conditionVerdict(
			eq(prop("patient", "status"), literal("active")),
			ctx,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContainEqual({
				path: ["right"],
				code: "case-status-value",
				message: expect.stringMatching(
					/only be compared with 'open' or 'closed'/,
				),
			});
		}
	});

	it("rejects noncanonical built-in case status membership values", () => {
		const result = conditionVerdict(
			isIn(prop("patient", "status"), literal("open"), literal("active")),
			ctx,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContainEqual({
				path: ["values", 1],
				code: "case-status-value",
				message: expect.stringMatching(/only be 'open' or 'closed'/),
			});
		}
	});

	it("rejects int = string-literal mismatch", () => {
		const p = eq(prop("patient", "age"), literal("forty-two"));
		const result = conditionVerdict(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/type mismatch/i);
			expect(result.errors[0].code).toBe("incompatible-values");
		}
	});

	it("accepts gt on int", () => {
		const p = gt(prop("patient", "age"), literal(18));
		expect(conditionVerdict(p, ctx).ok).toBe(true);
	});

	it("rejects gt on text (strings aren't ordered)", () => {
		const p = gt(prop("patient", "case_name"), literal("M"));
		const result = conditionVerdict(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/not ordered/i);
			expect(result.errors[0].code).toBe("ordered-values");
			// Pin the path-tracking contract for the comparison-level
			// verdict: ordered-types rejection attaches to the predicate's
			// own path (not the operand's), so a top-level `gt(...)` with
			// no parent emits an empty-path error. The path shape is
			// architecturally meaningful — the editor highlights the
			// comparison card itself, not one of its operand cards.
			expect(result.errors[0].path).toEqual([]);
		}
	});

	// The ordered-types check is `!leftOrdered || !rightOrdered`. The
	// previous test's left operand is text and short-circuits the `||`
	// before the right side is evaluated; pinning the right-side branch
	// requires an int (ordered) left operand and a text (unordered) right
	// operand. Without this test, a regression that dropped the
	// `!rightOrdered` half of the conjunction would slip through.
	it("rejects gt with text on the right side (right-side ordered check)", () => {
		const p = gt(prop("patient", "age"), literal("M"));
		const result = conditionVerdict(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/not ordered/i);
		}
	});

	it("accepts lt on date with a typed dateLiteral", () => {
		const p = lt(prop("patient", "dob"), dateLiteral("2000-01-01"));
		expect(conditionVerdict(p, ctx).ok).toBe(true);
	});

	// A time of day has no order on a device: Core compares an ordering as
	// numbers and a time is NaN. The refusal has its own code, and the date
	// beside it is accepted.
	it("refuses lt on time with a typed timeLiteral under time-ordering", () => {
		const p = lt(prop("patient", "appointment_time"), timeLiteral("12:00:00"));
		const result = conditionVerdict(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].code).toBe("time-ordering");
			expect(result.errors[0].path).toEqual([]);
			expect(result.errors[0].message).toMatch(/A date can be compared/);
		}
		expect(
			conditionVerdict(
				lt(prop("patient", "dob"), dateLiteral("2000-01-01")),
				ctx,
			).ok,
		).toBe(true);
	});

	it("refuses a time on the right side of an ordering under time-ordering", () => {
		const p = gt(literal(null), prop("patient", "appointment_time"));
		const result = conditionVerdict(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.errors[0].code).toBe("time-ordering");
	});

	it("still accepts eq on a time", () => {
		const p = eq(prop("patient", "appointment_time"), timeLiteral("12:00:00"));
		expect(conditionVerdict(p, ctx).ok).toBe(true);
	});

	it("refuses an ordering on two text values under ordered-values, naming no time", () => {
		const p = gt(prop("patient", "case_name"), literal("M"));
		const result = conditionVerdict(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].code).toBe("ordered-values");
			expect(result.errors[0].message).toBe(
				"Operator 'gt' requires ordered types (int, decimal, date, datetime); got 'text' and 'text'. Strings are not ordered.",
			);
		}
	});

	it("rejects an unknown property reference", () => {
		const p = eq(prop("patient", "bogus"), literal("x"));
		const result = conditionVerdict(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/unknown property/i);
			expect(result.errors[0].code).toBe("unknown-property");
			// Operand-resolution errors carry the operand's own path so
			// the editor highlights the failing operand card. Top-level
			// `eq`'s left operand resolves at `["left"]`.
			expect(result.errors[0].path).toEqual(["left"]);
		}
	});

	it("rejects an unknown case type reference", () => {
		const p = eq(prop("alien_type", "x"), literal("y"));
		const result = conditionVerdict(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/unknown case type/i);
		}
	});

	it("accepts input ref against int prop when input is declared", () => {
		const ctxWithInput = {
			...ctx,
			knownInputs: [
				{
					uuid: testUuid("min_age"),
					name: "min_age",
					data_type: "int" as const,
				},
			],
		};
		const p = gt(prop("patient", "age"), input(testUuid("min_age")));
		expect(conditionVerdict(p, ctxWithInput).ok).toBe(true);
	});

	it("rejects input ref when input isn't declared", () => {
		const p = gt(prop("patient", "age"), input(testUuid("undeclared")));
		const result = conditionVerdict(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].code).toBe("unknown-search-input");
			// The message is for a person: it must not hand back the uuid the
			// rule stored, because nobody can act on one.
			expect(result.errors[0].message).not.toMatch(
				/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
			);
			expect(result.errors[0].code).toBe("unknown-search-input");
		}
	});

	// Multi-error accumulation. The walker collects errors across the
	// whole predicate rather than short-circuiting on the first
	// failure, so an `eq` with two unresolvable operands surfaces both
	// problems in one pass. The editor relies on this behavior to
	// highlight every failing card simultaneously.
	it("accumulates errors from both operands when both fail to resolve", () => {
		const p = eq(prop("patient", "bogus"), input(testUuid("undeclared")));
		const result = conditionVerdict(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toHaveLength(2);
			expect(result.errors[0].path).toEqual(["left"]);
			expect(result.errors[1].path).toEqual(["right"]);
		}
	});

	// Numeric-promotion symmetry. The widening rule between int and
	// decimal applies regardless of which side the int- vs
	// decimal-typed value sits on; restating both directions guards
	// against a one-sided regression in `typesCompatible`.
	it("accepts int prop = decimal literal (int prop, decimal value)", () => {
		const p = eq(prop("patient", "age"), literal(3.14));
		expect(conditionVerdict(p, ctx).ok).toBe(true);
	});

	it("accepts decimal prop = int literal (decimal prop, int value)", () => {
		const p = eq(prop("patient", "weight_kg"), literal(70));
		expect(conditionVerdict(p, ctx).ok).toBe(true);
	});

	// Date-kind isolation. `date`, `datetime`, and `time` are all
	// "ordered temporal" types but each has distinct wire semantics —
	// a `date` and a `datetime` can't be compared without lossy
	// coercion, so the type checker rejects the comparison rather
	// than papering over the ambiguity.
	it("rejects eq across distinct date kinds (date prop = datetime prop)", () => {
		const p = eq(prop("patient", "dob"), prop("patient", "last_seen"));
		const result = conditionVerdict(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/type mismatch/i);
		}
	});

	// Session-user refs (open-namespace `/session/user/data/<field>`)
	// always resolve to text — `addUserProperties` at
	// `commcare-core/src/main/java/org/commcare/session/SessionInstanceBuilder.java`
	// writes a Hashtable's string values, so every custom user-data
	// field comes back as a string regardless of project semantics.
	// Comparing a text-typed property against a session-user reference
	// is the canonical shape; pinning it locks the resolution rule.
	it("accepts text prop = session-user field (both resolve to text)", () => {
		const p = eq(prop("patient", "case_name"), sessionUser("display_name"));
		expect(conditionVerdict(p, ctx).ok).toBe(true);
	});

	// Session-context refs (closed-enum `/session/context/<field>`)
	// also resolve to text for v1's four-field set — `userid` /
	// `username` / `deviceid` / `appversion` are all wire strings at
	// `/session/context/<field>`. The type checker's job here is to
	// resolve the term's wire type, not to police semantic-version
	// gating semantics on `appversion` (lex compare disagrees with
	// semver once digit counts diverge — see the `session-context`
	// arm comment in `typeChecker.ts` for the detail). A comparison
	// against a text-typed property is well-typed under the
	// text-shaped rule regardless.
	it("accepts text prop = session-context field (both resolve to text)", () => {
		const p = eq(prop("patient", "case_name"), sessionContext("username"));
		expect(conditionVerdict(p, ctx).ok).toBe(true);
	});

	// Boolean literals resolve to text, so a comparison against a
	// text-typed property is well-typed. The same literal compared
	// against a numeric or date property would fail the compatibility
	// check; this test pins only the well-typed direction.
	it("accepts text prop = boolean literal (boolean resolves to text)", () => {
		const p = eq(prop("patient", "case_name"), literal(true));
		expect(conditionVerdict(p, ctx).ok).toBe(true);
	});

	// Null-as-universal. `null` is the structural sentinel for "this
	// property is unset" and must be comparable against any declared
	// property type — otherwise authors couldn't write the is-unset
	// filter without inventing per-type null-equivalents.
	it("accepts null literal compared against any typed property (is-unset filter)", () => {
		const p = eq(prop("patient", "age"), literal(null));
		expect(conditionVerdict(p, ctx).ok).toBe(true);
	});
});

describe("case-owner location terms", () => {
	const REGION = testUuid("owner-region-level");
	const FACILITY = testUuid("owner-facility-level");
	const BUCKET = testUuid("owner-bucket-level");
	const ownerContext = {
		...ctx,
		ownerValues: true,
		caseTypes: [
			{
				...PATIENT,
				properties: [
					...PATIENT.properties,
					{
						name: "owner_id",
						label: proseText("Owner"),
						data_type: "text" as const,
					},
				],
			},
		],
		organizationLevels: {
			[REGION]: {
				uuid: REGION,
				code: "region",
				name: "Region",
				caseFlow: { workers: "none" as const, ownsCases: false },
				addressBook: { reach: "own-branch" as const },
			},
			[FACILITY]: {
				uuid: FACILITY,
				code: "facility",
				name: "Facility",
				parentLevelUuid: REGION,
				caseFlow: { workers: "none" as const, ownsCases: true },
				addressBook: { reach: "own-branch" as const },
			},
			[BUCKET]: {
				uuid: BUCKET,
				code: "facility_data",
				name: "Facility data",
				parentLevelUuid: FACILITY,
				caseFlow: { workers: "none" as const, ownsCases: true },
				addressBook: { reach: "own-branch" as const },
			},
		},
	};

	it("admits both typed terms only in a case-owner value slot", () => {
		const fixed = term(fixedLocation(testUuid("fixed-place")));
		expect(valueVerdict(fixed, ownerContext).ok).toBe(true);
		expect(valueVerdict(fixed, ctx).ok).toBe(false);

		const reverse = term(ownerLocationAtLevel(BUCKET, "patient"));
		expect(valueVerdict(reverse, ownerContext).ok).toBe(true);
		expect(valueVerdict(reverse, ctx).ok).toBe(false);
	});

	it("refuses a reverse hop without a case-owning ancestor", () => {
		const result = valueVerdict(
			term(ownerLocationAtLevel(FACILITY, "patient")),
			{
				...ownerContext,
				organizationLevels: {
					...ownerContext.organizationLevels,
					[FACILITY]: {
						...ownerContext.organizationLevels[FACILITY],
						caseFlow: { workers: "none", ownsCases: true },
					},
				},
			},
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.map((error) => error.message).join(" ")).toContain(
				"no case-owning level above",
			);
		}
	});
});

describe("conditionVerdict — recursion through logical wrappers", () => {
	// The walker descends into every logical wrapper so a comparison
	// violation buried inside an `and` / `or` / `not` /
	// `when-input-present` still surfaces with a precise path. Without
	// this, an author could nest a broken comparison under a logical
	// wrapper and the type checker would silently approve the entire
	// predicate.
	it("flags errors inside logical wrappers (and/or/not)", () => {
		const badComparison = eq(prop("patient", "age"), literal("forty-two"));
		const wrapped = and(
			badComparison,
			eq(prop("patient", "case_name"), literal("Alice")),
		);
		const result = conditionVerdict(wrapped, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/type mismatch/i);
			// Path convention: `and` wrapper, then array index of the
			// failing clause. The kind segment disambiguates a clause
			// inside `and(...)` from a clause inside a sibling `or(...)`.
			expect(result.errors[0].path).toEqual(["and", 0]);
		}
	});

	// `not` uses the unary-wrapper path convention (`[operator-name,
	// field-name]`), parallel to `when-input-present`. Pinning the
	// `["not", "clause"]` shape locks the convention against a regression
	// to the old operator-name-only form (`["not"]`), which would have
	// made `not` the only wrapping operator emitting a path that didn't
	// also identify which slot inside the operator the error came from.
	it("propagates errors from inside not(...) with a clause-segmented path", () => {
		const p = not(eq(prop("patient", "age"), literal("forty-two")));
		const result = conditionVerdict(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/type mismatch/i);
			expect(result.errors[0].path).toEqual(["not", "clause"]);
		}
	});

	// `or` shares the multi-clause path convention with `and`; pinning
	// the `["or", N]` shape on a non-zero index locks both halves of the
	// convention — the operator-name segment and the array index — for
	// the second multi-clause arm. The failing clause is at index 1, so
	// a regression that mis-indexed (e.g. always emitted 0) would be
	// visible here.
	it("propagates errors from inside or(...) with index-segmented paths", () => {
		const goodComparison = eq(prop("patient", "case_name"), literal("Alice"));
		const badComparison = eq(prop("patient", "age"), literal("forty-two"));
		const wrapped = or(goodComparison, badComparison);
		const result = conditionVerdict(wrapped, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].path).toEqual(["or", 1]);
			expect(result.errors[0].message).toMatch(/type mismatch/i);
		}
	});

	// `when-input-present` recurses into its wrapped clause under the
	// unary-wrapper convention `[operator-name, "clause"]`. Pinning the
	// path here parallels the `not` test above and locks the second of
	// the two unary wrappers.
	it("propagates errors from inside when-input-present's clause", () => {
		const ctxWithInput = {
			...ctx,
			knownInputs: [{ uuid: testUuid("phone"), name: "phone" }],
		};
		const p = whenInput(
			input(testUuid("phone")),
			eq(prop("patient", "age"), literal("forty-two")),
		);
		const result = conditionVerdict(p, ctxWithInput);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].path).toEqual(["when-input-present", "clause"]);
			expect(result.errors[0].message).toMatch(/type mismatch/i);
		}
	});

	// `when-input-present`'s trigger input must itself be declared in
	// `ctx.knownInputs`. Without this check, an undeclared trigger
	// silently passes — the wrapped clause type-checks fine, the
	// trigger never resolves at runtime, and the predicate becomes a
	// permanent no-op. The error path mirrors the wrapped-clause
	// convention but identifies the operator's `input` slot rather
	// than its `clause` slot.
	it("rejects when-input-present with an undeclared trigger input", () => {
		const p = whenInput(
			input(testUuid("undeclared")),
			eq(prop("patient", "case_name"), literal("Alice")),
		);
		const result = conditionVerdict(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].path).toEqual(["when-input-present", "input"]);
			expect(result.errors[0].code).toBe("unknown-search-input");
			// The message is for a person: it must not hand back the uuid the
			// rule stored, because nobody can act on one.
			expect(result.errors[0].message).not.toMatch(
				/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
			);
		}
	});
});

describe("conditionVerdict — operand resolution on in / within-distance / match / multi-select-contains", () => {
	// `in`, `within-distance`, `match`, and `multi-select-contains`
	// resolve their term operands uniformly with comparison operators so
	// unknown-property / unknown-case-type / unknown-input errors surface
	// the same way no matter which operator the bad term sits under. The
	// per-operator semantic checks (membership-value compatibility on
	// `in`, geopoint-property requirement on `within-distance`, text-
	// property requirement on `match`, multi_select-only requirement on
	// `multi-select-contains`) are separate concerns and not covered here.
	it("rejects in(...) with an unknown property reference", () => {
		const p = isIn(prop("patient", "bogus"), literal("x"));
		const result = conditionVerdict(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].path).toEqual(["left"]);
			expect(result.errors[0].message).toMatch(/unknown property/i);
		}
	});

	// `within-distance` carries two term operands (`property` and
	// `center`). Pinning the path on each lets the editor highlight
	// either operand independently, and the multi-error count locks the
	// "errors accumulate across operands" contract.
	it("rejects within-distance(...) with an unknown property and unknown input", () => {
		const p = within(
			prop("alien_type", "loc"),
			input(testUuid("undeclared")),
			50,
			"miles",
		);
		const result = conditionVerdict(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toHaveLength(2);
			expect(result.errors.map((e) => e.path)).toEqual([
				["property"],
				["center"],
			]);
		}
	});

	it("rejects match(...) with an unknown property reference", () => {
		const p = match(prop("patient", "bogus"), "alice", "fuzzy");
		const result = conditionVerdict(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].path).toEqual(["property"]);
			expect(result.errors[0].message).toMatch(/unknown property/i);
		}
	});

	it("rejects multi-select-contains(...) with an unknown property reference", () => {
		const p = multiSelectAny(prop("patient", "bogus"), literal("vip"));
		const result = conditionVerdict(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].path).toEqual(["property"]);
			expect(result.errors[0].message).toMatch(/unknown property/i);
		}
	});
});

describe("conditionVerdict — in operator membership compatibility", () => {
	// `in` requires every literal in `values` to be type-compatible with
	// `left`'s resolved type. The check reuses the same `typesCompatible`
	// table that comparison operators use, so the widenings (numeric
	// promotion, select-to-text, null-as-universal) carry over and
	// authors don't have to relearn the rule per operator.

	it("accepts isIn with type-compatible string literals on a single_select property", () => {
		const p = isIn(
			prop("patient", "status"),
			literal("open"),
			literal("closed"),
		);
		expect(conditionVerdict(p, ctx).ok).toBe(true);
	});

	it("accepts isIn with int literals on an int property", () => {
		const p = isIn(prop("patient", "age"), literal(18), literal(21));
		expect(conditionVerdict(p, ctx).ok).toBe(true);
	});

	// The first literal mismatches (string against int); the second
	// matches. The error path identifies the offending value's index so
	// the editor highlights the bad chip without flagging the whole
	// `in(...)` card. Pinning the index also locks the convention that
	// one error per offending value accumulates rather than a single
	// "first-bad" error short-circuiting the rest.
	it("rejects isIn when a literal's type doesn't match the property", () => {
		const p = isIn(prop("patient", "age"), literal("eighteen"), literal(42));
		const result = conditionVerdict(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].path).toEqual(["values", 0]);
			expect(result.errors[0].message).toMatch(/type mismatch/i);
		}
	});

	// Null-as-universal carries over from comparison: a `null` literal
	// in the values list is the structural is-unset filter and must
	// compare-compatible against every property type. Without this,
	// authors writing `isIn(prop, [literal(null), literal("active")])`
	// to express "unset OR active" would see a spurious mismatch.
	it("accepts a null literal in the values list against a typed property", () => {
		const p = isIn(prop("patient", "age"), literal(null), literal(42));
		expect(conditionVerdict(p, ctx).ok).toBe(true);
	});
});

describe("conditionVerdict — within-distance geopoint requirement", () => {
	// `within-distance` resolves to CCHQ's `case_property_geo_distance`
	// (`corehq/apps/es/case_search.py::case_property_geo_distance`),
	// which queries the `PROPERTY_GEOPOINT_VALUE` field — only properties
	// stored as a geopoint participate. The center may be a wire-form
	// coordinate string (`"lat lon altitude accuracy"` per
	// `corehq/apps/case_search/xpath_functions/query_functions.py::within_distance`,
	// where CCHQ parses the center via `GeoPoint.from_string(...,
	// flexible=True)`) or a typed-geopoint search input, so the
	// allow-list for the center slot is `geopoint | text`.

	it("accepts within-distance with a geopoint property and a text-literal center", () => {
		const p = within(
			prop("patient", "location"),
			literal("40.7 -74.0 0 0"),
			50,
			"miles",
		);
		expect(conditionVerdict(p, ctxWithGeo).ok).toBe(true);
	});

	it("accepts within-distance with a geopoint property and a typed-geopoint search input as center", () => {
		const ctxWithGeoInput = {
			...ctxWithGeo,
			knownInputs: [
				{
					uuid: testUuid("user_loc"),
					name: "user_loc",
					data_type: "geopoint" as const,
				},
			],
		};
		const p = within(
			prop("patient", "location"),
			input(testUuid("user_loc")),
			50,
			"miles",
		);
		expect(conditionVerdict(p, ctxWithGeoInput).ok).toBe(true);
	});

	// Property-side rejection: a non-geopoint property cannot back the
	// geo-distance query. The error path identifies the property slot
	// so the editor highlights the operand card directly. The operator
	// resolves the term first (no unknown-property error here — `name`
	// exists), then the semantic check rejects the type mismatch.
	it("rejects within-distance when the property is not geopoint", () => {
		const p = within(
			prop("patient", "case_name"),
			literal("40.7 -74.0 0 0"),
			50,
			"miles",
		);
		const result = conditionVerdict(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].path).toEqual(["property"]);
			expect(result.errors[0].message).toMatch(/geopoint/i);
		}
	});

	// Center-side rejection: a numeric literal isn't a wire-form
	// coordinate string and isn't a geopoint, so the center slot's
	// allow-list rejects it. Property-side stays valid (geopoint), so
	// only the center slot emits an error and the path identifies it
	// independently.
	it("rejects within-distance when the center isn't geopoint or text", () => {
		const p = within(prop("patient", "location"), literal(42), 50, "miles");
		const result = conditionVerdict(p, ctxWithGeo);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].path).toEqual(["center"]);
			expect(result.errors[0].message).toMatch(/geopoint|text/i);
		}
	});
});

describe("conditionVerdict — match property-shape requirement", () => {
	// `match` carries a `mode` discriminator across four CCHQ wire forms
	// — `fuzzy-match`, `phonetic-match`, `fuzzy-date`, `starts-with` —
	// each landing on a different CCHQ ES path. Three of the four modes
	// share a text-shaped allow-list (text / single_select /
	// multi_select); the fourth, `fuzzy-date`, widens to additionally
	// accept date / datetime. The branching rationale lives on the
	// allow-list constants in `typeChecker.ts`; tests below pin the
	// per-mode acceptance / rejection matrix.

	// Three text-shaped accepts × three text-shaped property kinds
	// (text / single_select / multi_select). `fuzzy-date` is exercised
	// separately below because its allow-list is wider.
	const TEXT_SHAPED_MATCH_MODES = ["fuzzy", "phonetic", "starts-with"] as const;

	it.each(TEXT_SHAPED_MATCH_MODES)(
		"accepts match on a text property (mode: %s)",
		(mode) => {
			const p = match(prop("patient", "case_name"), "alice", mode);
			expect(conditionVerdict(p, ctx).ok).toBe(true);
		},
	);

	it.each(TEXT_SHAPED_MATCH_MODES)(
		"accepts match on a single_select property (mode: %s)",
		(mode) => {
			const p = match(prop("patient", "status"), "ope", mode);
			expect(conditionVerdict(p, ctx).ok).toBe(true);
		},
	);

	// `multi_select` is stored as text and structurally indistinguishable
	// from `single_select` at the wire — pinning both arms of the
	// text-shaped allow-list locks the rule against a regression that
	// dropped one without breaking the other.
	it.each(TEXT_SHAPED_MATCH_MODES)(
		"accepts match on a multi_select property (mode: %s)",
		(mode) => {
			const p = match(prop("patient", "tags"), "vip", mode);
			expect(conditionVerdict(p, ctx).ok).toBe(true);
		},
	);

	it("accepts a pure derived text expression as the match value", () => {
		const p = match(
			prop("patient", "case_name"),
			concat(term(literal("Al")), term(literal("ice"))),
			"starts-with",
		);
		expect(conditionVerdict(p, ctx)).toEqual({ ok: true });
	});

	// `fuzzy-date` widens the allow-list to additionally accept date /
	// datetime properties. CCHQ's `fuzzy_date` (verified at
	// `commcare-hq/corehq/apps/case_search/xpath_functions/query_functions.py::fuzzy_date`)
	// is specifically designed to recover from transposed YYYY-MM-DD
	// inputs, so authors targeting a `date`-typed property must be able
	// to use the operator without re-declaring the property as text —
	// otherwise the typed-property model the blueprint already
	// establishes (typed `dateLiteral` / `datetimeLiteral` builders)
	// breaks down at the predicate layer. The text-shaped trio also
	// passes `fuzzy-date` because the underlying ES match runs against
	// the shared `PROPERTY_VALUE` text field for every property type.
	it("accepts fuzzy-date match on a date property", () => {
		const p = match(prop("patient", "dob"), "2024-12-03", "fuzzy-date");
		expect(conditionVerdict(p, ctx).ok).toBe(true);
	});

	it("accepts fuzzy-date match on a datetime property", () => {
		const p = match(prop("patient", "last_seen"), "2024-12-03", "fuzzy-date");
		expect(conditionVerdict(p, ctx).ok).toBe(true);
	});

	it("classifies an empty match value as a completeness finding", () => {
		const p = match(prop("patient", "case_name"), "", "fuzzy");
		const result = conditionVerdict(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]).toMatchObject({
				code: "match-value-empty",
				path: ["value"],
			});
		}
	});

	it.each(["case_name", "status", "tags"] as const)(
		"accepts fuzzy-date match on a text-shaped property (%s)",
		(propName) => {
			const p = match(prop("patient", propName), "2024-12-03", "fuzzy-date");
			expect(conditionVerdict(p, ctx).ok).toBe(true);
		},
	);

	// Parameterized rejection across every property type that does NOT
	// pass the text-shaped trio (excluding `geopoint`, which lives on
	// the `ctxWithGeo` fixture and is exercised separately below).
	// `fuzzy-date` is excluded from this rejection pass for `date` /
	// `datetime` because its allow-list widens to include them — the
	// rejection table below carves date / datetime out of `fuzzy-date`'s
	// row while still rejecting them for the other three modes.
	const REJECTED_NON_TEXT_PROPS = [
		{ propName: "age", dataType: "int" },
		{ propName: "weight_kg", dataType: "decimal" },
		{ propName: "dob", dataType: "date" },
		{ propName: "last_seen", dataType: "datetime" },
		{ propName: "appointment_time", dataType: "time" },
	] as const;

	// Helper: a (mode, property) row is rejected unless `fuzzy-date`
	// would accept the date/datetime. Every other combination rejects.
	const isAccepted = (mode: (typeof MATCH_MODES)[number], dataType: string) =>
		mode === "fuzzy-date" && (dataType === "date" || dataType === "datetime");

	it.each(
		REJECTED_NON_TEXT_PROPS.flatMap((prop) =>
			MATCH_MODES.filter((mode) => !isAccepted(mode, prop.dataType)).map(
				(mode) => ({ ...prop, mode }),
			),
		),
	)(
		"rejects match on a $dataType property (mode: $mode)",
		({ propName, mode }) => {
			const p = match(prop("patient", propName), "alice", mode);
			const result = conditionVerdict(p, ctx);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.errors).toHaveLength(1);
				expect(result.errors[0].path).toEqual(["property"]);
				expect(result.errors[0].code).toBe("match-value");
				// Error message names the offending mode and the
				// allow-list contents — both load-bearing for the
				// editor's per-mode highlighting.
				expect(result.errors[0].message).toMatch(new RegExp(`mode='${mode}'`));
			}
		},
	);

	// `geopoint` lives on the `ctxWithGeo` fixture (the base PATIENT
	// fixture deliberately omits a geopoint to keep the comparison-rule
	// matrix unaffected by it). Tested separately rather than in the
	// table above so the fixture switch is visible in the test name.
	// A match against the wire-form `"lat lon"` coordinate string is
	// meaningless — none of the four match metrics is defined on a
	// structured pair of floats. Pinning the rejection here locks the
	// rule against a regression that widened the allow-list to "anything
	// stored as text on the wire." `fuzzy-date` rejects geopoint too —
	// its widening covers date / datetime only.
	it.each(MATCH_MODES)(
		"rejects match on a geopoint property (mode: %s)",
		(mode) => {
			const p = match(prop("patient", "location"), "40.7 -74.0", mode);
			const result = conditionVerdict(p, ctxWithGeo);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.errors).toHaveLength(1);
				expect(result.errors[0].path).toEqual(["property"]);
				expect(result.errors[0].message).toMatch(new RegExp(`mode='${mode}'`));
			}
		},
	);
});

describe("conditionVerdict — multi-select-contains property requirement", () => {
	// `multi-select-contains` is the typed structural shape lowered to
	// per-value `selected(prop, 'v')` calls joined by OR / AND on every
	// wire path. CCHQ's `selected` whitelist entry at
	// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`
	// dispatches through `case_property_query` and accepts text /
	// single_select / multi_select properties uniformly, but the *Nova*
	// authoring-time policy is stricter: only a multi_select property
	// has the structural notion of "contains" (multi-token storage,
	// per-token containment). Routing single_select or text through
	// `multi-select-contains` is virtually always an authoring bug
	// (e.g. the author meant `match` or `eq`), so the type checker
	// rejects everything but multi_select. Authors who genuinely want
	// "field contains a value" against a non-multi_select property use
	// `match(..., starts-with)` or a comparison.

	it.each(MULTI_SELECT_QUANTIFIERS)(
		"accepts multi-select-contains on a multi_select property (quantifier: %s)",
		(quantifier) => {
			const p =
				quantifier === "any"
					? multiSelectAny(prop("patient", "tags"), literal("vip"))
					: multiSelectAll(prop("patient", "tags"), literal("vip"));
			expect(conditionVerdict(p, ctx).ok).toBe(true);
		},
	);

	// Parameterized rejection across every non-multi_select data type
	// (text, single_select, ordered numerics, temporals, geopoint).
	// Without iterating the full set, a regression that loosened the
	// allow-list to "anything text-shaped" (the looser allow-list `match`
	// uses) would slip through — text and single_select would silently
	// pass while int / decimal / date would still fail. The table closes
	// that gap.
	const REJECTED_NON_MULTI_SELECT = [
		{ propName: "case_name", dataType: "text" },
		{ propName: "status", dataType: "single_select" },
		{ propName: "age", dataType: "int" },
		{ propName: "weight_kg", dataType: "decimal" },
		{ propName: "dob", dataType: "date" },
		{ propName: "last_seen", dataType: "datetime" },
		{ propName: "appointment_time", dataType: "time" },
	] as const;
	it.each(REJECTED_NON_MULTI_SELECT)(
		"rejects multi-select-contains on a $dataType property",
		({ propName }) => {
			const p = multiSelectAny(prop("patient", propName), literal("x"));
			const result = conditionVerdict(p, ctx);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				// Property-rule errors attach to the operator's `property`
				// path, parallel to `match` and `within-distance`.
				expect(result.errors[0].path).toEqual(["property"]);
				expect(result.errors[0].message).toMatch(/multi_select/i);
			}
		},
	);

	it("rejects multi-select-contains on a geopoint property", () => {
		const p = multiSelectAny(
			prop("patient", "location"),
			literal("40.7 -74.0"),
		);
		const result = conditionVerdict(p, ctxWithGeo);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].path).toEqual(["property"]);
			expect(result.errors[0].message).toMatch(/multi_select/i);
		}
	});

	// Each value in `values` is type-checked against the property's
	// resolved type. The membership-compatibility table reuses
	// `typesCompatible` so the same widenings apply (null-as-universal,
	// select-to-text). Pinning a per-value mismatch locks the per-value
	// path-tracking convention, parallel to `in`.
	it("rejects multi-select-contains when a value's type doesn't match the property", () => {
		const p = multiSelectAny(
			prop("patient", "tags"),
			literal(42), // numeric literal against multi_select (string-coerced)
		);
		const result = conditionVerdict(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			// One error, on `values[0]`. Property-side stays valid (the
			// property exists and is multi_select).
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].path).toEqual(["values", 0]);
			expect(result.errors[0].message).toMatch(/type mismatch/i);
		}
	});

	it("accepts a null literal in the values list (null-as-universal carries over)", () => {
		// Null literals resolve to the internal `_any` sentinel and are
		// compatible with every property type — the same widening that
		// applies to `in` and to comparison operators.
		const p = multiSelectAny(
			prop("patient", "tags"),
			literal(null),
			literal("vip"),
		);
		expect(conditionVerdict(p, ctx).ok).toBe(true);
	});
});

// `match-all` and `match-none` are nullary discriminator-only
// sentinels — by construction well-typed, no operands and no
// operator-specific semantic rule. The walker accepts them silently
// and recurses no further. The composition test is the load-bearing
// one: a sentinel embedded inside `and(...)` must not crash the walk
// when the recursion reaches the sentinel arm. Without the dedicated
// arm in `walk`, the grouped throwing fall-through would turn every
// composed predicate that includes a sentinel into a runtime crash.
describe("conditionVerdict — sentinel predicates", () => {
	it("accepts match-all standalone", () => {
		expect(conditionVerdict(matchAll(), ctx).ok).toBe(true);
	});

	it("accepts match-none standalone", () => {
		expect(conditionVerdict(matchNone(), ctx).ok).toBe(true);
	});

	it("accepts match-all composed inside an and", () => {
		// The composition path is the bug-prevention case: the walker
		// recurses through `and` into the sentinel arm, so a throwing
		// arm here would surface as a crash on every composed
		// predicate that includes the identity element.
		const p = and(
			matchAll(),
			eq(prop("patient", "case_name"), literal("Alice")),
		);
		expect(conditionVerdict(p, ctx).ok).toBe(true);
	});

	it("accepts match-none composed inside an or", () => {
		// Symmetric to the and-with-match-all case: the absorbing
		// element appears as a clause inside `or`, the walker recurses
		// through `or` into the sentinel arm. Pinning the symmetric
		// case keeps the per-sentinel handling explicit rather than
		// implied by the match-all test.
		const p = or(
			matchNone(),
			eq(prop("patient", "case_name"), literal("Alice")),
		);
		expect(conditionVerdict(p, ctx).ok).toBe(true);
	});

	it("accepts match-all wrapped in not", () => {
		// `not(matchAll)` is a recursion through the unary wrapper —
		// the walker re-enters `walk` on the wrapped clause, which
		// dispatches into the sentinel arm. Without the dedicated
		// sentinel arm, this would crash inside `not`.
		const p = not(matchAll());
		expect(conditionVerdict(p, ctx).ok).toBe(true);
	});
});

// `between` is the structural range predicate — bounded interval on
// `left` with optional lower / upper bounds and per-bound inclusivity
// flags. The type checker enforces three rules:
//   1. `left` must resolve to an ordered type (int / decimal / date /
//      datetime) — the same `ORDERED_TYPES` set comparison
//      operators reuse for the `gt` / `gte` / `lt` / `lte` family.
//   2. Each provided bound (`lower` / `upper`) must resolve to a type
//      compatible with `left` — same `typesCompatible` widenings
//      comparison operators use, so numeric promotion / null-as-
//      universal carry over.
//   3. When both bounds are typed-literal Terms and `lower > upper`,
//      the predicate is identically false at every wire target. The
//      schema admits this shape because bounds may be Term refs whose
//      values aren't known at parse time; the checker is the right
//      place to catch the literal-pair case — it has the type context
//      to recognise a typed-literal pair, which the schema layer does
//      not.
describe("conditionVerdict — between operator rules", () => {
	it("accepts between on an int property with int bounds", () => {
		// Canonical positive case: `age` is int, both bounds are int
		// literals, the predicate type-checks cleanly. Pins the happy
		// path through the ordered-type + per-bound resolution +
		// per-bound compatibility cascade.
		const p = between(prop("patient", "age"), {
			lower: literal(18),
			upper: literal(65),
		});
		expect(conditionVerdict(p, ctx).ok).toBe(true);
	});

	it("accepts between on a date property with typed dateLiteral bounds", () => {
		// Date kinds are ordered; typed-date literals carry their
		// `data_type` explicitly so the comparator resolves them as
		// `date` rather than the generic JS-string fallback.
		const p = between(prop("patient", "dob"), {
			lower: dateLiteral("2000-01-01"),
			upper: dateLiteral("2024-12-31"),
		});
		expect(conditionVerdict(p, ctx).ok).toBe(true);
	});

	it("accepts between with only a lower bound (open-upper interval)", () => {
		// The schema admits the half-open interval shape. The checker
		// resolves the present bound and skips the absent one — pinning
		// the absence-tolerant resolution rule.
		const p = between(prop("patient", "age"), { lower: literal(18) });
		expect(conditionVerdict(p, ctx).ok).toBe(true);
	});

	it("accepts between with only an upper bound (open-lower interval)", () => {
		// Symmetric to the lower-only case — locks both halves of the
		// optional-bound resolution against a one-sided regression.
		const p = between(prop("patient", "age"), { upper: literal(65) });
		expect(conditionVerdict(p, ctx).ok).toBe(true);
	});

	it("rejects between on a text property (text is not ordered)", () => {
		// Text is intentionally excluded from `ORDERED_TYPES` — locale-
		// dependent string ordering rarely produces meaningful filters,
		// and routing authors to a different operator (`match` /
		// `starts-with`) is the deliberate UX. The error attaches to
		// the predicate's own path (parallel to comparison operators'
		// ordered-type rejection).
		const p = between(prop("patient", "case_name"), {
			lower: literal("a"),
			upper: literal("m"),
		});
		const result = conditionVerdict(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].path).toEqual([]);
			expect(result.errors[0].message).toMatch(/ordered|not ordered/i);
		}
	});

	it("rejects between when a bound's type is incompatible with left", () => {
		// `age` is int, the literal `"forty-two"` resolves to text —
		// the per-bound compatibility check rejects with the same
		// "type mismatch" framing comparison operators use, on the
		// failing bound's own path so the editor highlights the
		// offending operand directly.
		const p = between(prop("patient", "age"), {
			lower: literal("forty-two"),
			upper: literal(65),
		});
		const result = conditionVerdict(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].path).toEqual(["lower"]);
			expect(result.errors[0].message).toMatch(/type mismatch/i);
		}
	});

	it("rejects between when literal bounds are inverted (lower > upper)", () => {
		// Both bounds are typed-literal Terms with comparable values:
		// `100 > 18`, so the interval `[100, 18]` is empty by
		// construction. The checker rejects with a dedicated message
		// naming the impossibility — the schema admits the shape
		// because bounds may be Term refs whose values aren't known
		// at parse time, but the literal-pair case is statically
		// decidable here.
		const p = between(prop("patient", "age"), {
			lower: literal(100),
			upper: literal(18),
		});
		const result = conditionVerdict(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(
				/lower.*greater|inverted|empty/i,
			);
		}
	});

	it("accepts between with mixed numeric promotion (int prop, decimal bounds)", () => {
		// Numeric promotion (`int` ↔ `decimal`) carries over from the
		// comparison checker's compatibility table — locks the rule
		// that bounds reuse `typesCompatible` rather than enforcing
		// strict type identity.
		const p = between(prop("patient", "age"), {
			lower: literal(18.5),
			upper: literal(65.0),
		});
		expect(conditionVerdict(p, ctx).ok).toBe(true);
	});

	it("accepts between directly on a decimal property", () => {
		// Decimal is in `ORDERED_TYPES`. Direct decimal-to-decimal bound
		// pairing exercises the path that numeric promotion (above) only
		// reaches transitively — locks the rule that decimal is a
		// first-class ordered type, not just a target for int-promotion.
		const p = between(prop("patient", "weight_kg"), {
			lower: literal(40.0),
			upper: literal(120.0),
		});
		expect(conditionVerdict(p, ctx).ok).toBe(true);
	});

	it("refuses between anchored on a time property under time-ordering", () => {
		const p = between(prop("patient", "appointment_time"), {
			lower: timeLiteral("09:00:00"),
			upper: timeLiteral("17:00:00"),
		});
		const result = conditionVerdict(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].code).toBe("time-ordering");
		}
		expect(
			conditionVerdict(
				between(prop("patient", "dob"), {
					lower: dateLiteral("2000-01-01"),
					upper: dateLiteral("2001-01-01"),
				}),
				ctx,
			).ok,
		).toBe(true);
	});

	it("refuses between on text under ordered-values, naming no time", () => {
		const result = conditionVerdict(
			between(prop("patient", "case_name"), { lower: literal("a") }),
			ctx,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].code).toBe("ordered-values");
			expect(result.errors[0].message).toBe(
				"Operator 'between' requires an ordered left operand (int, decimal, date, datetime); got 'text'. Strings are not ordered.",
			);
		}
	});

	it("propagates errors through wrapper recursion (between inside and)", () => {
		// Pins the wrapper-recursion contract: a `between` violation
		// nested inside `and` surfaces with a path that threads the
		// wrapper's `kind` and clause index. The regression target is
		// "the real between rule fires inside wrappers."
		const p = and(
			eq(prop("patient", "case_name"), literal("Alice")),
			between(prop("patient", "case_name"), {
				lower: literal("a"),
				upper: literal("m"),
			}),
		);
		const result = conditionVerdict(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/ordered|not ordered/i);
			expect(result.errors[0].path).toEqual(["and", 1]);
		}
	});
});

// `exists` and `missing` are the relational quantifiers — "at least
// one related case along `via` satisfies `where`" / "no related case
// along `via` satisfies `where`." The type checker enforces:
//   1. `via` resolves to a destination case type via `checkRelationPath`
//      (walks `parent_type` for ancestors; reverse-walks for subcase /
//      any-relation). The destination must exist in `ctx.caseTypes`.
//   2. `where` (if present) is type-checked recursively in the
//      destination scope — `prop` references inside `where` resolve
//      against the destination case type, not the originating one.
//   3. `via.kind === "self"` at the top-level (no parent destination
//      to anchor on) is a meaningless self-relation and emits an
//      error; inside a `where` clause `self` is the explicit no-
//      traversal form and routes through to the current scope.
//
// Fixtures below model a small relationship graph: visit → patient →
// household. Visit is a child of patient; patient is a child of
// household. Subcase / any-relation walks reverse the direction.
const HOUSEHOLD: CaseType = {
	name: "household",
	properties: [
		{ name: "region", label: proseText("Region"), data_type: "text" },
		{ name: "size", label: proseText("Size"), data_type: "int" },
	],
};

const PATIENT_WITH_PARENT: CaseType = {
	...PATIENT,
	parent_type: "household",
};

const VISIT: CaseType = {
	name: "visit",
	properties: [
		{ name: "kind", label: proseText("Kind"), data_type: "text" },
		{ name: "completed", label: proseText("Completed"), data_type: "text" },
	],
	parent_type: "patient",
};

// Sibling subcase under patient — used to exercise ambiguity rejection
// when both `visit` and `lab_result` carry `parent_type === "patient"`
// and the author hasn't disambiguated via `ofCaseType`.
const LAB_RESULT: CaseType = {
	name: "lab_result",
	properties: [
		{ name: "value", label: proseText("Value"), data_type: "decimal" },
	],
	parent_type: "patient",
};

const ctxRelations = {
	caseTypes: [HOUSEHOLD, PATIENT_WITH_PARENT, VISIT, LAB_RESULT],
	knownInputs: [],
};

describe("conditionVerdict — exists / missing relation-path resolution", () => {
	it("accepts exists with an ancestor walk (single hop) and no where clause", () => {
		// From `patient`, the ancestor walk via `parent` lands on
		// `household` (patient's `parent_type`). No where-clause means
		// the predicate degenerates to "any household ancestor exists,"
		// which is structurally well-typed regardless of household's
		// properties.
		const p = exists(ancestorPath(relationStep("parent")));
		const result = conditionVerdict(p, {
			...ctxRelations,
			currentCaseType: "patient",
		});
		expect(result.ok).toBe(true);
	});

	it("accepts exists with an ancestor walk and a destination-scope where clause", () => {
		// From `patient`, walking the parent index reaches `household`;
		// the where-clause filters that destination by `household.region`.
		// The where-clause's `prop` references explicitly name
		// `household` as the originating scope — the case type
		// qualifier names the predicate's "self" position, which
		// inside a where-clause is the destination of the outer
		// `via`.
		const p = exists(
			ancestorPath(relationStep("parent")),
			eq(prop("household", "region"), literal("north")),
		);
		const result = conditionVerdict(p, {
			...ctxRelations,
			currentCaseType: "patient",
		});
		expect(result.ok).toBe(true);
	});

	it("accepts exists with a multi-hop ancestor walk (visit → patient → household)", () => {
		// Two-step walk — locks the chained-resolution rule. From
		// `visit`, the first hop's destination is `patient`
		// (visit.parent_type), and the second hop's destination is
		// `household` (patient.parent_type). The where-clause names
		// `household` as its originating scope.
		const p = exists(
			ancestorPath(relationStep("parent"), relationStep("parent")),
			eq(prop("household", "region"), literal("north")),
		);
		const result = conditionVerdict(p, {
			...ctxRelations,
			currentCaseType: "visit",
		});
		expect(result.ok).toBe(true);
	});

	it("accepts ancestor step with a matching throughCaseType qualifier", () => {
		// The qualifier validates `origin.parent_type ===
		// step.throughCaseType` at each hop. From `patient`, the
		// expected destination is `household`, and the step explicitly
		// names that — locking the rule that valid qualifiers pass
		// through transparently.
		const p = exists(
			ancestorPath(relationStep("parent", "household")),
			eq(prop("household", "region"), literal("north")),
		);
		const result = conditionVerdict(p, {
			...ctxRelations,
			currentCaseType: "patient",
		});
		expect(result.ok).toBe(true);
	});

	it("rejects ancestor step when throughCaseType disagrees with the actual parent_type", () => {
		// From `patient`, the actual `parent_type` is `household`. A
		// step that claims to walk `through visit` is a structural
		// mismatch the type-checker catches — the qualifier exists to
		// pin authoring intent against the schema, not to override it.
		const p = exists(
			ancestorPath(relationStep("parent", "visit")),
			eq(prop("visit", "kind"), literal("intake")),
		);
		const result = conditionVerdict(p, {
			...ctxRelations,
			currentCaseType: "patient",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(
				/throughCaseType|parent_type|household/i,
			);
			expect(result.errors[0].code).toBe("relation-path");
		}
	});

	it("rejects ancestor walk when origin has no parent_type", () => {
		// `household` is the root of the relationship graph — no
		// `parent_type` field. An ancestor walk from `household`
		// resolves to nothing; the checker emits an error rather than
		// returning a silent undefined.
		const p = exists(ancestorPath(relationStep("parent")));
		const result = conditionVerdict(p, {
			...ctxRelations,
			currentCaseType: "household",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/no parent|household.*parent/i);
		}
	});

	it("accepts subcase walk with ofCaseType disambiguation", () => {
		// Both `visit` and `lab_result` are subcases of `patient`. The
		// `ofCaseType` qualifier picks the destination unambiguously —
		// pinning the disambiguation rule that resolves the multi-
		// candidate case at authoring time rather than letting the
		// emitter / runtime guess.
		const p = exists(
			subcasePath("parent", "visit"),
			eq(prop("visit", "kind"), literal("intake")),
		);
		const result = conditionVerdict(p, {
			...ctxRelations,
			currentCaseType: "patient",
		});
		expect(result.ok).toBe(true);
	});

	it("accepts subcase walk when only one candidate exists (no ofCaseType needed)", () => {
		// Modify the fixture so only `visit` carries `parent_type ===
		// "patient"`; resolution is unambiguous and `ofCaseType` is
		// unnecessary. Locks the single-candidate happy path.
		const ctxOneSubcase = {
			caseTypes: [HOUSEHOLD, PATIENT_WITH_PARENT, VISIT],
			knownInputs: [],
			currentCaseType: "patient" as const,
		};
		const p = exists(
			subcasePath("parent"),
			eq(prop("visit", "kind"), literal("intake")),
		);
		expect(conditionVerdict(p, ctxOneSubcase).ok).toBe(true);
	});

	it("rejects subcase walk when multiple candidates exist and ofCaseType is omitted", () => {
		// Both `visit` and `lab_result` carry `parent_type === "patient"`,
		// so the destination is ambiguous. Without `ofCaseType`, the
		// type-checker rejects rather than picking one silently.
		const p = exists(
			subcasePath("parent"),
			eq(prop("visit", "kind"), literal("intake")),
		);
		const result = conditionVerdict(p, {
			...ctxRelations,
			currentCaseType: "patient",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(
				/ambiguous|ofCaseType|multiple/i,
			);
			expect(result.errors[0].code).toBe("relation-ambiguous");
		}
	});

	it("rejects subcase walk when ofCaseType names a non-existent case type", () => {
		// `ghost` isn't in `ctx.caseTypes`. The walk fails with an
		// unknown-case-type error, parallel to the comparison
		// checker's unknown-case-type message.
		const p = exists(subcasePath("parent", "ghost"));
		const result = conditionVerdict(p, {
			...ctxRelations,
			currentCaseType: "patient",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/unknown case type|ghost/i);
			expect(result.errors[0].code).toBe("relation-destination");
		}
	});

	it("rejects subcase walk when ofCaseType names a declared but non-subcase type", () => {
		// `household` is a real case type but not a subcase of
		// `patient` (the relationship runs the other way: `patient`
		// is a subcase of `household`). Locks the second of the two
		// `ofCaseType` failure modes — the known-but-wrong-subcase
		// case — distinct from the unknown-case-type message.
		const p = exists(subcasePath("parent", "household"));
		const result = conditionVerdict(p, {
			...ctxRelations,
			currentCaseType: "patient",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/not a subcase|parent_type/i);
		}
	});

	it("rejects subcase walk when zero candidates declare the origin as parent_type", () => {
		// `lab_result` has no case types declaring `parent_type ===
		// "lab_result"` (the schema models lab_result as a leaf in the
		// fixture). The walk produces a distinct error message from
		// "ambiguous" (which fires on multiple candidates) and from
		// "not a subcase" (which fires when ofCaseType names a wrong
		// type). Locks the third reverse-walk failure mode — the
		// no-candidates case — so the editor surfaces the right hint.
		const p = exists(subcasePath("parent"));
		const result = conditionVerdict(p, {
			...ctxRelations,
			currentCaseType: "lab_result",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(
				/no.*subcase|no case type.*parent_type|no candidate/i,
			);
		}
	});

	it("accepts an either-direction walk explicitly targeting a child", () => {
		const p = exists(
			anyRelationPath("parent", "visit"),
			eq(prop("visit", "kind"), literal("intake")),
		);
		const result = conditionVerdict(p, {
			...ctxRelations,
			currentCaseType: "patient",
		});
		expect(result.ok).toBe(true);
	});

	it("accepts an either-direction walk explicitly targeting the parent", () => {
		const p = exists(
			anyRelationPath("parent", "household"),
			eq(prop("household", "region"), literal("north")),
		);
		expect(
			conditionVerdict(p, {
				...ctxRelations,
				currentCaseType: "patient",
			}).ok,
		).toBe(true);
	});

	it("infers the parent when it is the only either-direction target", () => {
		const p = exists(
			anyRelationPath("parent"),
			eq(prop("patient", "case_name"), literal("Alice")),
		);
		expect(
			conditionVerdict(p, {
				...ctxRelations,
				currentCaseType: "visit",
			}).ok,
		).toBe(true);
	});

	it("infers the child when it is the only either-direction target", () => {
		const p = exists(
			anyRelationPath("parent"),
			eq(prop("patient", "case_name"), literal("Alice")),
		);
		expect(
			conditionVerdict(p, {
				caseTypes: [HOUSEHOLD, PATIENT_WITH_PARENT],
				knownInputs: [],
				currentCaseType: "household",
			}).ok,
		).toBe(true);
	});

	it("deduplicates a recursive case type in the either-direction union", () => {
		const node: CaseType = {
			name: "node",
			parent_type: "node",
			properties: [
				{ name: "label", label: proseText("Label"), data_type: "text" },
			],
		};
		const p = exists(
			anyRelationPath("parent"),
			eq(prop("node", "label"), literal("Root")),
		);
		expect(
			conditionVerdict(p, {
				caseTypes: [node],
				knownInputs: [],
				currentCaseType: "node",
			}).ok,
		).toBe(true);
	});

	it("requires a case-type choice when either direction reaches different types", () => {
		const result = conditionVerdict(exists(anyRelationPath("parent")), {
			...ctxRelations,
			currentCaseType: "patient",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ code: "relation-ambiguous" }),
				]),
			);
		}
	});

	it("requires an explicit destination for a custom index", () => {
		const result = conditionVerdict(
			exists(ancestorPath(relationStep("guardian_link"))),
			{ ...ctxRelations, currentCaseType: "patient" },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0]).toMatchObject({
				code: "relation-destination",
			});
			expect(result.errors[0].message).toMatch(/custom|throughCaseType/i);
		}
	});

	it("accepts an explicit custom destination outside the parent graph", () => {
		const p = exists(
			ancestorPath(relationStep("guardian_link", "visit")),
			eq(prop("visit", "kind"), literal("intake")),
		);
		expect(
			conditionVerdict(p, {
				...ctxRelations,
				currentCaseType: "patient",
			}).ok,
		).toBe(true);
	});

	it("rejects exists at top-level with via: self (meaningless self-relation)", () => {
		// `exists(selfPath())` asks "does the current case have itself,"
		// which is always true and almost certainly an authoring bug.
		// At the top level there's no destination to anchor on, so the
		// kind is rejected. (Inside a where-clause, `selfPath()` is
		// the explicit no-traversal form and routes through to the
		// current scope — see the nested-self test below.)
		const p = exists(selfPath());
		const result = conditionVerdict(p, {
			...ctxRelations,
			currentCaseType: "patient",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/self|meaningless|relation/i);
		}
	});

	it("rejects exists when the originating case type is not provided", () => {
		// The checker has no top-level `currentCaseType` to anchor
		// from — the relation walk has no origin. The case-list config
		// UI supplies the field when invoking the checker; the error
		// here pins the requirement so a programmatic source that
		// omits the field fails loudly rather than silently bypassing
		// the walk.
		const p = exists(ancestorPath(relationStep("parent")));
		const result = conditionVerdict(p, ctxRelations); // no currentCaseType
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(
				/originating|case type|currentCaseType/i,
			);
		}
	});

	it("rejects when prop.caseType inside where-clause disagrees with the destination", () => {
		// The where-clause's `prop` references must name the
		// destination case type as their originating scope. From
		// `patient`, the parent walk lands on `household`, but the
		// where-clause names `patient` — the constraint catches this
		// at the destination-scope check.
		const p = exists(
			ancestorPath(relationStep("parent")),
			eq(prop("patient", "case_name"), literal("Alice")),
		);
		const result = conditionVerdict(p, {
			...ctxRelations,
			currentCaseType: "patient",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(
				/destination|household|patient.*scope/i,
			);
		}
	});

	it("rebinds the originating scope across nested exists (chained relation walks)", () => {
		// Outer `exists` walks visit → patient. The where-clause
		// itself contains another `exists` walking patient → household.
		// The inner exists's relation walk anchors on the outer's
		// destination (`patient`) via the `currentCaseType`
		// rebinding inside `checkInDestinationScope`. The innermost
		// where-clause references `household.region` after the second
		// walk lands. Pins the scope-rebinding contract across
		// arbitrarily-nested walks rather than implying it from the
		// single-walk tests alone.
		const p = exists(
			ancestorPath(relationStep("parent")),
			exists(
				ancestorPath(relationStep("parent")),
				eq(prop("household", "region"), literal("north")),
			),
		);
		const result = conditionVerdict(p, {
			...ctxRelations,
			currentCaseType: "visit",
		});
		expect(result.ok).toBe(true);
	});

	it("missing operates symmetrically with exists (parallel rule shape)", () => {
		// `missing` is sugar for `not(exists(...))` at the wire layer
		// but carries the same type-checker rule shape — locking the
		// symmetry pins the rule reuse (both kinds dispatch through
		// the same helper) rather than relying on `missing`'s
		// non-coverage to imply `exists`'s coverage.
		const p = missing(
			ancestorPath(relationStep("parent")),
			eq(prop("household", "region"), literal("north")),
		);
		const result = conditionVerdict(p, {
			...ctxRelations,
			currentCaseType: "patient",
		});
		expect(result.ok).toBe(true);
	});

	it("propagates errors from inside the where-clause through wrapper recursion", () => {
		// A type-mismatch deep inside the where-clause surfaces with a
		// path that threads the outer operator's `kind`, the `where`
		// slot name, and the comparison-operator's own per-side
		// segment. Pinning the full path locks the kind-segment
		// threading the relational arms add — without it, a
		// regression that dropped `["exists", "where"]` from the
		// recursion would leave the message shape intact and slip
		// past the message-only assertion.
		const p = exists(
			ancestorPath(relationStep("parent")),
			eq(prop("household", "size"), literal("not-a-number")),
		);
		const result = conditionVerdict(p, {
			...ctxRelations,
			currentCaseType: "patient",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].path).toEqual(["exists", "where"]);
			expect(result.errors[0].message).toMatch(/type mismatch/i);
		}
	});
});

describe("conditionVerdict — matches-pattern admission", () => {
	const inputCtx = {
		...ctx,
		knownInputs: [{ uuid: testUuid("ssn"), name: "ssn" }],
	};

	it("is refused wherever the slot does not run on the device's Pattern engine", () => {
		// The strict default: a context that says nothing about pattern
		// matching cannot offer a leaf its wire cannot lower (CSQL has no
		// regex, the case store is PostgreSQL).
		const p = matchesPattern(input(testUuid("ssn")), "^[0-9]{9}$");
		const result = conditionVerdict(p, inputCtx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].code).toBe("pattern-match-unavailable");
			expect(result.errors[0].path).toEqual([]);
			expect(result.errors[0].message).toMatch(/required condition or check/);
		}
	});

	it("is accepted where the context runs the device's Pattern engine", () => {
		const p = matchesPattern(input(testUuid("ssn")), "^[0-9]{9}$");
		expect(conditionVerdict(p, { ...inputCtx, patternMatching: true }).ok).toBe(
			true,
		);
	});

	it("accepts a session read and a computed subject", () => {
		const pmCtx: QueryFixture = { ...inputCtx, patternMatching: true };
		expect(
			conditionVerdict(matchesPattern(sessionUser("region"), "^[A-Z]"), pmCtx)
				.ok,
		).toBe(true);
		expect(
			conditionVerdict(
				matchesPattern(sessionContext("username"), "^[a-z]+$"),
				pmCtx,
			).ok,
		).toBe(true);
	});

	it("propagates an unresolved input from the subject at ['left']", () => {
		const p = matchesPattern(input(testUuid("missing")), "^x");
		const result = conditionVerdict(p, { ...ctx, patternMatching: true });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].path).toEqual(["left"]);
		}
	});
});

describe("conditionVerdict — is-blank operand-shape rules", () => {
	it("accepts is-blank on a property reference", () => {
		// Mirrors `is-null`'s acceptance — same operand-shape rule,
		// different wire-emission semantic. The type checker does not
		// narrow on "absent vs absent-or-empty"; both operators
		// resolve the term and accept any non-literal shape.
		const p = isBlank(prop("patient", "case_name"));
		expect(conditionVerdict(p, ctx).ok).toBe(true);
	});

	it("accepts is-blank on a search-input reference", () => {
		const ctxWithInput = {
			...ctx,
			knownInputs: [{ uuid: testUuid("phone"), name: "phone" }],
		};
		const p = isBlank(input(testUuid("phone")));
		expect(conditionVerdict(p, ctxWithInput).ok).toBe(true);
	});

	it("accepts is-blank on a session-user reference", () => {
		const p = isBlank(sessionUser("region"));
		expect(conditionVerdict(p, ctx).ok).toBe(true);
	});

	it("accepts is-blank on a session-context reference", () => {
		const p = isBlank(sessionContext("userid"));
		expect(conditionVerdict(p, ctx).ok).toBe(true);
	});

	it("propagates unresolved-input errors from is-blank's left", () => {
		// An undeclared input emits the same shape of error a comparison's
		// input operand would.
		const p = isBlank(input(testUuid("phone")));
		const result = conditionVerdict(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].path).toEqual(["left"]);
			expect(result.errors[0].code).toBe("unknown-search-input");
		}
	});
});

// `prop.via` carries a relation walk whose resolution rule —
// "look up `property` on the destination case type, not on
// `caseType`" — is the destination-scope check. The originating-
// scope check (does `property` exist on `caseType`?) is
// structural and runs unconditionally when `via` is absent or
// `self`; with a non-self `via`, the resolution flips: `caseType`
// names the originating scope (the predicate's "self" position),
// the walk resolves to a destination case type, and `property` is
// looked up on the destination. This is the originating-scope
// contract locked by the JSDoc on `propertyRefSchema.caseType`.
describe("conditionVerdict — prop.via destination-scope resolution", () => {
	it("resolves prop with an ancestor via on the destination case type", () => {
		// From `patient`, the ancestor walk via `parent` reaches
		// `household`. The property `region` is read on `household`
		// (the destination), not on `patient` (the originating scope).
		// The comparison's compatibility check confirms `region`
		// resolved to text, matching the text literal on the right.
		const p = eq(
			prop("patient", "region", ancestorPath(relationStep("parent"))),
			literal("north"),
		);
		expect(conditionVerdict(p, ctxRelations).ok).toBe(true);
	});

	it("resolves prop with multi-hop ancestor via on the final destination", () => {
		// From `visit`, the two-hop walk lands on `household`. The
		// property `region` is read on `household` — locks the chained-
		// resolution rule for property terms (parallel to the chained
		// rule `exists` uses for relation paths).
		const p = eq(
			prop(
				"visit",
				"region",
				ancestorPath(relationStep("parent"), relationStep("parent")),
			),
			literal("north"),
		);
		expect(conditionVerdict(p, ctxRelations).ok).toBe(true);
	});

	it("resolves prop with a subcase via on the destination case type", () => {
		// From `patient`, the subcase walk to `visit` (disambiguated
		// via `ofCaseType`) puts `kind` on the destination. The
		// originating scope stays `patient`; the destination scope
		// is where `kind` is resolved.
		const p = eq(
			prop("patient", "kind", subcasePath("parent", "visit")),
			literal("intake"),
		);
		expect(conditionVerdict(p, ctxRelations).ok).toBe(true);
	});

	it("rejects prop.via when the property is unknown on the destination", () => {
		// `region` exists on `household` but not on `visit`. The
		// destination-scope lookup fails — the error message names
		// the destination case type so the editor can highlight the
		// real cause rather than steering the author back to
		// `patient`'s property surface.
		const p = eq(
			prop("patient", "region", subcasePath("parent", "visit")),
			literal("x"),
		);
		const result = conditionVerdict(p, ctxRelations);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].path).toEqual(["left"]);
			expect(result.errors[0].message).toMatch(
				/unknown property.*region.*visit|region.*visit/i,
			);
		}
	});

	it("rejects prop.via when the relation-path resolution itself fails", () => {
		// `household` has no `parent_type`, so the ancestor walk from
		// `household` resolves to nothing. The property lookup never
		// runs; the relation-path error surfaces alone (no cascading
		// "unknown property" message piled on top, matching the
		// resolution-failure short-circuit pattern that comparison
		// operators use).
		const p = eq(
			prop("household", "size", ancestorPath(relationStep("parent"))),
			literal(10),
		);
		const result = conditionVerdict(p, ctxRelations);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].path).toEqual(["left"]);
		}
	});

	it("accepts prop with via: self (no-traversal form, originating-scope lookup)", () => {
		// `selfPath()` is the explicit no-traversal kind; the arm
		// passes through to the originating-scope check (looks up
		// `name` on `patient` directly). Pinning the positive case
		// keeps the no-traversal shape distinct from the cross-type
		// traversal kinds.
		const p = eq(prop("patient", "case_name", selfPath()), literal("Alice"));
		expect(conditionVerdict(p, ctx).ok).toBe(true);
	});

	it("accepts prop without via (originating-scope lookup, baseline)", () => {
		// Sanity-check the absent-via shape continues to resolve on
		// the originating scope after the destination-scope code path
		// landed. Locks the no-`via` regression target — a refactor
		// that rerouted absent-via through the destination-scope code
		// would silently break every existing predicate.
		const p = eq(prop("patient", "case_name"), literal("Alice"));
		expect(conditionVerdict(p, ctx).ok).toBe(true);
	});

	it("rejects prop.via when the originating case type itself is unknown", () => {
		// `phantom_origin` is not in `ctx.caseTypes`. Combined with a
		// non-self `via`, the relation walk's first hop fails on the
		// origin lookup — distinct from the "destination case type
		// not found" failure that fires on later hops. Locks the
		// originating-side error message ("Unknown originating case
		// type") so the editor surfaces the right hint when the author
		// typo's the originating case-type name.
		const p = eq(
			prop("phantom_origin", "x", ancestorPath(relationStep("parent"))),
			literal("anything"),
		);
		const result = conditionVerdict(p, ctxRelations);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(
				/unknown originating|phantom_origin/i,
			);
		}
	});
});
// Record-query inference retains the existing scalar operator rules. The
// examples below pin resolved data types and refusal paths independently of
// a slot's root expectation.

function resolve(expr: ExpressionLike, contextOverride: QueryFixture = ctx) {
	const outcome = inferRecordQuery(expr, recordQueryContext(contextOverride));
	return { type: scalarDataType(outcome.type?.data), errors: outcome.errors };
}

type ExpressionLike = Parameters<typeof checkExpression>[0];

describe("checkExpression — leaf arms", () => {
	it("infers a property reference term", () => {
		const { type, errors } = resolve(term(prop("patient", "age")));
		expect(type).toBe("int");
		expect(errors).toEqual([]);
	});

	it("term arm surfaces unknown-property errors via resolveTermType", () => {
		const { type, errors } = resolve(term(prop("patient", "phantom")));
		expect(type).toBeUndefined();
		expect(errors[0].message).toMatch(/Unknown property 'phantom'/);
	});

	it("today / now resolve to date / datetime", () => {
		expect(resolve(today()).type).toBe("date");
		expect(resolve(now()).type).toBe("datetime");
	});
});

describe("checkExpression — date / coercion arms", () => {
	it("date-add returns the date operand's type and accepts numeric quantity", () => {
		const v = dateAdd(today(), "days", term(literal(7)));
		const { type, errors } = resolve(v);
		expect(type).toBe("date");
		expect(errors).toEqual([]);
	});

	it("date-add rejects a non-numeric quantity", () => {
		const v = dateAdd(today(), "days", term(literal("seven")));
		const { errors } = resolve(v);
		expect(errors.some((e) => /numeric quantity/.test(e.message))).toBe(true);
	});

	it("date-add rejects a non-date operand", () => {
		const v = dateAdd(term(literal(42)), "days", term(literal(1)));
		const { errors } = resolve(v);
		expect(
			errors.some((e) => /requires a date or datetime/.test(e.message)),
		).toBe(true);
	});

	it("date-coerce accepts text-shaped and returns date", () => {
		const v = dateCoerce(term(prop("patient", "case_name")));
		const { type, errors } = resolve(v);
		expect(type).toBe("date");
		expect(errors).toEqual([]);
	});

	it("date-coerce rejects a numeric operand", () => {
		const v = dateCoerce(term(prop("patient", "age")));
		const { type, errors } = resolve(v);
		expect(type).toBe("date");
		expect(
			errors.some((e) => /text-shaped or date-shaped operand/.test(e.message)),
		).toBe(true);
	});

	it("date-coerce accepts a date operand — identity coercion is legal", () => {
		// An expression authored while a property read as text may wrap
		// it in an explicit coerce; the property RESOLVING to date under
		// derived typing must not turn that sound shape into a finding.
		const v = dateCoerce(term(prop("patient", "dob")));
		const { type, errors } = resolve(v);
		expect(type).toBe("date");
		expect(errors).toEqual([]);
	});

	it("datetime-coerce returns datetime", () => {
		const v = datetimeCoerce(term(prop("patient", "case_name")));
		expect(resolve(v).type).toBe("datetime");
	});

	it("double accepts text or numeric and returns decimal", () => {
		expect(resolve(double(term(prop("patient", "case_name")))).type).toBe(
			"decimal",
		);
		expect(resolve(double(term(prop("patient", "age")))).type).toBe("decimal");
	});

	it("double rejects a date operand", () => {
		const v = double(term(prop("patient", "dob")));
		const { errors } = resolve(v);
		expect(errors.some((e) => /text-shaped or numeric/.test(e.message))).toBe(
			true,
		);
	});
});

describe("checkExpression — arith arm + numeric promotion", () => {
	it("int + int = int", () => {
		const v = arith("+", term(literal(1)), term(literal(2)));
		expect(resolve(v).type).toBe("int");
	});

	it("int + decimal = decimal", () => {
		const v = arith("+", term(literal(1)), term(literal(1.5)));
		expect(resolve(v).type).toBe("decimal");
	});

	it("decimal + decimal = decimal", () => {
		const v = arith("*", term(literal(1.5)), term(literal(2.5)));
		expect(resolve(v).type).toBe("decimal");
	});

	it.each(["+", "-", "*", "div", "mod"] as const)(
		"arith(%s) accepts both operands as int",
		(op) => {
			const v = arith(op, term(literal(1)), term(literal(2)));
			const { type, errors } = resolve(v);
			expect(type).toBe("int");
			expect(errors).toEqual([]);
		},
	);

	it("arith rejects a non-numeric left operand", () => {
		const v = arith("+", term(prop("patient", "case_name")), term(literal(1)));
		const { errors } = resolve(v);
		expect(
			errors.some((e) => /arith requires numeric.*left/.test(e.message)),
		).toBe(true);
	});

	it("arith rejects a non-numeric right operand", () => {
		const v = arith("+", term(literal(1)), term(prop("patient", "dob")));
		const { errors } = resolve(v);
		expect(
			errors.some((e) => /arith requires numeric.*right/.test(e.message)),
		).toBe(true);
	});
});

describe("checkExpression — concat / coalesce arms", () => {
	it("concat resolves to text regardless of part types", () => {
		const v = concat(term(prop("patient", "case_name")), term(literal(42)));
		expect(resolve(v).type).toBe("text");
	});

	it("coalesce resolves to the agreed type across compatible values", () => {
		// All-int → int; null literals widen to anything.
		const v = coalesce(
			term(prop("patient", "age")),
			term(literal(null)),
			term(literal(0)),
		);
		expect(resolve(v).type).toBe("int");
	});

	it("coalesce flags type mismatch between values", () => {
		const v = coalesce(
			term(prop("patient", "age")),
			term(prop("patient", "case_name")),
		);
		const { errors } = resolve(v);
		expect(
			errors.some((e) => /values must agree on type/.test(e.message)),
		).toBe(true);
	});
});

describe("checkExpression — if / switch arms", () => {
	it("if walks cond as a condition and returns the branches' agreed type", () => {
		const v = ifExpr(
			isBlank(prop("patient", "case_name")),
			term(literal("(empty)")),
			term(prop("patient", "case_name")),
		);
		expect(resolve(v).type).toBe("text");
	});

	it("if surfaces a condition error inside cond", () => {
		const v = ifExpr(
			eq(prop("patient", "phantom"), literal(0)),
			term(literal("a")),
			term(literal("b")),
		);
		const { errors } = resolve(v);
		expect(
			errors.some((e) => /Unknown property 'phantom'/.test(e.message)),
		).toBe(true);
	});

	it("if flags branch-type disagreement", () => {
		const v = ifExpr(
			matchAll(),
			term(prop("patient", "age")),
			term(prop("patient", "case_name")),
		);
		const { errors } = resolve(v);
		expect(errors.some((e) => /branches must agree/.test(e.message))).toBe(
			true,
		);
	});

	it("switch checks each case.when against on's type", () => {
		const v = switchExpr(
			term(prop("patient", "status")),
			[
				switchCase(literal("open"), term(literal(1))),
				switchCase(literal("closed"), term(literal(0))),
			],
			term(literal(-1)),
		);
		expect(resolve(v).type).toBe("int");
	});

	it("switch flags a case.when literal incompatible with on", () => {
		const v = switchExpr(
			term(prop("patient", "age")),
			[switchCase(literal("not-a-number"), term(literal(0)))],
			term(literal(-1)),
		);
		const { errors } = resolve(v);
		expect(
			errors.some((e) =>
				/'when' literal.*not comparable with switch.on/.test(e.message),
			),
		).toBe(true);
	});

	it("switch flags case.then incompatible with the established branch type", () => {
		const v = switchExpr(
			term(prop("patient", "status")),
			[
				switchCase(literal("open"), term(literal(1))),
				switchCase(literal("closed"), term(literal("two"))),
			],
			term(literal(-1)),
		);
		const { errors } = resolve(v);
		expect(
			errors.some((e) => /'then' type.*not comparable/.test(e.message)),
		).toBe(true);
	});
});

describe("checkExpression — count + format-date", () => {
	const ctxRel = {
		caseTypes: [
			{
				name: "household",
				properties: [
					{
						name: "region",
						label: proseText("Region"),
						data_type: "text" as const,
					},
				],
			},
			{
				name: "patient",
				parent_type: "household",
				properties: [
					{ name: "age", label: proseText("Age"), data_type: "int" as const },
					{
						name: "case_name",
						label: proseText("Name"),
						data_type: "text" as const,
					},
					{ name: "dob", label: proseText("DOB"), data_type: "date" as const },
				],
			},
		],
		knownInputs: [],
		currentCaseType: "household",
	};

	it("count returns int for a relation walk", () => {
		const v = count(subcasePath("parent", "patient"));
		expect(resolve(v, ctxRel).type).toBe("int");
	});

	it("count walks `where` in the destination scope", () => {
		const v = count(
			subcasePath("parent", "patient"),
			eq(prop("patient", "age"), literal(18)),
		);
		const { type, errors } = resolve(v, ctxRel);
		expect(type).toBe("int");
		expect(errors).toEqual([]);
	});

	it("count surfaces a where-clause violation in destination scope", () => {
		const v = count(
			subcasePath("parent", "patient"),
			eq(prop("patient", "phantom"), literal(0)),
		);
		const { errors } = resolve(v, ctxRel);
		expect(
			errors.some((e) => /Unknown property 'phantom'/.test(e.message)),
		).toBe(true);
	});

	it("count surfaces missing originating scope", () => {
		const v = count(subcasePath("parent", "patient"));
		const { errors } = resolve(v); // ctx has no currentCaseType
		expect(
			errors.some((e) => /originating scope must be set/.test(e.message)),
		).toBe(true);
	});

	it("format-date resolves to text given a date or datetime", () => {
		expect(resolve(formatDate(today(), "iso")).type).toBe("text");
		expect(resolve(formatDate(now(), "long")).type).toBe("text");
	});

	it("format-date rejects a numeric operand", () => {
		const v = formatDate(term(literal(42)), "iso");
		const { errors } = resolve(v);
		expect(
			errors.some((e) => /requires a date or datetime/.test(e.message)),
		).toBe(true);
	});
});

// Root expectations use actual authored search-default slots; intrinsic
// expression errors are also checked so they do not gain a redundant mismatch.

describe("valueVerdict — top-level entry", () => {
	it("returns ok for a well-typed expression with no expectedType", () => {
		const result = valueVerdict(term(prop("patient", "age")), ctx);
		expect(result.ok).toBe(true);
	});

	it("propagates a walker-side error onto the result", () => {
		const result = valueVerdict(term(prop("patient", "phantom")), ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/Unknown property/);
		}
	});

	it("adds a root-path error when expectedType disagrees with the resolved type", () => {
		// `today()` resolves to `date`; expectedType `int` disagrees.
		const result = valueVerdict(today(), ctx, "text");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			const rootErr = result.errors.find((e) => e.path.length === 0);
			expect(rootErr).toBeDefined();
			expect(rootErr?.message).toMatch(/resolves to 'date'.*expected 'text'/);
		}
	});

	it("accepts a date expression for an actual date search default", () => {
		expect(valueVerdict(today(), ctx, "date").ok).toBe(true);
	});

	it("accepts the null-as-universal sentinel against any expectedType", () => {
		// `term(literal(null))` resolves to `_any`; the sentinel widens
		// against every concrete type via `typesCompatible`.
		const result = valueVerdict(term(literal(null)), ctx, "date");
		expect(result.ok).toBe(true);
	});

	it("reports unavailable case data before a search default expectation", () => {
		const result = valueVerdict(term(prop("patient", "phantom")), ctx, "text");
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.errors).toEqual([
				expect.objectContaining({ code: "case-data-unavailable" }),
			]);
	});
});

describe("assignmentVerdict — directional storage compatibility", () => {
	it("distinguishes storage assignment from symmetric comparison compatibility", () => {
		expect(
			assignmentVerdict(term(literal("vip")), ctx, ["multi_select"]).ok,
		).toBe(false);
		expect(assignmentVerdict(term(literal(1.5)), ctx, ["int"]).ok).toBe(false);
		expect(assignmentVerdict(term(literal(1)), ctx, ["decimal"]).ok).toBe(true);
		expect(
			assignmentVerdict(term(prop("patient", "status")), ctx, ["text"]).ok,
		).toBe(true);
		expect(
			assignmentVerdict(term(prop("patient", "tags")), ctx, ["text"]).ok,
		).toBe(false);
	});

	it("checks every reachable branch representation", () => {
		expect(
			assignmentVerdict(
				ifExpr(matchAll(), term(literal(1)), term(literal(1.5))),
				ctx,
				["int"],
			).ok,
		).toBe(false);
		expect(
			assignmentVerdict(
				ifExpr(matchAll(), term(prop("patient", "tags")), term(literal("vip"))),
				ctx,
				["multi_select"],
			).ok,
		).toBe(false);
	});

	it("rejects implicit null clears and primitive booleans", () => {
		for (const expression of [
			term(literal(null)),
			ifExpr(matchAll(), term(literal("yes")), term(literal(null))),
			term(literal(true)),
		]) {
			expect(assignmentVerdict(expression, ctx, ["text"]).ok).toBe(false);
		}
		expect(
			assignmentVerdict(concat(term(literal(true))), ctx, ["text"]).ok,
		).toBe(true);
		expect(
			assignmentVerdict(concat(term(literal(null))), ctx, ["text"]).ok,
		).toBe(true);
	});

	it("does not let scalar wrappers hide multi-select arrays or booleans", () => {
		const wrappedMulti = assignmentVerdict(
			concat(term(prop("patient", "tags"))),
			ctx,
			["text"],
		);
		expect(wrappedMulti.ok).toBe(false);
		if (!wrappedMulti.ok) {
			expect(
				wrappedMulti.errors.map((error) => error.message).join(" "),
			).toContain("multi-select value cannot flow through scalar");
		}
		for (const expression of [
			double(term(literal(true))),
			dateCoerce(term(literal(true))),
			datetimeCoerce(term(literal(true))),
		]) {
			const result = assignmentVerdict(expression, ctx, [
				expression.kind === "double"
					? "decimal"
					: expression.kind === "date-coerce"
						? "date"
						: "datetime",
			]);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.errors.map((error) => error.message).join(" ")).toContain(
					"boolean primitive",
				);
			}
		}

		const nullBeforeConcat = assignmentVerdict(
			concat(double(term(literal(null)))),
			ctx,
			["text"],
		);
		expect(nullBeforeConcat.ok).toBe(false);
		if (!nullBeforeConcat.ok) {
			expect(
				nullBeforeConcat.errors.map((error) => error.message).join(" "),
			).toContain("Null is not a portable assignment value");
		}

		const branchBeforeConcat = assignmentVerdict(
			concat(
				ifExpr(matchAll(), term(literal(true)), term(literal("fallback"))),
			),
			ctx,
			["text"],
		);
		expect(branchBeforeConcat.ok).toBe(false);
		if (!branchBeforeConcat.ok) {
			expect(
				branchBeforeConcat.errors.map((error) => error.message).join(" "),
			).toContain("boolean primitive");
		}

		const emptyDate = assignmentVerdict(
			term({ kind: "literal", value: "", data_type: "date" }),
			ctx,
			["date"],
		);
		expect(emptyDate.ok).toBe(false);
		if (!emptyDate.ok) {
			expect(
				emptyDate.errors.map((error) => error.message).join(" "),
			).toContain("empty typed temporal literal");
		}
	});
});

// ── The form rule set and the slot facts ─────────────────────────────
//
// One follow-up form whose fields cover each operand kind the form rules
// read, a repeat with answers inside it, and a calculated case-list column.
// Each case parses its source in the slot that stores it and checks it there.

const RULES = Object.fromEntries(
	[
		"module",
		"form",
		"consent",
		"n",
		"t",
		"d",
		"dt",
		"probe",
		"timeHidden",
		"intHidden",
		"stamp",
		"rep",
		"q",
		"w",
		"inside",
		"members",
		"column",
		"operation",
	].map((name) => [name, testUuid(`form-rules-${name}`)]),
) as Record<string, ReturnType<typeof testUuid>>;

function rulesDoc(
	columnExpression: Expression = term(literal("x")),
): BlueprintDoc {
	return buildDoc({
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "seen_at", label: "Seen", data_type: "datetime" },
					{ name: "note", label: "Note", data_type: "text" },
				],
			},
		],
		modules: [
			{
				uuid: RULES.module,
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					...caseListConfig([{ field: "case_name", header: "Name" }]),
					columns: [calculatedColumn(RULES.column, "Here", columnExpression)],
					listColumnOrder: [RULES.column],
					detailColumnOrder: [RULES.column],
				},
				forms: [
					{
						uuid: RULES.form,
						name: "Visit",
						type: "followup",
						fields: [
							f({
								uuid: RULES.consent,
								id: "consent",
								kind: "single_select",
								label: "Consent",
								options: [
									{ value: "yes", label: "Yes" },
									{ value: "no", label: "No" },
								],
							}),
							f({ uuid: RULES.n, id: "n", kind: "int", label: "N" }),
							f({ uuid: RULES.t, id: "t", kind: "time", label: "T" }),
							f({ uuid: RULES.d, id: "d", kind: "date", label: "D" }),
							f({ uuid: RULES.dt, id: "dt", kind: "datetime", label: "DT" }),
							f({ uuid: RULES.probe, id: "probe", kind: "hidden" }),
							f({
								uuid: RULES.timeHidden,
								id: "time_hidden",
								kind: "hidden",
								default_value: "#form/t",
							}),
							f({
								uuid: RULES.intHidden,
								id: "int_hidden",
								kind: "hidden",
								default_value: "#form/n",
							}),
							f({
								uuid: RULES.stamp,
								id: "stamp",
								kind: "hidden",
								calculate: "now()",
							}),
							f({
								uuid: RULES.members,
								id: "members",
								kind: "single_select",
								label: "Member",
								optionsSource: {
									kind: "cases",
									caseType: "patient",
									labelProperty: "case_name",
								},
							}),
							f({
								uuid: RULES.rep,
								id: "rep",
								kind: "repeat",
								children: [
									f({ uuid: RULES.q, id: "q", kind: "text", label: "Q" }),
									f({ uuid: RULES.w, id: "w", kind: "int", label: "W" }),
									f({ uuid: RULES.inside, id: "inside", kind: "hidden" }),
								],
							}),
						],
					},
				],
			},
		],
	});
}

function fieldSlot(
	uuid: string,
	slot: "calculate" | "relevant" | "default_value" = "calculate",
): ExpressionSlotRef {
	return { entity: "field", uuid: uuid as never, slot };
}
function slotOutcome(
	doc: BlueprintDoc,
	slot: ExpressionSlotRef,
	expression: Expression,
) {
	const ctx = slotContext(doc, slot, new Map());
	if (ctx === undefined) throw new Error("The rules fixture has no such slot.");
	return checkExpression(expression, ctx);
}
/** Parse form XPath in a slot and check it there. */
function formErrors(source: string, slot = fieldSlot(RULES.probe)) {
	const doc = rulesDoc();
	return slotOutcome(doc, slot, parseFixtureExpression(doc, slot, source))
		.errors;
}
const codes = (errors: readonly { code: string; reason?: string }[]) =>
	errors.map((error) =>
		error.reason === undefined ? error.code : `${error.code}:${error.reason}`,
	);

describe("form comparisons", () => {
	it.each([
		["#form/t < '10:00'", ["time-ordering"]],
		["'09:30' < #form/n", ["time-ordering"]],
		["#form/time_hidden < 5", ["time-ordering"]],
		["#form/n < 'a:b'", ["number-value"]],
		["#form/d = now()", ["incompatible-values:date-datetime"]],
		["#form/dt < '2026-01-01'", ["incompatible-values:date-datetime"]],
		["today() != #form/dt", ["incompatible-values:date-datetime"]],
		// date() on the side that is already a date leaves a date against a
		// date and time; the date and time is the side to wrap.
		["date(#form/dt) < now()", ["incompatible-values:date-datetime"]],
		["date(#form/d) = now()", ["incompatible-values:date-datetime"]],
		["#form/dt < 5", ["incompatible-values:datetime-ordering"]],
		["now() > #form/consent", ["incompatible-values:datetime-ordering"]],
		["#form/consent = true()", ["incompatible-values:boolean"]],
		["false() != #form/d", ["incompatible-values:boolean"]],
	])("refuses %s, one finding per comparison", (source, expected) => {
		expect(codes(formErrors(source))).toEqual(expected);
	});
	it.each([
		"#form/t = #form/t",
		"#form/n < '10'",
		"#form/int_hidden < 5",
		"date(now()) = #form/d",
		"date(#form/dt) < date(now())",
		"#form/dt < now()",
		"#form/d < '2026-01-01'",
		"#form/dt < '2026-01-01T10:00:00'",
		"#form/dt = ''",
		"#form/consent = 'yes'",
		"(#form/n > 1) = true()",
		// A number reads as true when it isn't zero, so 1 and 0 mean true and false.
		"(#form/n > 18) = 1",
		"false() != #form/n",
		"true() + 1",
		"#form/probe < now()",
	])("admits %s", (source) => {
		expect(formErrors(source)).toEqual([]);
	});
	it("refuses a date-and-time literal finer than a millisecond", () => {
		expect(codes(formErrors("#form/dt < '2026-01-01T10:00:00.1234'"))).toEqual([
			"datetime-literal-precision:datetime-literal-precision",
		]);
		expect(formErrors("#form/dt < '2026-01-01T10:00:00.123'")).toEqual([]);
	});
	it("refuses a typed date-and-time literal in a form comparison once, as a literal a form can't spell", () => {
		const doc = rulesDoc();
		const slot = fieldSlot(RULES.probe);
		const parsed = parseFixtureExpression(doc, slot, "#form/dt = '2026'");
		if (parsed.kind !== "eq") throw new Error("The comparison did not parse.");
		const typed: Expression = {
			...parsed,
			right: term(qualifiedLiteral("2026-01-01T10:00:00.1234", "datetime")),
		};
		expect(codes(slotOutcome(doc, slot, typed).errors)).toEqual([
			"arm-unavailable:literal-not-spellable",
		]);
		const ordered: Expression = { ...typed, kind: "lt" } as Expression;
		expect(codes(slotOutcome(doc, slot, ordered).errors)).toEqual([
			"arm-unavailable:literal-not-spellable",
		]);
	});
});

describe("record comparisons", () => {
	it("names a date against a date and time, keeping the refusal", () => {
		expect(
			conditionVerdict(
				eq(term(prop("patient", "dob")), term(prop("patient", "last_seen"))),
				ctx,
			),
		).toEqual({
			ok: false,
			errors: [
				expect.objectContaining({
					code: "incompatible-values",
					reason: "date-datetime",
				}),
			],
		});
		expect(
			conditionVerdict(
				gt(
					term(prop("patient", "last_seen")),
					datetimeCoerce(term(literal("2026-01-01"))),
				),
				ctx,
			).ok,
		).toBe(true);
	});
	it("refuses a microsecond literal beside a millisecond and a minute", () => {
		const at = (value: string) =>
			gt(
				term(prop("patient", "last_seen")),
				term(qualifiedLiteral(value, "datetime")),
			);
		expect(
			conditionVerdict(at("2026-01-01T10:00:00.1234Z"), ctx),
		).toMatchObject({
			ok: false,
			errors: [{ code: "datetime-literal-precision", path: ["right"] }],
		});
		expect(conditionVerdict(at("2026-01-01T10:00:00.123Z"), ctx).ok).toBe(true);
		expect(conditionVerdict(at("2026-01-01T10:00"), ctx).ok).toBe(true);
		expect(
			conditionVerdict(
				gt(
					term(prop("patient", "last_seen")),
					datetimeCoerce(term(literal("2026-01-01T10:00:00.000001Z"))),
				),
				ctx,
			),
		).toMatchObject({
			ok: false,
			errors: [
				{ code: "datetime-literal-precision", path: ["right", "value"] },
			],
		});
	});
});

describe("several values where one is needed", () => {
	const repeatSlot = fieldSlot(RULES.inside);
	it.each([
		"#form/rep/q = 'yes'",
		"concat(#form/rep/q, 'x')",
		"boolean(#form/rep/q)",
		"string(#form/rep/q)",
		"max(#form/rep/w, 1)",
		"join(' ', #form/rep/q, 'x')",
		"checklist(1, -1, #form/rep/q, 'x')",
		"weighted-checklist(0, 5, #form/rep/q, 2)",
		"coalesce(#form/rep/q, 'x')",
		"coalesce('', #form/rep/q)",
		"if(true(), #form/rep/q, '')",
		"#form/rep/q",
		"selected(#form/rep/q, 'a')",
	])("refuses %s outside the repeat", (source) => {
		expect(formErrors(source)).toContainEqual(
			expect.objectContaining({ code: "many-values", reason: "repeat" }),
		);
	});
	it.each([
		"count(#form/rep/q)",
		"join(' ', #form/rep/q)",
		"sum(#form/rep/w)",
		"max(#form/rep/w)",
		"concat(#form/rep/q)",
		"index-of(#form/rep/q, 'x')",
		"depend(#form/n, #form/rep/q)",
		"checklist(1, -1, #form/rep/q)",
		"weighted-checklist(0, 5, #form/rep/q, #form/rep/w)",
		"#form/rep[1]/q = 'yes'",
		"#form/rep[q = 'yes']/q = 'yes'",
		"count(#form/rep[#form/rep/q = 'yes'])",
		"instance('casedb')/casedb/case[@case_type = 'patient']/case_name = 'x'",
	])("admits %s outside the repeat", (source) => {
		expect(formErrors(source)).toEqual([]);
	});
	it.each(["#form/rep/q = 'yes'", "../q = 'yes'", "current()/../q"])(
		"admits %s inside the repeat",
		(source) => {
			expect(formErrors(source, repeatSlot)).toEqual([]);
		},
	);
	it("names the repeat in its finding", () => {
		expect(formErrors("#form/rep/q = 'yes'")).toEqual([
			expect.objectContaining({
				path: ["left"],
				message: expect.stringContaining('the repeat "rep"'),
			}),
		]);
	});
	it("refuses an answer from every entry as a label part outside the repeat", () => {
		const doc = rulesDoc();
		const read: Expression = term({ kind: "field", uuid: RULES.q });
		const outside = slotContext(
			doc,
			{ entity: "field", uuid: RULES.consent, slot: "label" },
			new Map(),
		);
		const inside = slotContext(
			doc,
			{ entity: "field", uuid: RULES.w, slot: "label" },
			new Map(),
		);
		if (outside === undefined || inside === undefined)
			throw new Error("The rules fixture has no label slot.");
		expect(codes(checkExpression(read, outside).errors)).toEqual([
			"many-values:repeat",
		]);
		expect(checkExpression(read, inside).errors).toEqual([]);
	});
	it("reads a repeated case operation's own entry, and every entry without one", () => {
		const base = rulesDoc();
		const operation = (forEach: boolean): BlueprintDoc => ({
			...base,
			forms: {
				...base.forms,
				[RULES.form]: {
					...base.forms[RULES.form],
					caseOperations: [
						{
							uuid: RULES.operation,
							id: "visit",
							action: "update",
							caseType: "patient",
							target: { kind: "session" },
							...(forEach ? { forEach: { repeat: RULES.rep } } : {}),
							writes: [
								{
									property: "note",
									value: term({ kind: "field", uuid: RULES.q }),
								},
							],
						},
					],
				},
			},
		});
		const slot: ExpressionSlotRef = {
			entity: "form",
			uuid: RULES.form,
			slot: "case_operation_write_value",
			member: { operationUuid: RULES.operation, property: "note" },
		};
		const value = term({ kind: "field", uuid: RULES.q });
		expect(slotOutcome(operation(true), slot, value).errors).toEqual([]);
		expect(codes(slotOutcome(operation(false), slot, value).errors)).toEqual([
			"many-values:repeat",
		]);
	});
});

describe("a Hidden Value read", () => {
	it("keeps an untyped Hidden Value's held class with no type opinion", () => {
		const doc = rulesDoc();
		const ctx = slotContext(doc, fieldSlot(RULES.n, "relevant"), new Map());
		if (ctx === undefined) throw new Error("The rules fixture has no slot.");
		expect(typeOf(term({ kind: "field", uuid: RULES.probe }), ctx)).toEqual({
			data: { nodes: "_any", cardinality: "one" },
			held: { nodes: "string" },
		});
		expect(
			typeOf(term({ kind: "field", uuid: RULES.stamp }), ctx),
		).toMatchObject({
			data: { nodes: "datetime" },
			held: { nodes: "date" },
			clockLost: true,
		});
		// depend() returns its first argument as it was held
		// (XPathDependFunc.evalBody), so the lost clock comes through.
		const depend = parseFixtureExpression(
			doc,
			fieldSlot(RULES.n, "relevant"),
			"depend(#form/stamp, #form/n)",
		);
		expect(typeOf(depend, ctx)).toMatchObject({ clockLost: true });
		const fresh = parseFixtureExpression(
			doc,
			fieldSlot(RULES.n, "relevant"),
			"depend(now(), #form/n)",
		);
		expect(typeOf(fresh, ctx)?.clockLost).toBeUndefined();
		// A branch nothing types yet holds no opinion of the result's type.
		const branches = parseFixtureExpression(
			doc,
			fieldSlot(RULES.n, "relevant"),
			"if(#form/n > 1, #form/probe, #form/n)",
		);
		expect(scalarDataType(typeOf(branches, ctx)?.data)).toBe("int");
	});
	it("refuses a lost clock written into a date-and-time property", () => {
		const base = rulesDoc();
		const write = (value: Expression): BlueprintDoc => ({
			...base,
			forms: {
				...base.forms,
				[RULES.form]: {
					...base.forms[RULES.form],
					caseOperations: [
						{
							uuid: RULES.operation,
							id: "visit",
							action: "update",
							caseType: "patient",
							target: { kind: "session" },
							writes: [{ property: "seen_at", value }],
						},
					],
				},
			},
		});
		const slot: ExpressionSlotRef = {
			entity: "form",
			uuid: RULES.form,
			slot: "case_operation_write_value",
			member: { operationUuid: RULES.operation, property: "seen_at" },
		};
		const copy = term({ kind: "field", uuid: RULES.stamp });
		expect(codes(slotOutcome(write(copy), slot, copy).errors)).toEqual([
			"expected-value:clock-lost",
		]);
		expect(slotOutcome(write(now()), slot, now()).errors).toEqual([]);
		// Core's coalesce returns its first non-empty argument as it held it,
		// so a lost clock in any argument reaches the result.
		const shifted = dateAdd(coalesce(copy, now()), "days", term(literal(1)));
		expect(codes(slotOutcome(write(shifted), slot, shifted).errors)).toEqual([
			"expected-value:clock-lost",
		]);
		const kept = dateAdd(coalesce(now(), now()), "days", term(literal(1)));
		expect(slotOutcome(write(kept), slot, kept).errors).toEqual([]);
	});
});

describe("integral functions", () => {
	it.each(["int(#form/n div 2)", "round(1.5)", "string-length('ab')"])(
		"types %s as an integer",
		(source) => {
			const doc = rulesDoc();
			const slot = fieldSlot(RULES.probe);
			const ctx = slotContext(doc, slot, new Map());
			if (ctx === undefined) throw new Error("The rules fixture has no slot.");
			expect(
				scalarDataType(
					typeOf(parseFixtureExpression(doc, slot, source), ctx)?.data,
				),
			).toBe("int");
		},
	);
});

describe("slot facts", () => {
	const columnSlot: ExpressionSlotRef = {
		entity: "module",
		uuid: RULES.module,
		slot: "case_list_column_expression",
		member: { columnUuid: RULES.column },
	};
	it("admits here() in a calculated column only", () => {
		const here: Expression = { kind: "here" };
		const doc = rulesDoc(here);
		const column = slotContext(doc, columnSlot, new Map());
		if (column === undefined) throw new Error("The column slot is missing.");
		expect(checkExpression(here, column)).toEqual({
			type: { data: "geopoint", held: "string" },
			errors: [],
		});
		expect(codes(formErrors("here()"))).toEqual(["arm-unavailable:here"]);
		expect(
			codes(
				slotOutcome(
					doc,
					{
						entity: "module",
						uuid: RULES.module,
						slot: "module_display_condition",
					},
					eq(here, term(literal("x"))),
				).errors,
			),
		).toContain("arm-unavailable:here");
	});
	it("names a choice label read over choices that are not written in the form", () => {
		const read = (field: string): Expression => ({
			kind: "choice-name",
			field: field as never,
			value: term(literal("yes")),
		});
		const doc = rulesDoc();
		expect(
			codes(
				slotOutcome(doc, fieldSlot(RULES.probe), read(RULES.members)).errors,
			),
		).toEqual(["arm-unavailable:choice-name-dynamic"]);
		expect(
			codes(
				slotOutcome(doc, fieldSlot(RULES.probe), read(RULES.consent)).errors,
			),
		).toEqual(["arm-unavailable:choice-name"]);
	});
	it("refuses a date format the case store cannot fix before it reads a row", () => {
		const computed = formatDate(
			today(),
			concat(term(literal("%")), term(literal("Y"))),
		);
		const doc = rulesDoc(computed);
		expect(slotOutcome(doc, columnSlot, computed).errors).toMatchObject([
			{
				code: "format-date-pattern-not-fixed",
				message:
					"This date format needs to be a fixed one of CommCare's formats here, because Nova's case store works it out before the expression runs. You can choose a fixed format.",
			},
		]);
		const unknownToken = formatDate(
			today(),
			term(qualifiedLiteral("%Q", "text")),
		);
		expect(
			slotOutcome(rulesDoc(unknownToken), columnSlot, unknownToken).errors,
		).toMatchObject([
			{
				code: "format-date-pattern-not-fixed",
				message:
					"This date format isn't one of CommCare's formats, and Nova's case store needs one to work it out before the expression runs. You can choose one of CommCare's formats.",
			},
		]);
		const fixed = formatDate(today(), term(qualifiedLiteral("%Y", "text")));
		expect(slotOutcome(rulesDoc(fixed), columnSlot, fixed).errors).toEqual([]);
		expect(formErrors("format-date(today(), concat('%', 'Y'))")).toEqual([]);
	});
	it("splits a multiple choice default on spaces alone", () => {
		const doc = rulesDoc();
		const field = doc.fields[RULES.consent];
		const multi = {
			...doc,
			fields: {
				...doc.fields,
				[RULES.consent]: { ...field, kind: "multi_select" },
			},
		} as BlueprintDoc;
		const slot = fieldSlot(RULES.consent, "default_value");
		expect(
			codes(slotOutcome(multi, slot, term(literal("yes\tno"))).errors),
		).toEqual(["default-not-a-choice"]);
		expect(slotOutcome(multi, slot, term(literal("yes  no"))).errors).toEqual(
			[],
		);
	});
});
