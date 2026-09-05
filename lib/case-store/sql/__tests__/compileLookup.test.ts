import {
	DummyDriver,
	Kysely,
	PostgresAdapter,
	PostgresIntrospector,
	PostgresQueryCompiler,
} from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import {
	eq,
	literal,
	tableColumn,
	tableLookup,
} from "@/lib/domain/predicate/builders";
import { compileExpression } from "../compileExpression";
import {
	compilePredicate,
	expressionContextFor,
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
afterAll(async () => {
	await db.destroy();
});
const REGIONS = lookupTableIdSchema.parse(
	"01920000-0000-7000-8000-00000000000a",
);
const COL_CODE = lookupColumnIdSchema.parse(
	"01920000-0000-7000-8000-0000000000c1",
);
const COL_LABEL = lookupColumnIdSchema.parse(
	"01920000-0000-7000-8000-0000000000c2",
);

const OTHER_TABLE = lookupTableIdSchema.parse(
	"01920000-0000-7000-8000-00000000000b",
);
const OTHER_COL = lookupColumnIdSchema.parse(
	"01920000-0000-7000-8000-0000000000d1",
);

function makeCtx(
	db: Kysely<Database>,
	overrides: Partial<PredicateCompileContext> = {},
): PredicateCompileContext {
	return {
		db,
		appId: "app",
		projectId: "project",
		anchorAlias: "c",
		currentCaseType: "patient",
		caseTypeSchemas: new Map(),
		bindings: {},
		lookupTableSchemas: new Map([
			[
				REGIONS,
				new Map([
					[COL_CODE, "text"],
					[COL_LABEL, "text"],
				]),
			],
			[OTHER_TABLE, new Map([[OTHER_COL, "text"]])],
		]),
		...overrides,
	};
}

describe("compileLookup — invariants", () => {
	it("a table-column term outside any lookup row scope throws", () => {
		expect(() =>
			compilePredicate(
				eq(tableColumn(REGIONS, COL_CODE), literal("east")),
				makeCtx(db),
			),
		).toThrow(/outside any `table-lookup` row scope/);
	});

	it("an other-table column inside a lookup where throws", () => {
		expect(() =>
			compileExpression(
				tableLookup(
					REGIONS,
					COL_LABEL,
					eq(tableColumn(OTHER_TABLE, OTHER_COL), literal("x")),
				),
				expressionContextFor(makeCtx(db)),
			),
		).toThrow(/different table than the enclosing/);
	});

	it("a carrier reaching a site with no lookup definitions in context throws", () => {
		expect(() =>
			compileExpression(
				tableLookup(
					REGIONS,
					COL_LABEL,
					eq(tableColumn(REGIONS, COL_CODE), literal("east")),
				),
				expressionContextFor(makeCtx(db, { lookupTableSchemas: undefined })),
			),
		).toThrow(/no `lookupTableSchemas` in context/);
	});
});
