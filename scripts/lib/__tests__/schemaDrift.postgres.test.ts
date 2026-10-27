import type { Kysely } from "kysely";
import { buildSimpleBlueprint } from "@/lib/case-store/__tests__/fixtures/simpleBlueprint";
import {
	type Database,
	expect,
	test,
} from "@/lib/case-store/sql/__tests__/setup";
import {
	asUuid,
	type CasePropertyDataType,
	type CaseType,
	USERCASE_CASE_TYPE,
	usercaseCaseType,
} from "@/lib/domain";
import { caseTypeToJsonSchema } from "@/lib/domain/expression/jsonSchema";
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

test("compares the worker's own case against the schema storage writes for it", async ({
	db,
}) => {
	// A document that also declares a `commcare-user` entry, typed apart from
	// the worker-property catalog the stored row is built from.
	const declared: CaseType = {
		name: USERCASE_CASE_TYPE,
		properties: [
			{
				name: "learning_mode",
				data_type: "single_select",
				label: proseText("Learning mode"),
				options: [{ value: "on", label: proseText("On") }],
			},
		],
	};
	const propertyUuid = asUuid("0b6f4d55-6c1c-4c86-9a43-4f1d2e8a7b10");
	const blueprint = {
		...buildSimpleBlueprint([declared], APP),
		userProperties: {
			[propertyUuid]: {
				uuid: propertyUuid,
				slug: "learning_mode",
				label: "Learning mode",
			},
		},
	};

	// No row yet: the first sync that touches the worker's case makes it.
	expect(await computeSchemaDrift(db, APP, blueprint)).toEqual([]);

	const storedFor = (ct: CaseType) =>
		db
			.insertInto("case_type_schemas")
			.values({
				app_id: APP,
				case_type: USERCASE_CASE_TYPE,
				schema: JSON.stringify(caseTypeToJsonSchema(ct)),
				synced_seq: 1,
			})
			.execute();
	await storedFor(usercaseCaseType(blueprint));
	expect(await computeSchemaDrift(db, APP, blueprint)).toEqual([]);

	// A worker property the stored row lacks is drift a re-sync converges.
	await db.deleteFrom("case_type_schemas").execute();
	await storedFor(usercaseCaseType({}));
	const drift = await computeSchemaDrift(db, APP, blueprint);
	expect(drift).toEqual([
		expect.objectContaining({
			caseType: USERCASE_CASE_TYPE,
			missingRow: false,
			added: ["learning_mode"],
			removed: [],
			retyped: [],
		}),
	]);
});
