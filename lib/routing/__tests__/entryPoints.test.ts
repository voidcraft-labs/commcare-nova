import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	isValidLocation,
	type LocationParseDoc,
	parsePathToLocation,
	recoverLocation,
	serializePath,
} from "../location";

const uuid = testUuid("entry-point-route");
const moduleUuid = testUuid("entry-point-module");
const doc = {
	modules: {},
	forms: {},
	fields: {},
	formOrder: {},
	fieldOrder: {},
} as LocationParseDoc;
describe("deep link authoring routes", () => {
	it("round trips the selected identity", () => {
		const location = {
			kind: "app-setup" as const,
			section: "deep-links" as const,
			entryPointUuid: uuid,
		};
		expect(serializePath(location)).toEqual(["setup", "deep-links", uuid]);
		expect(parsePathToLocation(serializePath(location), doc)).toEqual(location);
	});
	it("drops removed identity while retaining the overview", () => {
		const location = {
			kind: "app-setup" as const,
			section: "deep-links" as const,
			entryPointUuid: uuid,
		};
		expect(isValidLocation(location, doc)).toBe(false);
		expect(recoverLocation(location, doc)).toEqual({
			kind: "app-setup",
			section: "deep-links",
		});
	});
	it("retains an owned identity and ignores selected identities on other sections", () => {
		const populated = {
			...doc,
			modules: {
				[moduleUuid]: { uuid: moduleUuid, entryPoint: { uuid, id: "start" } },
			},
		} as LocationParseDoc;
		const location = {
			kind: "app-setup" as const,
			section: "deep-links" as const,
			entryPointUuid: uuid,
		};
		expect(recoverLocation(location, populated)).toBe(location);
		expect(
			parsePathToLocation(["setup", "publishing", uuid], populated),
		).toEqual({ kind: "app-setup", section: "publishing" });
	});
});
