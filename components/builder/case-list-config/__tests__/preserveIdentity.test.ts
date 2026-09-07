import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	advancedSearchInputDef,
	type Column,
	columnSchema,
	dateColumn,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import { eq, input, prop, whenInput } from "@/lib/domain/predicate";
import { withPreservedIdentity } from "../preserveIdentity";

// This value-object projection owns identity retention. Actual document admission
// and placement repair are exercised by the column/tile mutation plans.
describe("rebuilt case-list item identity", () => {
	it("keeps a column's identity and placed presentation while replacing its format", () => {
		const uuid = testUuid("preserve-column"),
			fresh = testUuid("preserve-new-column");
		const existing = plainColumn(uuid, "date_opened", "Opened", {
			tile: { x: 0, y: 2, width: 6, height: 1, fontSize: "large" },
		});
		const rebuilt = dateColumn(fresh, "date_opened", "Date opened", "%Y-%m-%d");
		columnSchema.parse(existing);
		columnSchema.parse(rebuilt);
		const result = withPreservedIdentity<Column>(existing, rebuilt);
		expect(result).toStrictEqual({
			uuid,
			kind: "date",
			field: "date_opened",
			header: "Date opened",
			pattern: "%Y-%m-%d",
			tile: { x: 0, y: 2, width: 6, height: 1, fontSize: "large" },
		});
		expect(rebuilt.uuid).toBe(fresh);
		expect(existing.kind).toBe("plain");
	});
	it("does not add a tile slot to an unplaced column", () => {
		const existing = plainColumn(
			testUuid("preserve-unplaced"),
			"date_opened",
			"Opened",
		);
		const result = withPreservedIdentity<Column>(
			existing,
			dateColumn(
				testUuid("preserve-unplaced-new"),
				"date_opened",
				"Opened",
				"%d-%m-%Y",
			),
		);
		expect(Object.hasOwn(result, "tile")).toBe(false);
		expect(result.uuid).toBe(existing.uuid);
	});
	it("keeps search identity through a simple-to-custom replacement", () => {
		const uuid = testUuid("preserve-input");
		const existing = simpleSearchInputDef(
			uuid,
			"by_name",
			"Name",
			"text",
			"case_name",
		);
		const custom = whenInput(
			input(uuid),
			eq(prop("patient", "case_name"), input(uuid)),
		);
		const rebuilt = advancedSearchInputDef(
			testUuid("preserve-input-new"),
			"by_name",
			"Name",
			"text",
			custom,
		);
		const result = withPreservedIdentity<typeof existing | typeof rebuilt>(
			existing,
			rebuilt,
		);
		expect(result).toStrictEqual({ ...rebuilt, uuid });
	});
});
