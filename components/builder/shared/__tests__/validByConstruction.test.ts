import { expressionEditorFixture } from "@/__tests__/helpers/expressionEditorFixture";
// components/builder/shared/__tests__/validByConstruction.test.ts
//
// The headline invariant of the valid-by-construction editor: an
// admitted choice, and any cascade-reseed the editor performs, is
// ALWAYS type-correct. These tests tie the editor's admission helpers
// (`comparisonOperatorsFor` / `matchModesFor` / `compatibleTypesFor`)
// and the reseed (`cards/reseed.ts`) directly to the type checker
// (`checkExpression`), so "the pickers only offer valid choices" is a
// type-check consistency property. Complete document/carrier admission is
// tested separately. No React or DOM renderer.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { caseListConfig } from "@/lib/__tests__/docHelpers";
import { expressionEditVerdict } from "@/lib/doc/hooks/predicateVerdicts";
import { type CaseType, casePropertyDataTypes, type Uuid } from "@/lib/domain";
import {
	chosen,
	chosenCaseDoc,
} from "@/lib/domain/__tests__/chosenCaseFixture";
import {
	ANY_CONSTRAINT,
	type ComparisonKind,
	checkExpression,
	comparisonOperatorsFor,
	compatibleTypesFor,
	type Expression,
	type ExpressionSlotRef,
	eq,
	gt,
	gte,
	input,
	isBlank,
	type Literal,
	literal,
	literalType,
	lt,
	lte,
	MATCH_MODES,
	match,
	matchAll,
	matchModesFor,
	neq,
	prop,
	type ScalarType,
	slotContext,
	type Term,
	term,
} from "@/lib/domain/expression";
import {
	chosenCaseId,
	chosenCaseProperty,
} from "@/lib/domain/expression/chosenCase";
import { proseText } from "@/lib/domain/prose";
import { wrapInConditionChoice } from "../cards/ConditionChoiceCard";
import { ValueListCard } from "../cards/expression/GeneralValueCards";
import {
	reseedLiteralForConstraint,
	reseedValueForConstraint,
} from "../cards/reseed";
import { caseTypeValueGroups } from "../caseTypeValueModel";
import { replaceComparisonSubject } from "../comparisonModel";
import { firstConditionSeed } from "../conditionSeed";
import {
	predicateCardSchemas,
	predicateUnavailableReason,
} from "../editorSchemas";
import {
	expressionCardSchemaList,
	expressionCardSchemas,
	isAuthorableExpressionKind,
} from "../expressionEditorSchemas";
import { defaultExpressionForSlot } from "../primitives/ExpressionPicker";
import {
	caseRowTypeAdmission,
	chosenCaseSources,
	searchOnlyPropertyChoices,
} from "../termEditorModel";
import { workbenchExpressionAdmission } from "../workbenchAdmission";

// A case type carrying one property of every data type, so a subject of
// any type is constructible as `prop("ct", `p_${type}`)`.
const CASE_TYPE: CaseType = {
	name: "ct",
	properties: casePropertyDataTypes.map((dt) => ({
		name: `p_${dt}`,
		label: proseText(dt),
		data_type: dt,
	})),
};
const CTX = expressionEditorFixture("search-predicate", {
	caseTypes: [CASE_TYPE],
	knownInputs: [],
	currentCaseType: "ct",
}).context.expressionContext;
const REAL_TYPES = casePropertyDataTypes;

type ComparisonBuilder = (
	left: Term | Expression,
	right: Term | Expression,
) => Expression;
const COMPARISON_BUILDERS: Record<ComparisonKind, ComparisonBuilder> = {
	eq,
	neq,
	gt,
	gte,
	lt,
	lte,
};

// A range of "old" literal contents a reseed must handle.
const OLD_LITERALS: Literal[] = [
	literal("abc"),
	literal("42"),
	literal(""),
	literal(7),
	literal(3.5),
	literal(null),
];

describe("valid by construction — comparison admission ⟺ checker", () => {
	it("admits a comparison operator iff the constructed comparison type-checks", () => {
		for (const t of REAL_TYPES) {
			const subject = prop("ct", `p_${t}`);
			// A value the subject's object slot accepts, built the way the
			// editor's reseed would.
			const value = reseedValueForConstraint(
				term(literal("")),
				compatibleTypesFor(t),
			);
			for (const kind of Object.keys(COMPARISON_BUILDERS) as ComparisonKind[]) {
				const admitted = comparisonOperatorsFor(t).has(kind);
				const predicate = COMPARISON_BUILDERS[kind](subject, value);
				const checks = checkExpression(predicate, CTX).errors.length === 0;
				// Sound AND complete: the helper admits exactly the operators
				// the checker accepts for a subject of this type.
				expect(
					checks,
					`${kind} on ${t}: admitted=${admitted} checks=${checks}`,
				).toBe(admitted);
			}
		}
	});
});

describe("valid by construction — reseed always lands inside the constraint", () => {
	it("a reseeded comparison value always type-checks against its subject", () => {
		for (const t of REAL_TYPES) {
			const accepts = compatibleTypesFor(t);
			const subject = prop("ct", `p_${t}`);
			for (const old of OLD_LITERALS) {
				const reseeded = reseedValueForConstraint(term(old), accepts);
				// eq is admitted for every type, so this isolates the value:
				// the reseeded object must be compatible with the subject.
				expect(
					checkExpression(eq(subject, reseeded), CTX).errors.length === 0,
					`reseed of ${JSON.stringify(old.value)} for ${t}`,
				).toBe(true);
			}
		}
	});

	it("a reseeded literal's type is always admitted by the accept-set", () => {
		// Every subject type's compatible-set, plus a geopoint-only set
		// (no literal widget) to exercise the null fallback.
		const acceptSets = [
			...REAL_TYPES.map((t) => compatibleTypesFor(t)),
			new Set<ScalarType>(["geopoint"]),
		];
		for (const accepts of acceptSets) {
			for (const old of OLD_LITERALS) {
				const seeded = reseedLiteralForConstraint(old, accepts);
				// The result is admissible: its type is in the accept-set, or
				// it's the universally-compatible null literal.
				const ok = accepts.has(literalType(seeded)) || seeded.value === null;
				expect(
					ok,
					`${JSON.stringify(old.value)} → ${JSON.stringify(seeded)}`,
				).toBe(true);
			}
		}
	});
});

describe("valid by construction — match admission ⟺ checker", () => {
	it("admits a match mode iff the constructed match type-checks", () => {
		for (const t of REAL_TYPES) {
			const subject = prop("ct", `p_${t}`);
			for (const mode of MATCH_MODES) {
				const admitted = matchModesFor(t).has(mode);
				// A non-empty term value: the shape the editor's
				// `matchValueConstraint` enforces. Builder order is
				// `match(property, value, mode)`.
				const predicate = match(subject, term(literal("x")), mode);
				const checks = checkExpression(predicate, CTX).errors.length === 0;
				expect(
					checks,
					`${mode} on ${t}: admitted=${admitted} checks=${checks}`,
				).toBe(admitted);
			}
		}
	});
});

// ── Pull request 10: the CSQL offers ────────────────────────────────────
//
// Each new offer is the exact expression its card or menu commits, judged by
// `expressionEditVerdict` over real slot contexts, so "offered" and
// "admitted by the gate" are one set.

const CHOSEN_SLOTS: readonly ExpressionSlotRef[] = [
	chosen.villages,
	chosen.households,
	chosen.members,
].flatMap((module) => [
	{ entity: "module", uuid: module, slot: "case_list_filter" } as const,
	{ entity: "module", uuid: module, slot: "module_display_condition" } as const,
]);

describe("valid by construction — the case chosen in an earlier menu", () => {
	it("offers a menu's chosen case exactly where the profile and the entry's supplies admit it", () => {
		for (const several of [false, true]) {
			const doc = chosenCaseDoc();
			if (several)
				doc.modules[chosen.villages].caseListConfig = {
					...caseListConfig([]),
					selection: { kind: "multiple", maximum: 3 },
				};
			for (const slot of CHOSEN_SLOTS) {
				const context = slotContext(doc, slot, new Map());
				if (context === undefined) throw new Error("Missing fixture slot.");
				const offered = new Set(
					chosenCaseSources(context).map((source) => source.module),
				);
				for (const module of Object.keys(doc.modules) as Uuid[]) {
					const caseType = doc.modules[module]?.caseType ?? "";
					// The subject is the list's own case; the value is the chosen one.
					const subject = term(
						prop(doc.modules[slot.uuid]?.caseType ?? "", "case_name"),
					);
					const reads = [
						eq(subject, chosenCaseId(module)),
						eq(subject, chosenCaseProperty(module, caseType, "case_name")),
					];
					for (const read of reads)
						expect(
							expressionEditVerdict(read, context).ok,
							`${slot.slot} of ${doc.modules[slot.uuid]?.name} reading ${doc.modules[module]?.name} (several=${several})`,
						).toBe(offered.has(module));
				}
			}
		}
	});
});

const CHOICE_VOCABULARY = {
	caseTypes: [CASE_TYPE],
	knownInputs: [],
	currentCaseType: "ct",
};
const CHOICE_CARRIERS = [
	"search-predicate",
	"search-case-filter",
	"case-filter",
	"selected-case-condition",
	"global-condition",
] as const;

describe("valid by construction — Depends on a condition", () => {
	it("is applicable exactly where the gate admits the choice it adds or wraps", () => {
		for (const carrier of CHOICE_CARRIERS) {
			const editCtx = expressionEditorFixture(
				carrier,
				CHOICE_VOCABULARY,
			).context;
			const schema = predicateCardSchemas.if;
			const applicable = schema.applicable(editCtx);
			const seed = schema.defaultValue(editCtx);
			expect(seed.kind).toBe("if");
			expect(
				expressionEditVerdict(seed, editCtx.expressionContext).ok,
				`${carrier}: fresh choice`,
			).toBe(applicable);
			const current = firstConditionSeed(editCtx) ?? matchAll();
			expect(
				expressionEditVerdict(
					wrapInConditionChoice(current, editCtx),
					editCtx.expressionContext,
				).ok,
				`${carrier}: wrapped choice`,
			).toBe(applicable);
			if (!applicable)
				expect(predicateUnavailableReason("if", editCtx)).toBeTruthy();
		}
		// The CSQL slots and the case list filter admit it.
		expect(
			predicateCardSchemas.if.applicable(
				expressionEditorFixture("search-predicate", CHOICE_VOCABULARY).context,
			),
		).toBe(true);
	});

	it("decides by another search field where there is one, and otherwise always matches", () => {
		const current = eq(term(prop("ct", "p_text")), term(literal("a")));
		const answer = testUuid("choice-answer");
		const search = expressionEditorFixture("search-predicate", {
			...CHOICE_VOCABULARY,
			knownInputs: [{ uuid: answer, name: "area", data_type: "text" }],
		}).context;
		// The fixture's own field (whose condition this is) is never the seed.
		expect(wrapInConditionChoice(current, search).cond).toEqual(
			isBlank(term(input(answer))),
		);
		const plain = expressionEditorFixture(
			"case-filter",
			CHOICE_VOCABULARY,
		).context;
		expect(wrapInConditionChoice(current, plain).cond).toEqual(matchAll());
	});

	it("keeps the wrapped condition as both branches", () => {
		const current = eq(term(prop("ct", "p_text")), term(literal("a")));
		const wrapped = wrapInConditionChoice(
			current,
			expressionEditorFixture("case-filter", CHOICE_VOCABULARY).context,
		);
		expect(wrapped.then).toBe(current);
		expect(wrapped.else).toBe(current);
	});
});

describe("valid by construction — Case type", () => {
	it("commits only comparisons the gate admits, in every case-row slot", () => {
		for (const carrier of [
			"search-predicate",
			"search-case-filter",
			"case-filter",
		] as const) {
			const editCtx = expressionEditorFixture(
				carrier,
				CHOICE_VOCABULARY,
			).context;
			const context = editCtx.expressionContext;
			for (const kind of ["eq", "neq", "gt"] as const) {
				const current =
					kind === "gt"
						? gt(term(prop("ct", "p_int")), term(literal(1)))
						: COMPARISON_BUILDERS[kind](
								term(prop("ct", "p_text")),
								term(literal("")),
							);
				const next = replaceComparisonSubject(
					current as Parameters<typeof replaceComparisonSubject>[0],
					term({ kind: "case-row-type" }),
					editCtx,
				);
				const admission = caseRowTypeAdmission(
					{
						admitExpressionChange: (path, candidate) =>
							workbenchExpressionAdmission(current, path, candidate, context),
					},
					ANY_CONSTRAINT,
					["left"],
					() => {
						const verdict = expressionEditVerdict(next, context);
						return verdict.ok
							? { admitted: true }
							: { admitted: false, reason: verdict.reason };
					},
				);
				// Equality is offered and its committed rule is admitted; an
				// ordering is refused (case types can't be ordered).
				expect(admission.admitted, `${carrier} ${kind}`).toBe(kind !== "gt");
				if (kind !== "gt") {
					expect(next).toMatchObject({
						right: {
							kind: "term",
							term: { kind: "case-type", caseType: "ct" },
						},
					});
					expect(expressionEditVerdict(next, context).ok).toBe(true);
				}
			}
			// Every case type the value picker lists is admitted.
			for (const name of caseTypeValueGroups(
				context.facts.caseTypes.map((type) => type.name),
				["ct"],
			).likely)
				expect(
					expressionEditVerdict(
						eq(
							term({ kind: "case-row-type" }),
							term({ kind: "case-type", caseType: name }),
						),
						context,
					).ok,
				).toBe(true);
		}
	});
});

describe("valid by construction — Date closed", () => {
	it("is offered exactly where the gate admits reading it", () => {
		for (const carrier of [
			"search-predicate",
			"search-case-filter",
			"case-filter",
		] as const) {
			const context = expressionEditorFixture(carrier, CHOICE_VOCABULARY)
				.context.expressionContext;
			const offered = searchOnlyPropertyChoices(context).some(
				(choice) => choice.property.name === "closed_on",
			);
			const read = gt(
				term(prop("ct", "closed_on")),
				term({
					kind: "literal",
					value: "2026-01-01T00:00:00Z",
					data_type: "datetime",
				}),
			);
			expect(expressionEditVerdict(read, context).ok, carrier).toBe(offered);
		}
	});
});

describe("valid by construction — Negative of, Where you are now, a held list", () => {
	const VALUE_CARRIERS = [
		"calculated-column",
		"case-filter",
		"search-predicate",
		"global-value",
		"operation-write",
		"operation-condition",
	] as const;

	it("offers each kind exactly where the slot admits its seed", () => {
		for (const carrier of VALUE_CARRIERS) {
			const ctx = expressionEditorFixture(carrier, CHOICE_VOCABULARY).context;
			const context = ctx.expressionContext;
			// A held `value-list` renders and is offered by no menu.
			expect(isAuthorableExpressionKind("value-list", ctx), carrier).toBe(
				false,
			);
			// "Where you are now" has a handler only in a calculated column.
			expect(isAuthorableExpressionKind("here", ctx), carrier).toBe(
				context.profile.here,
			);
			// "Negative of" stands beside Math wherever a number may go.
			expect(isAuthorableExpressionKind("negate", ctx), carrier).toBe(
				isAuthorableExpressionKind("arith", ctx),
			);
			for (const kind of ["here", "negate"] as const) {
				if (!isAuthorableExpressionKind(kind, ctx)) continue;
				const schema = expressionCardSchemaList.find(
					(entry) => entry.kind === kind,
				);
				if (schema === undefined) throw new Error(`${kind} has no card`);
				const seed = defaultExpressionForSlot(
					schema,
					ctx,
					ANY_CONSTRAINT,
					"value",
				);
				expect(seed.kind).toBe(kind);
				// A value slot takes the seed itself; a condition compares it.
				const candidate =
					context.profile.expectation.kind === "condition"
						? eq(seed, kind === "negate" ? term(literal(1)) : seed)
						: seed;
				const verdict = expressionEditVerdict(candidate, context);
				// The menu offers it and the verdict decides whether it is
				// enabled; where the slot runs on CommCare's server search, a
				// location is refused there with its reason.
				if (kind === "here")
					expect(verdict.ok, `${carrier}: ${kind}`).toBe(true);
			}
		}
	});

	it("gives every stored kind a card, the held list's display-only", () => {
		expect(expressionCardSchemas["value-list"].component).toBe(ValueListCard);
		expect(expressionCardSchemas.negate.label).toBe("Negative of");
		expect(expressionCardSchemas.here.label).toBe("Where you are now");
	});
});
