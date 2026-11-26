import { describe, expect, it } from "vitest";
import { asUuid } from "@/lib/domain/uuid";
import { projectCaseMap, workerMapOffered } from "../caseMap";

const id = (index: number) =>
	asUuid(`00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
const sources = {
	locations: [id(1), id(2)],
	layers: {
		boundary: [id(3)],
		"boundary-color": [id(4)],
		points: [id(5)],
		"point-colors": [id(6)],
	},
};
const values = new Map([
	[id(1), ""],
	[id(2), "12 24 5 8"],
	[id(3), "12 24 15 24 15 20"],
	[id(4), "#80CBA018"],
	[id(5), "12 24 14 22"],
	[id(6), "#AA2211,blue"],
]);
const read = (key: ReturnType<typeof id>) => values.get(key) ?? "";

describe("case maps in the worker app", () => {
	it("offers a Web Apps map only for a confirmed destination and a populated list with a location", () => {
		expect(workerMapOffered("web-apps", true, true, true)).toBe(true);
		for (const confirmed of [null, undefined, false])
			expect(workerMapOffered("web-apps", true, true, confirmed)).toBe(false);
		expect(workerMapOffered("android", true, true, undefined)).toBe(true);
		expect(workerMapOffered("web-apps", true, false, true)).toBe(false);
		expect(workerMapOffered("android", false, true, true)).toBe(false);
	});
	it("keeps a blank first Web Apps location while Android finds the next saved location and draws its layers", () => {
		const web = projectCaseMap("web-apps", sources, read);
		expect(web.location).toBeUndefined();
		expect(web).toMatchObject({ boundary: [], points: [] });
		expect(projectCaseMap("android", sources, read)).toMatchObject({
			location: { lat: 12, lng: 24 },
			boundary: [
				{ lat: 12, lng: 24 },
				{ lat: 15, lng: 24 },
				{ lat: 15, lng: 20 },
				{ lat: 12, lng: 24 },
			],
			boundaryColor: "#CBA018",
			points: [
				{ lat: 12, lng: 24 },
				{ lat: 14, lng: 22 },
			],
			pointColors: ["#AA2211", "#0000ff"],
			invalid: false,
		});
	});
	it("keeps usable Android sources after malformed coordinates and falls back to white when the number of colors differs", () => {
		const readChanged = (key: ReturnType<typeof id>) =>
			key === id(1) ? "bad" : key === id(6) ? "red" : read(key);
		expect(projectCaseMap("android", sources, readChanged)).toMatchObject({
			location: { lat: 12, lng: 24 },
			invalid: true,
			pointColors: [],
		});
	});
});
