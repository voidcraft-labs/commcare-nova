import type { Insertable, Selectable, Updateable } from "kysely";
import { expectTypeOf, it } from "vitest";
import type {
	CaseIndicesTable,
	CasesTable,
	CaseTypeSchemasTable,
	JsonObject,
	JsonValue,
	ParkedCaseValuesTable,
} from "../database";

it("keeps tenant identity required and owner identity independently nullable", () => {
	expectTypeOf<Selectable<CasesTable>["project_id"]>().toEqualTypeOf<string>();
	expectTypeOf<Insertable<CasesTable>["project_id"]>().toEqualTypeOf<string>();
	expectTypeOf<Selectable<CasesTable>["owner_id"]>().toEqualTypeOf<
		string | null
	>();
	expectTypeOf<Insertable<CasesTable>["case_id"]>().toEqualTypeOf<
		string | undefined
	>();
});

it("reads JSON objects and nullable Date values while writing encoded JSON and flexible dates", () => {
	expectTypeOf<
		Selectable<CasesTable>["properties"]
	>().toEqualTypeOf<JsonObject>();
	expectTypeOf<Insertable<CasesTable>["properties"]>().toEqualTypeOf<string>();
	expectTypeOf<
		Selectable<CasesTable>["opened_on"]
	>().toEqualTypeOf<Date | null>();
	expectTypeOf<Insertable<CasesTable>["opened_on"]>().toEqualTypeOf<
		Date | string | null | undefined
	>();
});

it("reads schema sequences losslessly and leaves activity database-generated", () => {
	expectTypeOf<
		Selectable<CaseTypeSchemasTable>["synced_seq"]
	>().toEqualTypeOf<string>();
	expectTypeOf<Insertable<CaseTypeSchemasTable>["synced_seq"]>().toEqualTypeOf<
		number | undefined
	>();
	expectTypeOf<
		Updateable<CaseTypeSchemasTable>["index_pending_seq"]
	>().toEqualTypeOf<number | null | undefined>();
	expectTypeOf<keyof Insertable<CaseTypeSchemasTable>>()
		.exclude<"is_active">()
		.toEqualTypeOf<keyof Insertable<CaseTypeSchemasTable>>();
});

it("keeps direct index identities opaque and relationship kinds finite", () => {
	expectTypeOf<
		Selectable<CaseIndicesTable>["case_id"]
	>().toEqualTypeOf<string>();
	expectTypeOf<
		Selectable<CaseIndicesTable>["target_case_type"]
	>().toEqualTypeOf<string>();
	expectTypeOf<Selectable<CaseIndicesTable>["relationship"]>().toEqualTypeOf<
		"child" | "extension"
	>();
});

it("allows scalar parked JSON and leaves new entry identity and timestamps optional", () => {
	expectTypeOf<
		Selectable<ParkedCaseValuesTable>["original_value"]
	>().toEqualTypeOf<JsonValue>();
	expectTypeOf<Insertable<ParkedCaseValuesTable>["id"]>().toEqualTypeOf<
		string | undefined
	>();
	expectTypeOf<
		Selectable<ParkedCaseValuesTable>["dismissed_at"]
	>().toEqualTypeOf<Date | null>();
});
