import { describe, expect, it } from "vitest";
import { asUuid, simpleSearchInputDef } from "@/lib/domain";
import { searchInputMoveMutation } from "../searchInput";

const MODULE_UUID = asUuid("00000000-0000-4000-8000-000000000310");
const FIRST_UUID = asUuid("00000000-0000-4000-8000-000000000311");
const SECOND_UUID = asUuid("00000000-0000-4000-8000-000000000312");

describe("searchInputMoveMutation", () => {
	it("writes only the moved search field's fractional key", () => {
		const first = {
			...simpleSearchInputDef(
				FIRST_UUID,
				"case_name",
				"Patient name",
				"text",
				"case_name",
			),
			order: "a",
		};
		const second = {
			...simpleSearchInputDef(
				SECOND_UUID,
				"external_id",
				"External ID",
				"text",
				"external_id",
			),
			order: "b",
		};

		const mutation = searchInputMoveMutation({
			moduleUuid: MODULE_UUID,
			inputs: [first, second],
			uuid: FIRST_UUID,
			toIndex: 1,
		});

		expect(mutation).toMatchObject({
			kind: "moveSearchInput",
			moduleUuid: MODULE_UUID,
			uuid: FIRST_UUID,
		});
		if (mutation?.kind !== "moveSearchInput") {
			throw new Error("expected a search-input move");
		}
		expect(mutation.order > second.order).toBe(true);
	});

	it("does not create undo work for an already-placed or unknown field", () => {
		const input = {
			...simpleSearchInputDef(
				FIRST_UUID,
				"case_name",
				"Patient name",
				"text",
				"case_name",
			),
			order: "a",
		};

		expect(
			searchInputMoveMutation({
				moduleUuid: MODULE_UUID,
				inputs: [input],
				uuid: FIRST_UUID,
				toIndex: 0,
			}),
		).toBeUndefined();
		expect(
			searchInputMoveMutation({
				moduleUuid: MODULE_UUID,
				inputs: [input],
				uuid: SECOND_UUID,
				toIndex: 0,
			}),
		).toBeUndefined();
	});
});
