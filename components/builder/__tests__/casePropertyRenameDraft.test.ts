import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	availableCasePropertyRenameSources,
	casePropertyInventoryNames,
	casePropertyRenameSourceId,
	casePropertyRenameSources,
	parseCasePropertyRenameSourceId,
} from "../casePropertyRenameDraft";

const caseTypes: readonly CaseType[] = [
	{
		name: "client",
		properties: [
			{ name: "case_name", label: proseText("Case name"), data_type: "text" },
			{
				name: "first_name",
				label: proseText("First name"),
				data_type: "text",
			},
			{
				name: "preferred_name",
				label: proseText("Preferred name"),
				data_type: "text",
			},
		],
	},
	{
		name: "visit",
		properties: [
			{
				name: "visit_date",
				label: proseText("Visit date"),
				data_type: "date",
			},
		],
	},
];

describe("case-property rename draft", () => {
	it("shows every row scalar even when it is not an effective catalog entry", () => {
		expect(casePropertyInventoryNames(caseTypes[0] as CaseType)).toEqual([
			"case_name",
			"first_name",
			"preferred_name",
			"case_id",
			"case_type",
			"date_opened",
			"last_modified",
			"owner_id",
			"external_id",
			"status",
		]);
	});

	it("exposes custom properties across every case type and locks scalars", () => {
		expect(casePropertyRenameSources(caseTypes)).toEqual([
			{
				caseType: "client",
				property: "first_name",
				label: "First name",
			},
			{
				caseType: "client",
				property: "preferred_name",
				label: "Preferred name",
			},
			{
				caseType: "visit",
				property: "visit_date",
				label: "Visit date",
			},
		]);
	});

	it("keeps a row's own source while excluding sources selected elsewhere", () => {
		const sources = casePropertyRenameSources(caseTypes);
		const rows = [
			{ caseType: "client", property: "first_name", to: "preferred_name" },
			{ caseType: "client", property: "preferred_name", to: "first_name" },
		];
		expect(
			availableCasePropertyRenameSources(sources, rows, 0).map(
				(source) => source.property,
			),
		).toEqual(["first_name", "visit_date"]);
		expect(
			availableCasePropertyRenameSources(sources, rows).map(
				(source) => source.property,
			),
		).toEqual(["visit_date"]);
	});

	it("round-trips the complete source identity without a slug projection", () => {
		const id = casePropertyRenameSourceId("client", "first_name");
		expect(parseCasePropertyRenameSourceId(id)).toEqual({
			caseType: "client",
			property: "first_name",
		});
		expect(parseCasePropertyRenameSourceId("not-json")).toBeUndefined();
	});
});
