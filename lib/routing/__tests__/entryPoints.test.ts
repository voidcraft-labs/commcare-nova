import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	isValidLocation,
	parsePathToLocation,
	recoverLocation,
	serializePath,
} from "../location";
import type { Location } from "../types";

const entry = testUuid("entry");
const location: Location = {
	kind: "app-setup",
	section: "deep-links",
	entryPointUuid: entry,
};

describe("deep link authoring routes", () => {
	it.each(["module", "case-list", "form"])(
		"retains a %s entry identity through rename, then recovers its removed owner",
		(carrier) => {
			const doc = buildDoc({
				modules: [
					{
						name: "Visits",
						caseType: "visit",
						forms: [
							{
								name: "Visit",
								type: "survey",
								fields: [f({ kind: "text", id: "name" })],
							},
						],
					},
				],
			});
			const module = doc.modules[doc.moduleOrder[0]];
			const form = doc.forms[doc.formOrder[module.uuid][0]];
			const point = { uuid: entry, id: "start" };
			if (carrier === "module") module.entryPoint = point;
			else if (carrier === "case-list") module.caseListEntryPoint = point;
			else form.entryPoint = point;
			expect(serializePath(location)).toEqual(["setup", "deep-links", entry]);
			expect(parsePathToLocation(["setup", "deep-links", entry], doc)).toEqual(
				location,
			);
			expect(isValidLocation(location, doc)).toBe(true);
			point.id = "renamed";
			expect(recoverLocation(location, doc)).toBe(location);
			expect(serializePath(location)).toEqual(["setup", "deep-links", entry]);
			if (carrier === "form") delete doc.forms[form.uuid];
			else delete doc.modules[module.uuid];
			expect(isValidLocation(location, doc)).toBe(false);
			expect(recoverLocation(location, doc)).toEqual({
				kind: "app-setup",
				section: "deep-links",
			});
		},
	);
	it("ignores selected identities outside Deep links and degrades malformed selections", () => {
		const doc = buildDoc();
		expect(parsePathToLocation(["setup", "publishing", entry], doc)).toEqual({
			kind: "app-setup",
			section: "publishing",
		});
		expect(parsePathToLocation(["setup", "deep-links", "broken"], doc)).toEqual(
			{ kind: "app-setup", section: "deep-links" },
		);
		expect(parsePathToLocation(["setup", "missing"], doc)).toEqual({
			kind: "app-setup",
			section: "users",
		});
	});
});
