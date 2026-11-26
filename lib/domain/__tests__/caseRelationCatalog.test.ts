import { expect, it } from "vitest";
import type { CaseType } from "../blueprint";
import {
	columnPropertyBindings,
	columnPropertyScope,
	reachedPropertyType,
} from "../columnRelation";
import { proseText } from "../prose";

const types: CaseType[] = [
	{
		name: "visit",
		properties: [],
		relations: [
			{ identifier: "site", targetType: "clinic", relationship: "child" },
			{ identifier: "site", targetType: "outreach", relationship: "extension" },
		],
	},
	{
		name: "clinic",
		properties: [
			{ name: "total", label: proseText("Total"), data_type: "decimal" },
		],
	},
	{
		name: "outreach",
		properties: [
			{ name: "total", label: proseText("Total"), data_type: "text" },
		],
	},
];

it("binds an unrestricted native property to both destinations and keeps mixed values as text", () => {
	const column = {
		field: "total",
		via: [{ identifier: "site" }] as [{ identifier: string }],
	};
	expect(columnPropertyScope(column, "visit", types)).toEqual({
		types: ["clinic", "outreach"],
		open: false,
	});
	expect(columnPropertyBindings(column, "visit", types)).toEqual([
		"clinic",
		"outreach",
	]);
	expect(reachedPropertyType(column, "visit", types)).toBe("text");
	expect(
		reachedPropertyType(
			column,
			"visit",
			types.map((type) => ({
				...type,
				properties: type.properties.map((property) => ({
					...property,
					data_type: "decimal",
				})),
			})),
		),
	).toBe("decimal");
});

it("keeps a historical index open and includes matching declarations in rename and retirement planning", () => {
	const column = {
		field: "total",
		via: [{ identifier: "old_site" }] as [{ identifier: string }],
	};
	expect(columnPropertyScope(column, "visit", types)).toEqual({
		types: [],
		open: true,
	});
	expect(columnPropertyBindings(column, "visit", types)).toEqual([
		"clinic",
		"outreach",
	]);
	expect(reachedPropertyType(column, "visit", types)).toBe("text");
});
