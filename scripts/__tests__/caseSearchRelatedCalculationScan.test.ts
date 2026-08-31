import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	type CaseType,
	calculatedColumn,
	plainColumn,
	proseText,
} from "@/lib/domain";
import {
	ancestorPath,
	double,
	prop,
	relationStep,
	term,
} from "@/lib/domain/predicate";
import {
	buildCaseSearchRelatedCalculationScanReport,
	renderCaseSearchRelatedCalculationScanReport,
	scanCaseSearchRelatedCalculations,
} from "../lib/caseSearchRelatedCalculationScan";

const MODULE_UUID = testUuid("scan-module");
const DIRECT_COLUMN_UUID = testUuid("scan-direct-column");
const WRAPPED_COLUMN_UUID = testUuid("scan-wrapped-column");
const PARENT = ancestorPath(relationStep("parent", "household"));
const CASE_TYPES: CaseType[] = [
	{
		name: "patient",
		parent_type: "household",
		properties: [
			{ name: "case_name", label: proseText("Name"), data_type: "text" },
		],
	},
	{
		name: "household",
		properties: [
			{ name: "region", label: proseText("Region"), data_type: "text" },
			{ name: "score", label: proseText("Score"), data_type: "int" },
		],
	},
];

function scanDoc() {
	const name = plainColumn(testUuid("scan-name-column"), "case_name", "Name");
	const direct = calculatedColumn(
		DIRECT_COLUMN_UUID,
		"Direct parent value",
		term(prop("patient", "region", PARENT)),
	);
	const wrapped = calculatedColumn(
		WRAPPED_COLUMN_UUID,
		"Private authored label",
		double(term(prop("patient", "score", PARENT))),
	);
	return buildDoc({
		appName: "Private authored app name",
		caseTypes: CASE_TYPES,
		modules: [
			{
				uuid: MODULE_UUID,
				name: "Private authored module name",
				caseType: "patient",
				caseListOnly: true,
				caseSearchConfig: {},
				caseListConfig: {
					columns: [name, direct, wrapped],
					searchInputs: [],
				},
			},
		],
	});
}

describe("Case Search related-calculation persisted-state scan", () => {
	it("uses the validator boundary and returns only stable identities", () => {
		expect(scanCaseSearchRelatedCalculations(scanDoc())).toEqual([
			{ moduleUuid: MODULE_UUID, columnUuid: WRAPPED_COLUMN_UUID },
		]);
	});

	it("renders deterministic fleet evidence without authored content", () => {
		const report = buildCaseSearchRelatedCalculationScanReport(
			[
				{
					appId: "app-z",
					findings: [
						{ moduleUuid: MODULE_UUID, columnUuid: WRAPPED_COLUMN_UUID },
					],
				},
				{ appId: "app-clean", findings: [] },
			],
			["app-unreadable"],
		);
		const rendered = renderCaseSearchRelatedCalculationScanReport(report);

		expect(report).toMatchObject({
			scannedApps: 3,
			affectedApps: 1,
			affectedColumns: 1,
			exitCode: 1,
		});
		expect(rendered).toContain(`module ${MODULE_UUID}`);
		expect(rendered).toContain(`column ${WRAPPED_COLUMN_UUID}`);
		expect(rendered).toContain("app app-unreadable");
		expect(rendered).not.toContain("Private authored");
		expect(rendered).not.toContain("double");
		expect(rendered.indexOf("app app-z")).toBeLessThan(
			rendered.indexOf("app app-unreadable"),
		);
	});

	it("returns a clean zero-exit report when every persisted app is compatible", () => {
		const report = buildCaseSearchRelatedCalculationScanReport([
			{ appId: "app-clean", findings: [] },
		]);

		expect(report.exitCode).toBe(0);
		expect(renderCaseSearchRelatedCalculationScanReport(report)).toContain(
			"CLEAN: no persisted app saves an unsupported related-case calculation",
		);
	});
});
