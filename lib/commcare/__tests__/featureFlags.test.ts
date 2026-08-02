import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { BlueprintDoc, Module } from "@/lib/domain";
import { literal, term } from "@/lib/domain/predicate";
import {
	decodeHqFeatureFlagReport,
	encodeHqFeatureFlagReport,
	featureFlagReportForDownload,
	featureFlagReportForUpload,
	requiredHqFeatureFlags,
	requiredHqFeatureFlagUses,
} from "../featureFlags";

function doc(overrides: Partial<BlueprintDoc> = {}): BlueprintDoc {
	return {
		appId: "app-1",
		appName: "Feature flags",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
		...overrides,
	};
}

function module(overrides: Partial<Module> = {}): Module {
	return {
		uuid: testUuid("module-patients"),
		id: "patients",
		name: "Patients",
		caseType: "patient",
		caseListConfig: {
			columns: [],
			listColumnOrder: [],
			detailColumnOrder: [],
			searchInputs: [],
		},
		...overrides,
	};
}

describe("requiredHqFeatureFlags", () => {
	it("returns no requirements for a plain case list", () => {
		const patient = module();
		expect(
			requiredHqFeatureFlags(doc({ modules: { [patient.uuid]: patient } })),
		).toEqual([]);
	});

	it("requires Simple Case Search for a zero-input Search action", () => {
		const patient = module({ caseSearchConfig: {} });
		expect(
			requiredHqFeatureFlags(doc({ modules: { [patient.uuid]: patient } })).map(
				(flag) => flag.slug,
			),
		).toEqual(["search_claim"]);
	});

	it("does not mistake owner-only case availability for Search", () => {
		const patient = module({
			caseSearchConfig: {
				searchActionEnabled: false,
				excludedOwnerIds: term(literal("owner-1")),
			},
		});
		expect(
			requiredHqFeatureFlags(doc({ modules: { [patient.uuid]: patient } })),
		).toEqual([]);
	});

	it("adds Advanced Case Search only when advanced wire behavior is used", () => {
		const patient = module({
			caseSearchConfig: {},
			caseListConfig: {
				columns: [],
				listColumnOrder: [],
				detailColumnOrder: [],
				searchInputs: [
					{
						uuid: testUuid("search-name"),
						kind: "simple",
						type: "text",
						name: "name_query",
						label: "Name",
						property: "name",
					},
				],
			},
		});
		expect(
			requiredHqFeatureFlags(doc({ modules: { [patient.uuid]: patient } })).map(
				(flag) => flag.slug,
			),
		).toEqual(["search_claim", "case_search_advanced"]);
	});

	it("requires CommCare Connect from the app-level mode", () => {
		expect(
			requiredHqFeatureFlags(doc({ connectType: "learn" })).map((f) => f.slug),
		).toEqual(["commcare_connect"]);
	});

	it("explains the authored settings behind each ordered requirement", () => {
		const patient = module({
			caseSearchConfig: {},
			caseListConfig: {
				columns: [],
				listColumnOrder: [],
				detailColumnOrder: [],
				searchInputs: [
					{
						uuid: testUuid("search-name-explanation"),
						kind: "simple",
						type: "text",
						name: "name_query",
						label: "Name",
						property: "name",
					},
				],
			},
		});
		const uses = requiredHqFeatureFlagUses(
			doc({
				connectType: "learn",
				modules: { [patient.uuid]: patient },
			}),
		);

		expect(uses.map((use) => use.requirement.slug)).toEqual([
			"search_claim",
			"case_search_advanced",
			"commcare_connect",
		]);
		expect(uses[0]?.reasons).toEqual([
			"The “Patients” module has a Case Search action or Search inputs.",
		]);
		expect(uses[1]?.reasons).toEqual([
			"The “Patients” module uses a Search input whose matching behavior needs Advanced Case Search.",
		]);
		expect(uses[2]?.reasons).toEqual([
			"The app is configured for CommCare Connect Learn.",
		]);
	});
});

describe("feature flag reports", () => {
	it("keeps downloaded requirements explicitly unverified", () => {
		const report = featureFlagReportForDownload(
			doc({ connectType: "deliver" }),
		);
		expect(report.verification).toBe("not_checked");
		expect(report.missing_flags).toEqual([]);
		expect(report.unverified_flags.map((flag) => flag.slug)).toEqual([
			"commcare_connect",
		]);
		expect(report.message).toContain(
			"cannot check a downloaded file's destination",
		);
		expect(report.message).toContain("support@dimagi.com");
	});

	it("distinguishes confirmed missing flags from diagnostic failures", () => {
		const required = requiredHqFeatureFlags(
			doc({
				connectType: "learn",
				modules: { a: module({ caseSearchConfig: {} }) },
			}),
		);
		const report = featureFlagReportForUpload("clinic-space", [
			{ requirement: required[0], state: "missing" },
			{ requirement: required[1], state: "unavailable" },
		]);
		expect(report.verification).toBe("partial");
		expect(report.missing_flags.map((flag) => flag.slug)).toEqual([
			"search_claim",
		]);
		expect(report.unverified_flags.map((flag) => flag.slug)).toEqual([
			"commcare_connect",
		]);
		expect(report.message).toContain("The app was still published");
	});

	it("ignores syntactically valid but structurally malformed report headers", () => {
		expect(decodeHqFeatureFlagReport(encodeURIComponent("{}"))).toBeUndefined();
		expect(
			decodeHqFeatureFlagReport(
				encodeURIComponent(
					JSON.stringify({
						verification: "not_checked",
						required_flags: "not-an-array",
					}),
				),
			),
		).toBeUndefined();
	});

	it("round-trips a valid report header", () => {
		const report = featureFlagReportForDownload(doc({ connectType: "learn" }));
		expect(
			decodeHqFeatureFlagReport(encodeHqFeatureFlagReport(report)),
		).toEqual(report);
	});
});
