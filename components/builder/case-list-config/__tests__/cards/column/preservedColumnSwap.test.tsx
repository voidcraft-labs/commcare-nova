import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { caseListConfig } from "@/lib/__tests__/docHelpers";
import { columnSnapshotMutations } from "@/lib/doc/caseListColumnMutations";
import {
	type CaseType,
	type Column,
	type ColumnKind,
	calculatedColumn,
	dateColumn,
	idMappingColumn,
	imageMapColumn,
	intervalColumn,
	linkColumn,
	phoneColumn,
	plainColumn,
	tileCell,
} from "@/lib/domain";
import { literal, term } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import { preservedColumnSwap } from "../../../columnDisplayState";
import { admittedWorkspace, commitWorkspace } from "../../admittedWorkspace";

const uuid = testUuid("display-transition");
const caseTypes: CaseType[] = [
	{
		name: "patient",
		properties: [
			{ name: "case_name", label: proseText("Name"), data_type: "text" },
			{ name: "dob", label: proseText("Birth date"), data_type: "date" },
		],
	},
];
const ctx = { caseTypes, currentCaseType: "patient" };
const tile = tileCell(2, 1, 5, 2, {
	horizontalAlign: "right",
	verticalAlign: "middle",
	fontSize: "large",
	showBorder: true,
	showShading: true,
});
const slots = { tile, visibleInDetail: false };
const sources: Column[] = [
	plainColumn(uuid, "case_name", "Authored label", slots),
	phoneColumn(uuid, "case_name", "Authored label", slots),
	linkColumn(uuid, "case_name", "Authored label", "Read this", slots),
	dateColumn(uuid, "dob", "Authored label", "%d-%m-%Y", slots),
	intervalColumn(
		uuid,
		"dob",
		"Authored label",
		30,
		"weeks",
		"flag",
		"Overdue",
		slots,
	),
	idMappingColumn(
		uuid,
		"case_name",
		"Authored label",
		[{ value: "x", label: "Shown X" }],
		slots,
	),
	imageMapColumn(uuid, "case_name", "Authored label", [], slots),
	calculatedColumn(uuid, "Authored label", term(literal("Ready")), slots),
];
const targets: ColumnKind[] = [
	"plain",
	"date",
	"interval",
	"phone",
	"link",
	"id-mapping",
	"image-map",
	"calculated",
];
function workspace(source: Column, types = caseTypes) {
	const config = caseListConfig([{ field: "case_name", header: "Name" }]);
	config.columns = [source];
	config.listColumnOrder = [uuid];
	config.detailColumnOrder = [uuid];
	return admittedWorkspace(types, config, "patient");
}

describe("admitted display replacements", () => {
	it.each(
		sources.flatMap((source) =>
			targets.map((target) => [source.kind, target, source] as const),
		),
	)(
		"%s to %s preserves identity/presentation or refuses the actual incompatible field",
		(_kind, target, source) => {
			const { doc, moduleUuid } = workspace(source);
			const incompatible =
				source.kind !== "calculated" &&
				((source.field === "dob" &&
					(target === "phone" || target === "link")) ||
					(source.field === "case_name" &&
						(target === "date" || target === "interval")));
			const next = preservedColumnSwap(source, target, ctx);
			if (incompatible) {
				expect(next).toBeUndefined();
				return;
			}
			expect(next).toBeDefined();
			if (!next) throw new Error("missing display");
			const saved = commitWorkspace(
				doc,
				columnSnapshotMutations(moduleUuid, source, next),
			).modules[moduleUuid].caseListConfig;
			expect(saved?.columns[0]).toEqual(next);
			expect(saved?.listColumnOrder).toEqual([uuid]);
			expect(saved?.detailColumnOrder).toEqual([uuid]);
			expect(next).toMatchObject({
				uuid,
				header: "Authored label",
				tile,
				visibleInDetail: false,
			});
			if (next.kind !== "calculated")
				expect(next.field).toBe(
					source.kind === "calculated"
						? target === "date" || target === "interval"
							? "dob"
							: "case_name"
						: source.field,
				);
			if (target === source.kind) expect(next).toEqual(source);
			else if (next.kind === "calculated")
				expect(next.expression).toEqual({
					kind: "term",
					term: { kind: "literal", value: "" },
				});
			else if (next.kind === "date") expect(next.pattern).toBe("%Y-%m-%d");
			else if (next.kind === "interval")
				expect(next).toMatchObject({
					threshold: 7,
					unit: "days",
					display: "always",
					text: "",
				});
			else if (next.kind === "link") expect(next.linkText).toBe("Open");
			else if (next.kind === "id-mapping" || next.kind === "image-map")
				expect(next.mapping).toEqual([]);
		},
	);
	it.each(["date", "phone", "interval"] as const)(
		"admits a calculated-to-%s replacement against an explicitly unknown property",
		(target) => {
			const types: CaseType[] = [
				{
					name: "patient",
					properties: [
						{ name: "untyped_value", label: proseText("Imported value") },
					],
				},
			];
			const source = calculatedColumn(uuid, "Imported", term(literal("Ready")));
			const { doc, moduleUuid } = workspace(source, types);
			const next = preservedColumnSwap(source, target, {
				caseTypes: types,
				currentCaseType: "patient",
			});
			expect(next).toMatchObject({ field: "untyped_value" });
			if (!next) throw new Error("missing display");
			expect(
				commitWorkspace(doc, columnSnapshotMutations(moduleUuid, source, next))
					.modules[moduleUuid].caseListConfig?.columns[0],
			).toEqual(next);
		},
	);
	it("leaves an unavailable field display unseeded", () => {
		const types: CaseType[] = [{ name: "patient", properties: [] }];
		const source = calculatedColumn(uuid, "Computed", term(literal("Ready")));
		workspace(source, types);
		expect(
			preservedColumnSwap(source, "plain", {
				caseTypes: types,
				currentCaseType: "patient",
			}),
		).toBeUndefined();
	});
});
