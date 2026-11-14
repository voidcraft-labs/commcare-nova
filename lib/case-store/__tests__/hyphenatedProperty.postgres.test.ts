/**
 * A case write may save a hyphenated property, `state` and `category`, and a
 * choice value may hold an apostrophe. Through the store's submission path a
 * real Postgres stores each as written, and a case list filtered on each
 * returns the row, so neither the JSONB key nor the compiled predicate turns
 * on how the name or the value is spelled.
 */
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { CaseType } from "@/lib/domain";
import { eq, formField, literal, prop, term } from "@/lib/domain/expression";
import { SEARCH_READING } from "@/lib/domain/expression/temporalType";
import { proseText } from "@/lib/domain/prose";
import { PostgresCaseStore } from "../postgres/store";
import { HeuristicCaseGenerator } from "../sample/heuristic";
import { setupPerTestDatabase } from "../sql/__tests__/perTestDatabase";
import type { Database } from "../sql/database";
import { buildCaseTypeMap } from "../store";
import type { CaseOperationProgram } from "../submission";
import { buildSimpleBlueprint } from "./fixtures/simpleBlueprint";

const APP_ID = "hyphenated-property-app";
const PROJECT_ID = "hyphenated-property-project";
const ACTOR = "worker-1";
const FORM_UUID = testUuid("hyphenated-property-form");
const OP_UUID = testUuid("hyphenated-property-create");
const NAME_FIELD = testUuid("hyphenated-property-name");
const KIND_FIELD = testUuid("hyphenated-property-kind");
const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "first-name", label: proseText("First name"), data_type: "text" },
		{ name: "state", label: proseText("State"), data_type: "text" },
		{
			name: "category",
			label: proseText("Category"),
			data_type: "single_select",
		},
	],
};
const SCHEMAS = buildCaseTypeMap(buildSimpleBlueprint([PATIENT], APP_ID));

const fixture = setupPerTestDatabase({
	schema: "migrated",
	poolMax: 3,
	databaseNamePrefix: "hyphenated_property_",
	prepareTemplate: async (db) => {
		await sql`
			INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
			VALUES (${APP_ID}, ${ACTOR}, ${PROJECT_ID}, 'Patients', 'patients')
		`.execute(db);
		await makeStore(db as Kysely<Database>).applySchemaChange({
			appId: APP_ID,
			caseType: PATIENT.name,
			caseTypeSchemas: SCHEMAS,
		});
	},
});

function makeStore(db: Kysely<Database> = fixture.db as Kysely<Database>) {
	return new PostgresCaseStore({
		projectId: PROJECT_ID,
		actorUserId: ACTOR,
		ownerId: ACTOR,
		db,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

const program: CaseOperationProgram = {
	formUuid: FORM_UUID,
	caseTypeSchemas: SCHEMAS,
	formFieldTypes: new Map([
		[NAME_FIELD, "text"],
		[KIND_FIELD, "single_select"],
	]),
	scopes: [
		{
			iterations: [
				{
					formFields: new Map([
						[NAME_FIELD, "Ana"],
						[KIND_FIELD, "it's"],
					]),
				},
			],
		},
	],
	operations: [
		{
			guardConditions: [],
			expressionSnapshotTypes: { links: new Map() },
			operation: {
				uuid: OP_UUID,
				id: "create_patient",
				action: "create",
				caseType: PATIENT.name,
				target: { kind: "new" },
				name: term(formField(NAME_FIELD)),
				writes: [
					{ property: "first-name", value: term(formField(NAME_FIELD)) },
					{ property: "state", value: term(literal("Oyo")) },
					{ property: "category", value: term(formField(KIND_FIELD)) },
				],
			},
		},
	],
};

describe("hyphenated and once-forbidden properties in the case store", () => {
	it("stores each as written and finds the row by each", async () => {
		const store = makeStore();
		await store.applySubmission({
			appId: APP_ID,
			ordinary: { kind: "none" },
			operations: program,
			submissionReceipt: {
				entryKey: "hyphenated-property-entry",
				formUuid: FORM_UUID,
				expectedAppMutationSeq: 0,
				blueprintDigest: "0".repeat(64),
				requestDigest: "hyphenated-property-request",
			},
		});
		const all = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: PATIENT.name,
		});
		expect(all.map((row) => row.properties)).toEqual([
			{ "first-name": "Ana", state: "Oyo", category: "it's" },
		]);
		for (const [property, value] of [
			["first-name", "Ana"],
			["state", "Oyo"],
			["category", "it's"],
		] as const) {
			const found = await store.query({
				reading: SEARCH_READING,
				appId: APP_ID,
				caseType: PATIENT.name,
				caseTypeSchemas: SCHEMAS,
				predicate: eq(prop(PATIENT.name, property), literal(value)),
			});
			expect(
				found.map((row) => row.case_id),
				property,
			).toEqual(all.map((row) => row.case_id));
			const missed = await store.query({
				reading: SEARCH_READING,
				appId: APP_ID,
				caseType: PATIENT.name,
				caseTypeSchemas: SCHEMAS,
				predicate: eq(prop(PATIENT.name, property), literal(`${value}x`)),
			});
			expect(missed, property).toEqual([]);
		}
	});
});
