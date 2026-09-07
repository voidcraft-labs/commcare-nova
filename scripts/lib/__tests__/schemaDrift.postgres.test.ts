import type { Kysely } from "kysely";
import { buildSimpleBlueprint } from "@/lib/case-store/__tests__/fixtures/simpleBlueprint";
import {
	type Database,
	expect,
	test,
} from "@/lib/case-store/sql/__tests__/setup";
import type { CasePropertyDataType, CaseType } from "@/lib/domain";
import { caseTypeToJsonSchema } from "@/lib/domain/predicate/jsonSchema";
import { proseText } from "@/lib/domain/prose";
import { computeSchemaDrift } from "../schemaDrift";

const APP = "app-test";
function caseType(properties: Record<string, CasePropertyDataType>): CaseType {
	return {
		name: "patient",
		properties: Object.entries(properties).map(([name, data_type]) => ({
			name,
			data_type,
			label: proseText(name),
		})),
	};
}

async function seed(
	db: Kysely<Database>,
	properties: Record<string, unknown>,
	appId = APP,
) {
	await db
		.insertInto("case_type_schemas")
		.values({
			app_id: appId,
			case_type: "patient",
			schema: JSON.stringify({
				type: "object",
				additionalProperties: false,
				properties,
			}),
			synced_seq: 1,
		})
		.execute();
}

test("reports stored changes using their actual select identity and leaves rows untouched", async ({
	db,
}) => {
	const prior = caseType({
		choice: "single_select",
		retired: "text",
		unchanged: "int",
	});
	await seed(db, caseTypeToJsonSchema(prior).properties);
	await seed(db, { alien: { type: "boolean" } }, "app-expression-compiler");
	const before = await db.selectFrom("case_type_schemas").selectAll().execute();
	const desired = caseType({ choice: "int", added: "date", unchanged: "int" });
	const drift = await computeSchemaDrift(
		db,
		APP,
		buildSimpleBlueprint([desired], APP),
	);
	expect(drift).toEqual([
		{
			caseType: "patient",
			missingRow: false,
			added: ["added"],
			removed: ["retired"],
			refined: [],
			unresolvable: [],
			retyped: [
				{
					property: "choice",
					fromType: "single_select",
					toType: "int",
					fromSpec: '{"type":"string","x-novaDataType":"single_select"}',
					toSpec:
						'{"maximum":2147483647,"minimum":-2147483648,"type":"integer"}',
				},
			],
		},
	]);
	expect(
		await db.selectFrom("case_type_schemas").selectAll().execute(),
	).toEqual(before);
});

test("recognizes JSONB key reordering as in sync across every current property shape", async ({
	db,
}) => {
	const current = caseType({
		text: "text",
		integer: "int",
		decimal: "decimal",
		date: "date",
		time: "time",
		datetime: "datetime",
		location: "geopoint",
		one: "single_select",
		many: "multi_select",
	});
	await seed(db, caseTypeToJsonSchema(current).properties);
	expect(
		await computeSchemaDrift(db, APP, buildSimpleBlueprint([current], APP)),
	).toEqual([]);
	// Compare a changed destination too: the in-sync shortcut alone never
	// exercises the stored-type decoder used in the operator's migration report.
	const changed = caseType(
		Object.fromEntries(
			current.properties.map((property) => [
				property.name,
				property.data_type === "int" ? "text" : "int",
			]),
		),
	);
	const drifts = await computeSchemaDrift(
		db,
		APP,
		buildSimpleBlueprint([changed], APP),
	);
	expect(drifts).toHaveLength(1);
	expect(
		drifts[0]?.retyped.map(({ property, fromType, toType }) => ({
			property,
			fromType,
			toType,
		})),
	).toEqual([
		{ property: "text", fromType: "text", toType: "int" },
		{ property: "integer", fromType: "int", toType: "text" },
		{ property: "decimal", fromType: "decimal", toType: "int" },
		{ property: "date", fromType: "date", toType: "int" },
		{ property: "time", fromType: "time", toType: "int" },
		{ property: "datetime", fromType: "datetime", toType: "int" },
		{ property: "location", fromType: "geopoint", toType: "int" },
		{ property: "one", fromType: "single_select", toType: "int" },
		{ property: "many", fromType: "multi_select", toType: "int" },
	]);
});

test("distinguishes legacy refinements from unknown stored formats in the read-only report", async ({
	db,
}) => {
	await seed(db, {
		one: { type: "string", enum: ["open", "closed"] },
		many: { type: "array", items: { type: "string", enum: ["a", "b"] } },
		foreign: { type: "string", format: "email" },
	});
	const current = caseType({
		one: "single_select",
		many: "multi_select",
		foreign: "text",
	});
	const drift = await computeSchemaDrift(
		db,
		APP,
		buildSimpleBlueprint([current], APP),
	);
	expect(drift).toEqual([
		{
			caseType: "patient",
			missingRow: false,
			added: [],
			removed: [],
			retyped: [],
			refined: [
				{
					property: "one",
					fromSpec: '{"enum":["open","closed"],"type":"string"}',
					toSpec: '{"type":"string","x-novaDataType":"single_select"}',
				},
				{
					property: "many",
					fromSpec:
						'{"items":{"enum":["a","b"],"type":"string"},"type":"array"}',
					toSpec: '{"items":{"type":"string"},"type":"array"}',
				},
			],
			unresolvable: [
				{
					property: "foreign",
					storedSpec: '{"format":"email","type":"string"}',
				},
			],
		},
	]);
});

test("reports added and removed property names that also exist on Object.prototype", async ({
	db,
}) => {
	await seed(db, { constructor: { type: "string" } });
	const desired = caseType({ toString: "text" as const });
	expect(
		await computeSchemaDrift(db, APP, buildSimpleBlueprint([desired], APP)),
	).toEqual([
		{
			caseType: "patient",
			missingRow: false,
			added: ["toString"],
			removed: ["constructor"],
			refined: [],
			retyped: [],
			unresolvable: [],
		},
	]);
});
