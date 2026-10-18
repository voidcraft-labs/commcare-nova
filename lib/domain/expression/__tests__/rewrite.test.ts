import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { caseTypeSchema } from "@/lib/domain";
import {
	ancestorPath,
	and,
	anyRelationPath,
	count,
	eq,
	ifExpr,
	input,
	isBlank,
	literal,
	match,
	multiSelectAny,
	not,
	prop,
	relationStep,
	selfPath,
	sessionUser,
	subcasePath,
	term,
	within,
} from "../builders";
import {
	type CasePropertyRename,
	mapCasePropertiesInExpression,
	relationDestinationCaseType,
	renameCasePropertyInExpression,
} from "../rewrite";
import type { Expression, RelationPath } from "../types";

const RENAME: CasePropertyRename = {
	caseType: "patient",
	oldName: "age",
	newName: "years",
};

const caseTypes = [
	caseTypeSchema.parse({
		properties: [],
		name: "patient",
		parent_type: "household",
	}),
	caseTypeSchema.parse({
		properties: [],
		name: "household",
		parent_type: "clinic",
	}),
	caseTypeSchema.parse({ properties: [], name: "clinic" }),
];
const rename = (
	expression: Expression,
	change: CasePropertyRename = RENAME,
	catalog = caseTypes,
) => renameCasePropertyInExpression(expression, change, catalog);
const destination = (
	via: RelationPath | undefined,
	origin: string,
	catalog = caseTypes,
) => relationDestinationCaseType(via, origin, catalog);

describe("relationDestinationCaseType", () => {
	it("resolves absent via and selfPath to the originating type", () => {
		expect(destination(undefined, "patient")).toBe("patient");
		expect(destination(selfPath(), "patient")).toBe("patient");
	});

	it("resolves an ancestor walk to the LAST step's type hint", () => {
		expect(
			destination(
				ancestorPath(
					relationStep("parent", "household"),
					relationStep("host", "clinic"),
				),
				"patient",
			),
		).toBe("clinic");
	});

	it("resolves an unqualified parent or singleton child from the catalog", () => {
		expect(destination(ancestorPath(relationStep("parent")), "patient")).toBe(
			"household",
		);
		expect(destination(subcasePath("parent"), "household")).toBe("patient");
	});

	it("resolves subcase and any-relation walks via ofCaseType", () => {
		expect(destination(subcasePath("parent", "patient"), "household")).toBe(
			"patient",
		);
		expect(destination(anyRelationPath("link", "patient"), "household")).toBe(
			"patient",
		);
	});
});

describe("renameCasePropertyInExpression", () => {
	it("renames a direct self-scope PropertyRef and reports the count", () => {
		const predicate = eq(prop("patient", "age"), literal("18"));
		expect(rename(predicate, RENAME)).toBe(1);
		expect(predicate).toEqual(eq(prop("patient", "years"), literal("18")));
	});

	it("leaves non-matching names and non-matching case types alone", () => {
		const wrongName = eq(prop("patient", "weight"), literal("60"));
		const wrongType = eq(prop("household", "age"), literal("18"));
		expect(rename(wrongName, RENAME)).toBe(0);
		expect(rename(wrongType, RENAME)).toBe(0);
		expect(wrongName).toEqual(eq(prop("patient", "weight"), literal("60")));
		expect(wrongType).toEqual(eq(prop("household", "age"), literal("18")));
	});

	it("reaches refs nested under logical operators and counts each", () => {
		const predicate = and(
			eq(prop("patient", "age"), literal("18")),
			not(isBlank(term(prop("patient", "age")))),
		);
		expect(rename(predicate, RENAME)).toBe(2);
		expect(predicate).toEqual(
			and(
				eq(prop("patient", "years"), literal("18")),
				not(isBlank(term(prop("patient", "years")))),
			),
		);
	});

	it("reaches the dedicated PropertyRef slots on within/match/multi-select", () => {
		const geo = within(
			prop("patient", "age"),
			sessionUser("home"),
			5,
			"kilometers",
		);
		const text = match(prop("patient", "age"), input(testUuid("q")), "fuzzy");
		const multi = multiSelectAny(prop("patient", "age"), literal("a"));
		expect(rename(geo, RENAME)).toBe(1);
		expect(rename(text, RENAME)).toBe(1);
		expect(rename(multi, RENAME)).toBe(1);
		expect(geo.property.property).toBe("years");
		expect(text.property.property).toBe("years");
		expect(multi.property.property).toBe("years");
	});

	it("matches a walking ref on its DESTINATION type, not its origin", () => {
		// Origin `household`, destination `patient` — the property lives
		// on the destination, so the patient rename follows it.
		const reaches = eq(
			prop("household", "age", subcasePath("parent", "patient")),
			literal("1"),
		);
		expect(rename(reaches, RENAME)).toBe(1);
		expect(reaches).toEqual(
			eq(
				prop("household", "years", subcasePath("parent", "patient")),
				literal("1"),
			),
		);

		// Origin `patient`, destination `household` — same name, but the
		// property is household's; the patient rename must not touch it.
		const escapes = eq(
			prop("patient", "age", ancestorPath(relationStep("parent", "household"))),
			literal("1"),
		);
		expect(rename(escapes, RENAME)).toBe(0);
	});

	it("skips a custom relation whose destination cannot be resolved", () => {
		const predicate = eq(
			prop("patient", "age", ancestorPath(relationStep("untyped_link"))),
			literal("1"),
		);
		expect(rename(predicate, RENAME)).toBe(0);
	});

	it("never touches input/session/literal terms", () => {
		const predicate = and(
			eq(term(input(testUuid("age"))), literal("age")),
			eq(term(sessionUser("age")), literal("18")),
		);
		expect(rename(predicate, RENAME)).toBe(0);
		expect(predicate).toEqual(
			and(
				eq(term(input(testUuid("age"))), literal("age")),
				eq(term(sessionUser("age")), literal("18")),
			),
		);
	});
});

describe("renameCasePropertyInExpression", () => {
	it("renames refs inside value expressions, including nested predicates", () => {
		const expression = ifExpr(
			eq(prop("patient", "age"), literal("18")),
			term(prop("patient", "age")),
			term(literal("")),
		);
		expect(rename(expression, RENAME)).toBe(2);
		expect(expression).toEqual(
			ifExpr(
				eq(prop("patient", "years"), literal("18")),
				term(prop("patient", "years")),
				term(literal("")),
			),
		);
	});

	it("reaches refs inside a count's where clause", () => {
		const expression = count(
			subcasePath("parent", "patient"),
			eq(prop("patient", "age"), literal("1")),
		);
		expect(rename(expression, RENAME)).toBe(1);
		expect(expression).toEqual(
			count(
				subcasePath("parent", "patient"),
				eq(prop("patient", "years"), literal("1")),
			),
		);
	});
});

describe("simultaneous property mapping", () => {
	it("swaps two property identities in one pass without changing string values", () => {
		const predicate = and(
			eq(prop("patient", "age"), literal("years")),
			eq(prop("patient", "years"), literal("age")),
		);
		expect(
			mapCasePropertiesInExpression(
				predicate,
				(caseType, name) =>
					caseType !== "patient"
						? undefined
						: name === "age"
							? "years"
							: name === "years"
								? "age"
								: undefined,
				caseTypes,
			),
		).toBe(2);
		expect(predicate).toEqual(
			and(
				eq(prop("patient", "years"), literal("years")),
				eq(prop("patient", "age"), literal("age")),
			),
		);
	});
});

describe("catalog-derived rename destinations", () => {
	it("renames a singleton child relation with no authored type hint", () => {
		const expression = eq(
			prop("household", "age", subcasePath("parent")),
			literal(18),
		);
		expect(rename(expression)).toBe(1);
		expect(expression).toEqual(
			eq(prop("household", "years", subcasePath("parent")), literal(18)),
		);
	});
	it("leaves an ambiguous child relation unchanged", () => {
		const catalog = [
			...caseTypes,
			caseTypeSchema.parse({
				properties: [],
				name: "visit",
				parent_type: "household",
			}),
		];
		const expression = eq(
			prop("household", "age", subcasePath("parent")),
			literal(18),
		);
		const before = structuredClone(expression);
		expect(
			destination(subcasePath("parent"), "household", catalog),
		).toBeUndefined();
		expect(rename(expression, RENAME, catalog)).toBe(0);
		expect(expression).toEqual(before);
	});
	it("renames the same identity in form-case reads", () => {
		const expression: Expression = {
			kind: "term",
			term: { kind: "form-case", caseType: "patient", property: "age" },
		};
		expect(rename(expression)).toBe(1);
		expect(expression).toEqual({
			kind: "term",
			term: { kind: "form-case", caseType: "patient", property: "years" },
		});
	});
});
