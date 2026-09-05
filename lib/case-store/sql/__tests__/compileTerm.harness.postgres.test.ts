// Execute term values, SQL types, scalar metadata, and correlated reads.
import { testUuid } from "@/__tests__/helpers/uuid";
import type { CaseType } from "@/lib/domain";
import {
	ancestorPath,
	dateLiteral,
	datetimeLiteral,
	formField,
	prop,
	relationStep,
	selfPath,
	sessionUser,
	timeLiteral,
} from "@/lib/domain/predicate/builders";
import { proseText } from "@/lib/domain/prose";
import { compileTerm, type TermCompileContext } from "../compileTerm";
import { expect, makeCaseRow, test } from "./setup";

const APP_ID = "app-term-compiler";
const PROJECT_ID = "owner-term-compiler";

const PATIENT_CASE_ID = "10000000-0000-0000-0000-000000000001";
const HOUSEHOLD_CASE_ID = "10000000-0000-0000-0000-000000000002";

const PATIENT_SCHEMA: CaseType = {
	name: "patient",
	parent_type: "household",
	properties: [
		{ name: "untyped", label: proseText("Untyped") },
		{ name: "nickname", label: proseText("Nickname"), data_type: "text" },
		{ name: "age", label: proseText("Age"), data_type: "int" },
		{ name: "bmi", label: proseText("BMI"), data_type: "decimal" },
		{ name: "dob", label: proseText("DOB"), data_type: "date" },
		{
			name: "appointment_at",
			label: proseText("Appointment"),
			data_type: "time",
		},
		{ name: "registered_at", label: proseText("When"), data_type: "datetime" },
		{ name: "color", label: proseText("Color"), data_type: "single_select" },
		{ name: "tags", label: proseText("Tags"), data_type: "multi_select" },
		{ name: "home_location", label: proseText("Home"), data_type: "geopoint" },
	],
};

const HOUSEHOLD_SCHEMA: CaseType = {
	name: "household",
	properties: [{ name: "size", label: proseText("Size"), data_type: "int" }],
};

const SCHEMAS = new Map<string, CaseType>([
	["patient", PATIENT_SCHEMA],
	["household", HOUSEHOLD_SCHEMA],
]);

function makeCtx(
	db: TermCompileContext["db"],
	overrides: Partial<TermCompileContext> = {},
): TermCompileContext {
	return {
		db,
		appId: APP_ID,
		projectId: PROJECT_ID,
		anchorAlias: "c",
		caseTypeSchemas: SCHEMAS,
		bindings: {},
		...overrides,
	};
}

const properties = {
	nickname: "Alice",
	age: 30,
	bmi: 22.5,
	dob: "2000-06-15",
	appointment_at: "09:00:00",
	registered_at: "2026-01-01T17:30:00+05:30",
	color: "red",
	tags: ["urgent", "review"],
	home_location: "42.3739063 -71.1109113 0.0 886.0",
	untyped: "default text",
};

test("reads every property with its actual SQL type and value", async ({
	db,
	pgClient,
}) => {
	await pgClient.query("SET LOCAL TIME ZONE 'UTC'");
	await db
		.insertInto("cases")
		.values(
			makeCaseRow({
				case_id: PATIENT_CASE_ID,
				app_id: APP_ID,
				project_id: PROJECT_ID,
				properties: JSON.stringify(properties),
			}),
		)
		.execute();
	const rows = await db
		.selectFrom("cases as c")
		.select((eb) =>
			Object.keys(properties).flatMap((name) => {
				const expression = compileTerm(prop("patient", name), makeCtx(db));
				return [
					eb.fn("to_jsonb", [expression]).as(name),
					eb.cast(eb.fn("pg_typeof", [expression]), "text").as(`${name}_type`),
				];
			}),
		)
		.where("c.case_id", "=", PATIENT_CASE_ID)
		.execute();
	expect(rows).toEqual([
		{
			...properties,
			registered_at: "2026-01-01T12:00:00+00:00",
			nickname_type: "text",
			age_type: "integer",
			bmi_type: "numeric",
			dob_type: "date",
			appointment_at_type: "time without time zone",
			registered_at_type: "timestamp with time zone",
			color_type: "text",
			tags_type: "jsonb",
			home_location_type: "text",
			untyped_type: "text",
		},
	]);
});

for (const { name, term } of [
	{ name: "date", term: dateLiteral },
	{ name: "time", term: timeLiteral },
	{ name: "datetime", term: datetimeLiteral },
]) {
	test(`unset ${name} is null while malformed nonempty text is rejected`, async ({
		db,
	}) => {
		expect(
			await db
				.selectNoFrom(compileTerm(term(""), makeCtx(db)).as("v"))
				.executeTakeFirstOrThrow(),
		).toEqual({ v: null });
		await expect(
			db
				.selectNoFrom(compileTerm(term("malformed"), makeCtx(db)).as("v"))
				.execute(),
		).rejects.toMatchObject({ code: "22007" });
	});
}

test("reserved metadata reads its scalar column through a custom anchor alias", async ({
	db,
}) => {
	const expected = {
		case_id: PATIENT_CASE_ID,
		case_type: "patient",
		owner_id: "case-owner",
		status: "open",
		case_name: "Actual name",
		external_id: "Actual external id",
		date_opened: new Date("2026-01-01T08:00:00Z"),
		last_modified: new Date("2026-02-02T09:00:00Z"),
	};
	await db
		.insertInto("cases")
		.values(
			makeCaseRow({
				case_id: PATIENT_CASE_ID,
				app_id: APP_ID,
				project_id: PROJECT_ID,
				case_type: "patient",
				owner_id: expected.owner_id,
				case_name: expected.case_name,
				external_id: expected.external_id,
				opened_on: expected.date_opened,
				modified_on: expected.last_modified,
				properties: JSON.stringify(
					Object.fromEntries(
						Object.keys(expected).map((key) => [key, "wrong JSON value"]),
					),
				),
			}),
		)
		.execute();
	expect(
		await db
			.selectFrom("cases as selected_case")
			.select(
				Object.keys(expected).map((name) =>
					compileTerm(
						prop("patient", name),
						makeCtx(db, { anchorAlias: "selected_case" }),
					).as(name),
				),
			)
			.where("selected_case.case_id", "=", PATIENT_CASE_ID)
			.execute(),
	).toEqual([expected]);
});

test("ancestor scalar reads correlate without a caller-supplied join and leave unrelated anchors null", async ({
	db,
}) => {
	await db
		.insertInto("cases")
		.values([
			makeCaseRow({
				case_id: PATIENT_CASE_ID,
				app_id: APP_ID,
				project_id: PROJECT_ID,
				case_type: "patient",
				properties: JSON.stringify({ size: 999 }),
			}),
			makeCaseRow({
				case_id: HOUSEHOLD_CASE_ID,
				app_id: APP_ID,
				project_id: PROJECT_ID,
				case_type: "household",
				properties: JSON.stringify({ size: 5 }),
			}),
			makeCaseRow({
				case_id: "unrelated",
				app_id: APP_ID,
				project_id: PROJECT_ID,
				case_type: "patient",
				properties: JSON.stringify({ size: 888 }),
			}),
		])
		.execute();
	await db
		.insertInto("case_indices")
		.values({
			case_id: PATIENT_CASE_ID,
			ancestor_id: HOUSEHOLD_CASE_ID,
			target_case_type: "household",
			identifier: "parent",
			relationship: "child",
			depth: 1,
		})
		.execute();
	const via = ancestorPath(relationStep("parent", "household"));
	expect(
		await db
			.selectFrom("cases as c")
			.select([
				"c.case_id",
				compileTerm(prop("patient", "size", via), makeCtx(db)).as("size"),
				compileTerm(prop("patient", "case_id", via), makeCtx(db)).as(
					"parent_id",
				),
			])
			.where("c.app_id", "=", APP_ID)
			.where("c.case_type", "=", "patient")
			.orderBy("c.case_id")
			.execute(),
	).toEqual([
		{ case_id: PATIENT_CASE_ID, size: 5, parent_id: HOUSEHOLD_CASE_ID },
		{ case_id: "unrelated", size: null, parent_id: null },
	]);
});

test("explicit self reads preserve the distinction between absent and blank", async ({
	db,
}) => {
	await db
		.insertInto("cases")
		.values([
			makeCaseRow({
				case_id: "absent",
				app_id: APP_ID,
				project_id: PROJECT_ID,
			}),
			makeCaseRow({
				case_id: "blank",
				app_id: APP_ID,
				project_id: PROJECT_ID,
				properties: JSON.stringify({ nickname: "" }),
			}),
		])
		.execute();
	expect(
		await db
			.selectFrom("cases as c")
			.select([
				"c.case_id",
				compileTerm(prop("patient", "nickname", selfPath()), makeCtx(db)).as(
					"nickname",
				),
			])
			.where("c.app_id", "=", APP_ID)
			.orderBy("c.case_id")
			.execute(),
	).toEqual([
		{ case_id: "absent", nickname: null },
		{ case_id: "blank", nickname: "" },
	]);
});

test("form multi-select answers remain JSON arrays and explicit null does not use the missing-user fallback", async ({
	db,
}) => {
	const uuid = testUuid("answer");
	const ctx = makeCtx(db, {
		bindings: {
			formFields: new Map([[uuid, ["alpha", "O'Brien"]]]),
			sessionUser: new Map([["region", null]]),
			sessionUserFallback: "",
		},
	});
	expect(
		await db
			.selectNoFrom([
				compileTerm(formField(uuid), ctx).as("answer"),
				compileTerm(sessionUser("region"), ctx).as("present"),
				compileTerm(sessionUser("missing"), ctx).as("absent"),
			])
			.executeTakeFirstOrThrow(),
	).toEqual({ answer: ["alpha", "O'Brien"], present: null, absent: "" });
});
