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
const moduleUuid = asUuid("11111111-1111-1111-1111-111111111111");

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

	it("matches the reserved segment before any doc lookup", () => {
		/* A module uuid is a branded string with no format constraint, so a doc
		 * keyed on the literal segment must not be able to shadow the
		 * workspace. */
		const shadowing: LocationParseDoc = {
			...emptyDoc,
			modules: {
				[asUuid("project-data")]: {
					name: "Not a workspace",
				} as unknown as LocationParseDoc["modules"][string],
			},
		};
		expect(parsePathToLocation(["project-data"], shadowing)).toEqual({
			kind: "project-data",
		});
	});

	it("opens the table list when the second segment is not a table id", () => {
		expect(
			parsePathToLocation(["project-data", "not-a-uuid"], emptyDoc),
		).toEqual({ kind: "project-data" });
	});

	it("normalizes a table id's case, so a hand-typed link still resolves", () => {
		expect(
			parsePathToLocation(["project-data", tableId.toUpperCase()], emptyDoc),
		).toEqual({ kind: "project-data", tableId });
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
