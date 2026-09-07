// Compiler preconditions and parameter ownership do not need a live database.
// Value semantics, casts and relation reads run in the Postgres sibling suite.
import {
	DummyDriver,
	Kysely,
	PostgresAdapter,
	PostgresIntrospector,
	PostgresQueryCompiler,
} from "kysely";
import { afterAll, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	formField,
	input,
	literal,
	prop,
	sessionContext,
	sessionUser,
} from "@/lib/domain/predicate/builders";
import { proseText } from "@/lib/domain/prose";
import { compileTerm, type TermCompileContext } from "../compileTerm";
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
const ctx: TermCompileContext = {
	db,
	appId: "app",
	projectId: "project",
	anchorAlias: "c",
	bindings: {},
	caseTypeSchemas: new Map([
		[
			"patient",
			{
				name: "patient",
				properties: [{ name: "nickname", label: proseText("Nickname") }],
			},
		],
	]),
};

it.each([
	[
		"missing-type",
		"nickname",
		/no schema registered for case type `missing-type`/,
	],
	[
		"patient",
		"missing-property",
		/property `missing-property` is not declared/,
	],
] as const)("rejects an unresolved %s.%s", (caseType, property, diagnostic) => {
	expect(() => compileTerm(prop(caseType, property), ctx)).toThrow(diagnostic);
});

const key = testUuid("runtime-key");
for (const { name, term, descriptor } of [
	{
		name: "search input",
		term: input(key),
		descriptor: /Missing binding for search input/,
	},
	{
		name: "session user",
		term: sessionUser("region"),
		descriptor: /Missing binding for session user field 'region'/,
	},
	{
		name: "session context",
		term: sessionContext("userid"),
		descriptor: /Missing binding for session context field 'userid'/,
	},
	{
		name: "form field",
		term: formField(key),
		descriptor: /Missing binding for form field/,
	},
]) {
	it(`rejects a missing ${name} value`, () => {
		expect(() => compileTerm(term, ctx)).toThrow(descriptor);
	});
}

it("binds runtime values in their own namespaces and keeps SQL-like text in parameters", () => {
	const hostileText = "O'Brien'); SELECT 'unexpected'; --";
	const bound = {
		...ctx,
		bindings: {
			searchInputs: new Map([[key, hostileText]]),
			formFields: new Map([[key, "form answer"]]),
			sessionUser: new Map([["userid", "worker data"]]),
			sessionContext: new Map([["userid", "authenticated user"]]),
		},
	};
	const compiled = db
		.selectNoFrom([
			compileTerm(input(key), bound).as("search"),
			compileTerm(formField(key), bound).as("form"),
			compileTerm(sessionUser("userid"), bound).as("worker"),
			compileTerm(sessionContext("userid"), bound).as("context"),
			compileTerm(literal(hostileText), bound).as("literal"),
			compileTerm(literal(42), bound).as("number"),
			compileTerm(literal(false), bound).as("boolean"),
		])
		.compile();
	expect(compiled.parameters).toEqual([
		hostileText,
		"form answer",
		"worker data",
		"authenticated user",
		hostileText,
		42,
		false,
	]);
	for (const value of compiled.parameters.filter(
		(value) => typeof value === "string",
	)) {
		expect(compiled.sql).not.toContain(value);
	}
});
