import { describe, expect, it } from "vitest";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import {
	isValidLocation,
	type LocationParseDoc,
	parsePathToLocation,
	recoverLocation,
	serializePath,
} from "../location";
import { parentLocation } from "../navigation";
import type { Location } from "../types";

const tableId = lookupTableIdSchema.parse(
	"01912d68-783e-7000-8000-000000000001",
);
const doc: LocationParseDoc = {
	modules: {},
	forms: {},
	fields: {},
	formOrder: {},
	fieldOrder: {},
};

describe("Project data routes", () => {
	it.each([
		{
			location: { kind: "project-data" },
			path: ["project-data"],
			parent: { kind: "home" },
		},
		{
			location: { kind: "project-data", tableId },
			path: ["project-data", tableId],
			parent: { kind: "project-data" },
		},
	] satisfies { location: Location; path: string[]; parent: Location }[])(
		"keeps $path independent of blueprint entities",
		({ location, path, parent }) => {
			expect(serializePath(location)).toEqual(path);
			expect(parsePathToLocation(path, doc)).toEqual(location);
			expect(isValidLocation(location, doc)).toBe(true);
			expect(recoverLocation(location, doc)).toBe(location);
			expect(parentLocation(location)).toEqual(parent);
		},
	);
	it.each(["not-a-uuid", tableId.toUpperCase()])(
		"opens the table list for noncanonical identity %s",
		(id) => {
			expect(parsePathToLocation(["project-data", id], doc)).toEqual({
				kind: "project-data",
			});
		},
	);
});
