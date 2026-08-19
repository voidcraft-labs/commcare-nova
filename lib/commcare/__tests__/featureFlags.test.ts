import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { type BlueprintDoc, type Module, plainColumn } from "@/lib/domain";
import { literal, term } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
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

	it("requires Advanced Case Search for the zero-input match-all query", () => {
		const patient = module({ caseSearchConfig: {} });
		expect(
			requiredHqFeatureFlags(doc({ modules: { [patient.uuid]: patient } })).map(
				(flag) => flag.slug,
			),
		).toEqual(["search_claim", "case_search_advanced"]);
	});

	it("does not mistake ordinary Results ordering for custom search sorting", () => {
		const nameColumn = plainColumn(testUuid("column-name"), "name", "Name", {
			sort: { direction: "asc", priority: 0 },
		});
		const patient = module({
			caseSearchConfig: {},
			caseListConfig: {
				columns: [nameColumn],
				listColumnOrder: [nameColumn.uuid],
				detailColumnOrder: [nameColumn.uuid],
				searchInputs: [
					{
						uuid: testUuid("search-name-exact"),
						kind: "simple",
						type: "text",
						name: "name",
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

/*
 * Both attachment save-to-case modes name a project-space toggle, and
 * they name DIFFERENT ones because the two modes put the file in
 * different places. Neither is ever blocking — a target's configuration
 * does not edit the app — so what these pin is that the requirement is
 * REPORTED, and reported against the right flag.
 */
describe("attachment save-to-case modes", () => {
	const capture = (mode: "url" | "attachment") => ({
		uuid: testUuid("field-photo"),
		id: "thepicture",
		kind: "image" as const,
		label: proseText("Photo"),
		caseWrite: { caseType: "patient", property: "photo", mode },
	});

	it("asks for Multimedia Case Properties when the file goes on the case", () => {
		const uses = requiredHqFeatureFlagUses(
			doc({ fields: { [testUuid("field-photo")]: capture("attachment") } }),
		);
		expect(uses.map((use) => use.requirement.slug)).toEqual([
			"mm_case_properties",
		]);
		expect(uses[0]?.reasons).toEqual([
			"The “Photo” question saves its file onto the case.",
		]);
	});

	it("asks for View Form Attachments when only a link goes on the case", () => {
		const uses = requiredHqFeatureFlagUses(
			doc({ fields: { [testUuid("field-photo")]: capture("url") } }),
		);
		expect(uses.map((use) => use.requirement.slug)).toEqual([
			"view_form_attachments",
		]);
	});

	it("asks for nothing when the capture saves to no case at all", () => {
		const { caseWrite: _dropped, ...unsaved } = capture("url");
		expect(
			requiredHqFeatureFlagUses(
				doc({ fields: { [testUuid("field-photo")]: unsaved } }),
			),
		).toEqual([]);
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
		expect(report.message).toContain("requirements, not confirmed missing");
		expect(report.message).toContain("support@dimagi.com");
	});

	it("distinguishes confirmed missing flags from diagnostic failures", () => {
		const patientSearch = module({
			caseSearchConfig: {},
			caseListConfig: {
				columns: [],
				listColumnOrder: [],
				detailColumnOrder: [],
				searchInputs: [
					{
						uuid: testUuid("report-search-name"),
						kind: "simple",
						type: "text",
						name: "name",
						label: "Name",
						property: "name",
					},
				],
			},
		});
		const required = requiredHqFeatureFlags(
			doc({
				connectType: "learn",
				modules: { a: patientSearch },
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
