import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	advancedSearchInputDef,
	blueprintDocSchema,
	proseText,
} from "@/lib/domain";
import {
	ancestorPath,
	and,
	anyRelationPath,
	arith,
	between,
	count,
	dateAdd,
	dateCoerce,
	double,
	eq,
	exists,
	gt,
	gte,
	isBlank,
	isIn,
	literal,
	lt,
	lte,
	match,
	matchAll,
	matchNone,
	missing,
	multiSelectAll,
	multiSelectAny,
	neq,
	not,
	or,
	prop,
	relationStep,
	selfPath,
	sessionUserProperty,
	subcasePath,
	term,
} from "@/lib/domain/predicate/builders";
import type { TypeContext } from "@/lib/domain/predicate/typeChecker";
import type { Predicate } from "@/lib/domain/predicate/types";
import {
	csqlArgumentFixture,
	functionLookupContext,
} from "../../__tests__/csqlFunctionFixture";
import { runValidation } from "../../validator/runner";
import { emitCsql } from "../csqlEmitter";

// Private formatting and normalization contracts, with positive predicates
// admitted inside real apps. Native query evaluation/compilation lives in the
// Search, prompt, navigation and CSQL function proof corpora.
function contextFor(predicate: Predicate): TypeContext {
	const doc = structuredClone(csqlArgumentFixture());
	const config = doc.modules[doc.moduleOrder[0]].caseListConfig;
	if (!config || !doc.caseTypes) throw new Error("Fixture has typed Search");
	doc.caseTypes = doc.caseTypes.map((caseType) => ({
		...caseType,
		properties: [
			...caseType.properties,
			...(caseType.name === "patient" || caseType.name === "family"
				? [{ name: "age", label: proseText("Age"), data_type: "int" as const }]
				: []),
			...(caseType.name === "patient"
				? [
						{
							name: "tags",
							label: proseText("Tags"),
							data_type: "multi_select" as const,
						},
					]
				: []),
		],
	}));
	delete config.filter;
	config.searchInputs = [
		advancedSearchInputDef(
			testUuid("predicate-check"),
			"query",
			"Query",
			"text",
			predicate,
		),
	];
	blueprintDocSchema.parse(toPersistableDoc(doc));
	expect(runValidation(doc, functionLookupContext)).toEqual([]);
	return {
		caseTypes: doc.caseTypes,
		currentCaseType: "patient",
		knownInputs: [],
	};
}
const name = prop("patient", "first_name");
const age = prop("patient", "age");
const tags = prop("patient", "tags");

it.each<[Predicate, string]>([
	[eq(name, literal("Ada")), `"first_name = 'Ada'"`],
	[neq(name, literal("Bea")), `"first_name != 'Bea'"`],
	[gt(age, literal(18)), "'age > 18'"],
	[gte(age, literal(18)), "'age >= 18'"],
	[lt(age, literal(65)), "'age < 65'"],
	[lte(age, literal(65)), "'age <= 65'"],
	[eq(name, literal(null)), `"first_name = ''"`],
	[isBlank(name), `"first_name = ''"`],
	[
		isIn(name, literal("Ada Lovelace"), literal("Bea")),
		`"(first_name = 'Ada Lovelace' or first_name = 'Bea')"`,
	],
	[multiSelectAny(tags, literal("doctor")), `"selected(tags, 'doctor')"`],
	[
		multiSelectAny(tags, literal("doctor"), literal("volunteer")),
		`"(selected(tags, 'doctor') or selected(tags, 'volunteer'))"`,
	],
	[
		multiSelectAll(tags, literal("doctor"), literal("volunteer")),
		`"(selected(tags, 'doctor') and selected(tags, 'volunteer'))"`,
	],
	[
		and(
			or(eq(name, literal("Ada")), eq(name, literal("Bea"))),
			gt(age, literal(18)),
		),
		`"(first_name = 'Ada' or first_name = 'Bea') and age > 18"`,
	],
	[not(eq(name, literal("Bea"))), `"not(first_name = 'Bea')"`],
	[matchAll(), "'match-all()'"],
	[matchNone(), "'match-none()'"],
	[
		between(age, { lower: term(literal(18)), upper: term(literal(65)) }),
		"'(age >= 18 and age <= 65)'",
	],
	[
		between(age, {
			lower: term(literal(18)),
			upper: term(literal(65)),
			lowerInclusive: false,
			upperInclusive: false,
		}),
		"'(age > 18 and age < 65)'",
	],
	[between(age, { lower: term(literal(18)) }), "'age >= 18'"],
	[between(age, { upper: term(literal(65)) }), "'age <= 65'"],
	[match(name, "Ada", "fuzzy"), `"fuzzy-match(first_name, 'Ada')"`],
	[match(name, "Ada", "phonetic"), `"phonetic-match(first_name, 'Ada')"`],
	[match(name, "Ad", "starts-with"), `"starts-with(first_name, 'Ad')"`],
	[
		match(
			prop("patient", "visit_date"),
			dateCoerce(term(literal("2024-02-28"))),
			"fuzzy-date",
		),
		`"fuzzy-date(visit_date, (date('2024-02-28')))"`,
	],
	[eq(name, literal("O'Brien")), `concat('first_name = "O', "'", 'Brien"')`],
	[
		eq(
			prop("patient", "visit_date"),
			dateAdd(
				dateCoerce(term(literal("2024-02-28"))),
				"days",
				double(term(literal("2"))),
			),
		),
		`"visit_date = date-add(date('2024-02-28'), 'days', (double('2')))"`,
	],
])(
	"emits the complete constant wrapper for an admitted predicate: %j",
	(predicate, wrapper) => {
		expect(emitCsql(predicate, contextFor(predicate))).toEqual({ wrapper });
	},
);

it.each(["owner_id", "status"] as const)(
	"preserves metadata identity for %s",
	(property) => {
		const predicate = eq(
			prop("patient", property),
			literal(property === "status" ? "open" : "known-id"),
		);
		expect(emitCsql(predicate, contextFor(predicate))).toEqual({
			wrapper: `"@${property} = '${property === "status" ? "open" : "known-id"}'"`,
		});
	},
);

it("keeps comparison direction and every typed ancestor hop", () => {
	const predicate = gt(
		literal(18),
		prop("patient", "age", ancestorPath(relationStep("parent", "family"))),
	);
	expect(emitCsql(predicate, contextFor(predicate))).toEqual({
		wrapper: `"ancestor-exists(parent, (@case_type = 'family' and (age < 18)))"`,
	});
	const chain = exists(
		ancestorPath(
			relationStep("parent", "family"),
			relationStep("parent", "village"),
		),
	);
	expect(emitCsql(chain, contextFor(chain))).toEqual({
		wrapper: `"ancestor-exists(parent, (@case_type = 'family' and (ancestor-exists(parent, (@case_type = 'village' and (match-all()))))))"`,
	});
});

it("narrows a canonical relation to its graph direction and groups a negated filter", () => {
	for (const [target, expected] of [
		["family", "ancestor-exists(parent,"],
		["child", "subcase-exists('parent',"],
	] as const) {
		const predicate = missing(anyRelationPath("parent", target));
		expect(emitCsql(predicate, contextFor(predicate))).toEqual({
			wrapper: `"not(${expected} (@case_type = '${target}' and (match-all()))))"`,
		});
	}
});

it("keeps child-count filters with a zero bound", () => {
	const predicate = eq(
		count(subcasePath("parent", "child"), matchAll()),
		literal(0),
	);
	expect(emitCsql(predicate, contextFor(predicate))).toEqual({
		wrapper: `"subcase-count('parent', (@case_type = 'child' and (match-all()))) = 0"`,
	});
});

it("requires current saved-name bindings for custom worker identities", () => {
	const uuid = testUuid("worker-property");
	const predicate = eq(name, sessionUserProperty(uuid));
	const context = {
		caseTypes: [],
		knownInputs: [],
		userPropertySlugs: new Map([[uuid, "renamed_value"]]),
	};
	const path = "instance('commcaresession')/session/user/data/renamed_value";
	expect(emitCsql(predicate, context).runtimeRejections).toEqual([
		{
			kind: "quote",
			condition: `contains(${path}, "'") and contains(${path}, '"')`,
		},
	]);
	expect(() => emitCsql(predicate, { caseTypes: [], knownInputs: [] })).toThrow(
		`worker-information property '${uuid}' has no current saved-name binding`,
	);
});

it("refuses compiler bypasses that cannot preserve property scope", () => {
	const parentAge = prop("family", "age", ancestorPath(relationStep("parent")));
	for (const predicate of [
		eq(age, parentAge),
		between(age, { lower: term(parentAge) }),
		eq(arith("+", term(age), term(literal(1))), parentAge),
	]) {
		expect(() => emitCsql(predicate)).toThrow(/mixed-property-scopes/);
	}
	expect(() => emitCsql(exists(selfPath()))).toThrow(/self-walk relation/);
	expect(() => emitCsql(eq(name, literal(`both'"`)))).toThrow(
		/no portable escape/,
	);
});
