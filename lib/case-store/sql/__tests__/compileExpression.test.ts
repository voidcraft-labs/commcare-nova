// Preconditions and parameter binding need no database. Value semantics execute
// in compileExpression.harness.postgres.test.ts.
import {
	DummyDriver,
	Kysely,
	PostgresAdapter,
	PostgresIntrospector,
	PostgresQueryCompiler,
} from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	actingUser,
	ancestorPath,
	count,
	dateAdd,
	formatDate,
	idOf,
	ifExpr,
	literal,
	relationStep,
	selfPath,
	term,
	today,
	unowned,
} from "@/lib/domain/predicate/builders";
import {
	compileExpression,
	type ExpressionCompileContext,
} from "../compileExpression";
import type { Database } from "../database";

const db = new Kysely<Database>({
	dialect: {
		createAdapter: () => new PostgresAdapter(),
		createDriver: () => new DummyDriver(),
		createIntrospector: (instance) => new PostgresIntrospector(instance),
		createQueryCompiler: () => new PostgresQueryCompiler(),
	},
});
afterAll(() => db.destroy());
const ctx: ExpressionCompileContext = {
	db,
	appId: "app",
	projectId: "project",
	anchorAlias: "c",
	currentCaseType: "patient",
	caseTypeSchemas: new Map([
		["patient", { name: "patient", parent_type: "household", properties: [] }],
		["household", { name: "household", properties: [] }],
	]),
	bindings: {},
};

describe("compileExpression preconditions", () => {
	it("requires a resolved acting user", () => {
		expect(() => compileExpression(actingUser(), ctx)).toThrow(
			/missing binding for the acting user id/i,
		);
	});
	it("requires the referenced operation's created id", () => {
		expect(() =>
			compileExpression(idOf(testUuid("missing-operation")), ctx),
		).toThrow(/case-operation id/i);
	});
	it.each([
		ifExpr({ kind: "match-all" }, term(literal(1)), term(literal(0))),
		count(selfPath(), { kind: "match-all" }),
		count(ancestorPath(relationStep("parent", "household")), {
			kind: "match-all",
		}),
	])("requires the predicate compiler for %j", (expression) => {
		expect(() => compileExpression(expression, ctx)).toThrow(/predicate/i);
	});
	it("refuses date arithmetic when the base lost its temporal type", () => {
		expect(() =>
			compileExpression(
				dateAdd(term(literal("2026-01-01")), "days", term(literal(1))),
				ctx,
			),
		).toThrow(/without a resolvable date-or-datetime base type/i);
	});
	it.each(["%Q", "Date %"])(
		"rejects an unsupported date pattern: %s",
		(pattern) => {
			expect(() =>
				compileExpression(formatDate(today(), pattern), ctx),
			).toThrow(/format-date pattern/i);
		},
	);
	it("binds operation identities as data in their own namespaces", () => {
		const operation = testUuid("operation");
		const actor = "actor'); SELECT 1; --";
		const createdId = "case'); SELECT 2; --";
		const bound = {
			...ctx,
			bindings: {
				actingUserId: actor,
				operationIds: new Map([[operation, createdId]]),
			},
		};
		const query = db
			.selectNoFrom([
				compileExpression(actingUser(), bound).as("actor"),
				compileExpression(idOf(operation), bound).as("created"),
				compileExpression(unowned(), bound).as("unowned"),
			])
			.compile();
		expect(query.parameters).toEqual([actor, createdId, "-"]);
		expect(query.sql).not.toContain(actor);
		expect(query.sql).not.toContain(createdId);
	});
});
