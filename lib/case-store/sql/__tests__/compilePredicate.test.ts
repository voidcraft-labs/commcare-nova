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
	prop,
	subcasePath,
} from "@/lib/domain/predicate/builders";
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
	).toThrow(/mixed-property-scopes/);
});
