import { describe, expect, it } from "vitest";
import { asUuid } from "@/lib/doc/types";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import { parentLocation } from "@/lib/routing/hooks";
import type { LocationParseDoc } from "@/lib/routing/location";
import {
	isValidLocation,
	parsePathToLocation,
	recoverLocation,
	serializePath,
} from "@/lib/routing/location";
import type { Location } from "@/lib/routing/types";

const tableId = lookupTableIdSchema.parse(
	"01912d68-783e-7000-8000-000000000001",
);
const moduleUuid = asUuid("11111111-1111-4111-8111-111111111111");

const emptyDoc: LocationParseDoc = {
	modules: {},
	forms: {},
	fields: {},
	formOrder: {},
	fieldOrder: {},
};

describe("Project data locations", () => {
	it("serializes the table list and one table", () => {
		expect(serializePath({ kind: "project-data" })).toEqual(["project-data"]);
		expect(serializePath({ kind: "project-data", tableId })).toEqual([
			"project-data",
			tableId,
		]);
	});

	it("round-trips both shapes through the parser", () => {
		for (const loc of [
			{ kind: "project-data" },
			{ kind: "project-data", tableId },
		] satisfies Location[]) {
			expect(parsePathToLocation(serializePath(loc), emptyDoc)).toEqual(loc);
		}
	});

	it("cannot be shadowed by a module, because the segment is not a uuid", () => {
		/* The reserved segment is safe by construction rather than by ordering:
		 * a module is keyed by a canonical uuid, and "project-data" is not one,
		 * so no doc can carry a module that shadows the workspace. */
		expect(() => asUuid("project-data")).toThrow();
		expect(parsePathToLocation(["project-data"], emptyDoc)).toEqual({
			kind: "project-data",
		});
	});

	it("opens the table list when the second segment is not a table id", () => {
		expect(
			parsePathToLocation(["project-data", "not-a-uuid"], emptyDoc),
		).toEqual({ kind: "project-data" });
	});

	it("opens the table list for an uppercase id rather than normalizing it", () => {
		/* A uuid has one spelling. Nova only ever emits the lowercase one, so an
		 * uppercase segment is not a second address for the same table — it is
		 * an id this Project has no table for, and it lands on the list. */
		expect(
			parsePathToLocation(["project-data", tableId.toUpperCase()], emptyDoc),
		).toEqual({ kind: "project-data" });
	});

	it("stays valid against any document, because it names no blueprint entity", () => {
		expect(isValidLocation({ kind: "project-data" }, emptyDoc)).toBe(true);
		expect(isValidLocation({ kind: "project-data", tableId }, emptyDoc)).toBe(
			true,
		);
	});

	it("survives recovery unchanged — a doc change can never invalidate it", () => {
		const withTable: Location = { kind: "project-data", tableId };
		expect(recoverLocation(withTable, emptyDoc)).toBe(withTable);
		const list: Location = { kind: "project-data" };
		expect(recoverLocation(list, emptyDoc)).toBe(list);
	});

	it("walks up from a table to the list, and from the list to home", () => {
		expect(parentLocation({ kind: "project-data", tableId })).toEqual({
			kind: "project-data",
		});
		expect(parentLocation({ kind: "project-data" })).toEqual({ kind: "home" });
	});

	it("does not disturb an ordinary module path", () => {
		const doc: LocationParseDoc = {
			...emptyDoc,
			modules: {
				[moduleUuid]: {} as unknown as LocationParseDoc["modules"][string],
			},
		};
		expect(parsePathToLocation([moduleUuid], doc)).toEqual({
			kind: "module",
			moduleUuid,
		});
	});
});
