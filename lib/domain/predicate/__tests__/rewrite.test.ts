/**
 * Case-property rename over the Predicate / ValueExpression ASTs.
 *
 * The matcher's contract (see `rewrite.ts` header): a `PropertyRef`
 * is renamed iff its property name matches AND the case type the
 * property structurally lives on — the relation walk's destination,
 * NOT the originating `caseType` qualifier — is the renamed type.
 * Walks without an explicit destination hint are left alone: the AST
 * doesn't encode where they land, so a rewrite can't be proven safe.
 */
import { describe, expect, it } from "vitest";
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
	relationDestinationCaseType,
	renameCasePropertyInExpression,
	renameCasePropertyInPredicate,
} from "../rewrite";

const RENAME: CasePropertyRename = {
	caseType: "patient",
	oldName: "age",
	newName: "years",
};

describe("relationDestinationCaseType", () => {
	it("resolves absent via and selfPath to the originating type", () => {
		expect(relationDestinationCaseType(undefined, "patient")).toBe("patient");
		expect(relationDestinationCaseType(selfPath(), "patient")).toBe("patient");
	});

	it("resolves an ancestor walk to the LAST step's type hint", () => {
		expect(
			relationDestinationCaseType(
				ancestorPath(
					relationStep("parent", "household"),
					relationStep("host", "clinic"),
				),
				"patient",
			),
		).toBe("clinic");
	});

	it("returns undefined when the walk carries no destination hint", () => {
		expect(
			relationDestinationCaseType(
				ancestorPath(relationStep("parent")),
				"patient",
			),
		).toBeUndefined();
		expect(
			relationDestinationCaseType(subcasePath("parent"), "household"),
		).toBeUndefined();
	});

	it("resolves subcase and any-relation walks via ofCaseType", () => {
		expect(
			relationDestinationCaseType(
				subcasePath("parent", "patient"),
				"household",
			),
		).toBe("patient");
		expect(
			relationDestinationCaseType(
				anyRelationPath("link", "patient"),
				"household",
			),
		).toBe("patient");
	});
});

describe("renameCasePropertyInPredicate", () => {
	it("renames a direct self-scope PropertyRef and reports the count", () => {
		const predicate = eq(prop("patient", "age"), literal("18"));
		expect(renameCasePropertyInPredicate(predicate, RENAME)).toBe(1);
		expect(predicate).toEqual(eq(prop("patient", "years"), literal("18")));
	});

	it("leaves non-matching names and non-matching case types alone", () => {
		const wrongName = eq(prop("patient", "weight"), literal("60"));
		const wrongType = eq(prop("household", "age"), literal("18"));
		expect(renameCasePropertyInPredicate(wrongName, RENAME)).toBe(0);
		expect(renameCasePropertyInPredicate(wrongType, RENAME)).toBe(0);
		expect(wrongName).toEqual(eq(prop("patient", "weight"), literal("60")));
		expect(wrongType).toEqual(eq(prop("household", "age"), literal("18")));
	});

	it("reaches refs nested under logical operators and counts each", () => {
		const predicate = and(
			eq(prop("patient", "age"), literal("18")),
			not(isBlank(term(prop("patient", "age")))),
		);
		expect(renameCasePropertyInPredicate(predicate, RENAME)).toBe(2);
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
		const text = match(prop("patient", "age"), input("q"), "fuzzy");
		const multi = multiSelectAny(prop("patient", "age"), literal("a"));
		expect(renameCasePropertyInPredicate(geo, RENAME)).toBe(1);
		expect(renameCasePropertyInPredicate(text, RENAME)).toBe(1);
		expect(renameCasePropertyInPredicate(multi, RENAME)).toBe(1);
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
		expect(renameCasePropertyInPredicate(reaches, RENAME)).toBe(1);
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
		expect(renameCasePropertyInPredicate(escapes, RENAME)).toBe(0);
	});

	it("skips walking refs whose destination is not encoded", () => {
		const predicate = eq(
			prop("patient", "age", ancestorPath(relationStep("parent"))),
			literal("1"),
		);
		expect(renameCasePropertyInPredicate(predicate, RENAME)).toBe(0);
	});

	it("never touches input/session/literal terms", () => {
		const predicate = and(
			eq(term(input("age")), literal("age")),
			eq(term(sessionUser("age")), literal("18")),
		);
		expect(renameCasePropertyInPredicate(predicate, RENAME)).toBe(0);
		expect(predicate).toEqual(
			and(
				eq(term(input("age")), literal("age")),
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
		expect(renameCasePropertyInExpression(expression, RENAME)).toBe(2);
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
		expect(renameCasePropertyInExpression(expression, RENAME)).toBe(1);
		expect(expression).toEqual(
			count(
				subcasePath("parent", "patient"),
				eq(prop("patient", "years"), literal("1")),
			),
		);
	});
});
