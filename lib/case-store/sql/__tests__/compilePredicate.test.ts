// Compiler rejection paths run without a database; SQL semantics run in the harness.
import {
	DummyDriver,
	Kysely,
	PostgresAdapter,
	PostgresIntrospector,
	PostgresQueryCompiler,
} from "kysely";
import { afterAll, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	eq,
	literal,
	match,
	multiSelectAny,
	neq,
	prop,
	sessionUser,
	subcasePath,
	term,
	within,
} from "@/lib/domain/expression/builders";
import { proseText } from "@/lib/domain/prose";
import {
	compilePredicate,
	type PredicateCompileContext,
} from "../compilePredicate";
import type { Database } from "../database";

const db = new Kysely<Database>({
	dialect: {
		createAdapter: () => new PostgresAdapter(),
		createDriver: () => new DummyDriver(),
		createIntrospector: (instance) => new PostgresIntrospector(instance),
		createQueryCompiler: () => new PostgresQueryCompiler(),
	},
});

const APP_ID = "app-uuid";
const OWNER_ID = "owner-uuid";

// `patient` schema — covers the full property surface every
// predicate-arm test needs: text, int, decimal, date, single_select,
// multi_select, geopoint, plus a `parent_type` for ancestor walks.
const PATIENT_SCHEMA: CaseType = {
	name: "patient",
	parent_type: "household",
	properties: [
		{ name: "nickname", label: proseText("Nickname"), data_type: "text" },
		{ name: "age", label: proseText("Age"), data_type: "int" },
		{ name: "bmi", label: proseText("BMI"), data_type: "decimal" },
		{ name: "dob", label: proseText("DOB"), data_type: "date" },
		{ name: "color", label: proseText("Color"), data_type: "single_select" },
		{ name: "tags", label: proseText("Tags"), data_type: "multi_select" },
		{ name: "loc", label: proseText("Location"), data_type: "geopoint" },
	],
};

const HOUSEHOLD_SCHEMA: CaseType = {
	name: "household",
	properties: [
		{ name: "size", label: proseText("Size"), data_type: "int" },
		{ name: "region", label: proseText("Region"), data_type: "text" },
	],
};

const CASE_TYPE_SCHEMAS = new Map<string, CaseType>([
	["patient", PATIENT_SCHEMA],
	["household", HOUSEHOLD_SCHEMA],
]);

function makeCtx(
	overrides: Partial<PredicateCompileContext> = {},
): PredicateCompileContext {
	return {
		reading: "search",
		db,
		appId: APP_ID,
		projectId: OWNER_ID,
		anchorAlias: "c",
		caseTypeSchemas: CASE_TYPE_SCHEMAS,
		bindings: {},
		...overrides,
	};
}

afterAll(async () => {
	await db.destroy();
});
it.each([5, true])("rejects non-string select token %s", (value) => {
	expect(() =>
		compilePredicate(
			multiSelectAny(
				prop("patient", "tags"),
				literal("urgent"),
				literal(value),
			),
			makeCtx(),
		),
	).toThrow(/string-typed token literals/);
});
it.each(["not-a-date", "0000-01-01"])(
	"rejects invalid literal fuzzy date %s",
	(value) => {
		expect(() =>
			compilePredicate(
				match(prop("patient", "dob"), value, "fuzzy-date"),
				makeCtx(),
			),
		).toThrow(/YYYY-MM-DD/);
	},
);

it.each([
	eq(
		prop("household", "region"),
		prop("household", "nickname", subcasePath("parent", "patient")),
	),
	eq(
		prop("household", "nickname", subcasePath("parent", "patient")),
		prop("household", "region"),
	),
	eq(
		prop("household", "nickname", subcasePath("primary", "patient")),
		prop("household", "nickname", subcasePath("secondary", "patient")),
	),
])("rejects mixed property scopes before SQL execution: %j", (predicate) => {
	expect(() =>
		compilePredicate(predicate, makeCtx({ currentCaseType: "household" })),
	).toThrow(expect.objectContaining({ reason: "mixed-property-scopes" }));
});

const valueList = (...values: (string | number | null)[]) => ({
	kind: "value-list" as const,
	items: values.map((value) => term(literal(value))) as [
		ReturnType<typeof term>,
		...ReturnType<typeof term>[],
	],
});
const compiledWhere = (predicate: Parameters<typeof compilePredicate>[0]) =>
	db
		.selectFrom("cases as c")
		.select("c.case_id")
		.where(compilePredicate(predicate, makeCtx()))
		.compile();

it("binds each listed value as its own parameter, and negates the list two-valued", () => {
	const hostile = "x'); SELECT 1; --";
	const list = valueList("a", hostile, null);
	const equal = compiledWhere(eq(prop("patient", "nickname"), list));
	expect(equal.sql).toContain(" in ($1, $2, $3)");
	// A literal null is the blank comparand.
	expect(equal.parameters).toEqual(["a", hostile, ""]);
	const differs = compiledWhere(neq(prop("patient", "nickname"), list));
	expect(differs.sql).toMatch(/not coalesce\(.* in \(\$1, \$2, \$3\), false\)/);
});

it("reads each listed value as the anchor's type and leaves out one that is none", () => {
	// HQ's `terms` finds no stored number equal to 'abc' or '', so neither
	// can match; binding them against a number would fail the query.
	const numbers = compiledWhere(
		eq(prop("patient", "age"), valueList("3", "abc", "", 4.5, null)),
	);
	expect(numbers.parameters).toEqual([3, 4.5]);
	const days = compiledWhere(
		eq(
			prop("patient", "dob"),
			valueList("2026-02-28", "2026-02-30", "not a day", "2026-02-28T10:00"),
		),
	);
	expect(days.parameters).toEqual(["2026-02-28", ""]);
	expect(days.sql).toContain("in (cast(nullif($1, $2) as date))");
});

it("answers false for a list with no value of the anchor's type", () => {
	const none = compiledWhere(eq(prop("patient", "age"), valueList("abc", "")));
	expect(none.sql).toContain("false");
	expect(none.parameters).toEqual([]);
});

it("binds a runtime radius and unit and never inlines them", () => {
	const ctx = makeCtx({
		bindings: {
			sessionUser: new Map([
				["radius", "5'); SELECT 1; --"],
				["unit", "meters'); SELECT 1; --"],
			]),
		},
	});
	const compiled = db
		.selectFrom("cases as c")
		.select("c.case_id")
		.where(
			compilePredicate(
				within(
					prop("patient", "loc"),
					term(literal("1 2")),
					term(sessionUser("radius")),
					term(sessionUser("unit")),
				),
				ctx,
			),
		)
		.compile();
	expect(compiled.parameters).toContain("5'); SELECT 1; --");
	expect(compiled.parameters).toContain("meters'); SELECT 1; --");
	expect(compiled.sql).not.toContain("SELECT 1");
});
