import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	type Automation,
	automationMessageText,
	type BlueprintDoc,
	type Module,
	plainColumn,
} from "@/lib/domain";
import { literal, term } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
import {
	decodeProjectSpaceCompatibilityReport,
	encodeProjectSpaceCompatibilityReport,
	projectSpaceCompatibilityForDownload,
	projectSpaceCompatibilityForTarget,
	projectSpaceCompatibilityProbePlan,
	requiredProjectSpaceCapabilities,
} from "../projectSpaceCompatibility";

function doc(overrides: Partial<BlueprintDoc> = {}): BlueprintDoc {
	return {
		appId: "app-1",
		appName: "Compatibility",
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

describe("projectSpaceCompatibilityProbePlan", () => {
	it("needs no special support for a plain case list", () => {
		const patient = module();
		expect(
			projectSpaceCompatibilityProbePlan(
				doc({ modules: { [patient.uuid]: patient } }),
			),
		).toEqual({ capabilities: [], advisories: [] });
	});

	it("checks only base Search for a zero-input Search", () => {
		const patient = module({ caseSearchConfig: {} });
		const plan = projectSpaceCompatibilityProbePlan(
			doc({ modules: { [patient.uuid]: patient } }),
		);

		expect(plan.capabilities).toHaveLength(1);
		expect(plan.capabilities[0]?.capability.id).toBe("case-search");
		expect(plan.capabilities[0]?.featureFlags.map((flag) => flag.id)).toEqual([
			"case-search-base",
		]);
		expect(plan.capabilities[0]?.runtimeProbes).toEqual(["case-search"]);
		expect(plan.capabilities[0]?.featureFlags[0]?.namespace).toBe("domain");
		expect(plan.advisories[0]?.advisory.id).toBe("large-search-performance");
	});

	it("adds advanced Search only for a field starting value", () => {
		const nameColumn = plainColumn(
			testUuid("column-name-default"),
			"name",
			"Name",
		);
		const patient = module({
			caseSearchConfig: {},
			caseListConfig: {
				columns: [nameColumn],
				listColumnOrder: [nameColumn.uuid],
				detailColumnOrder: [nameColumn.uuid],
				searchInputs: [
					{
						uuid: testUuid("search-name-default"),
						kind: "simple",
						type: "text",
						name: "name",
						label: "Name",
						property: "name",
						default: term(literal("Ada")),
					},
				],
			},
		});
		const plan = projectSpaceCompatibilityProbePlan(
			doc({ modules: { [patient.uuid]: patient } }),
		);

		expect(plan.capabilities[0]?.featureFlags.map((flag) => flag.id)).toEqual([
			"case-search-base",
			"advanced-case-search",
		]);
		expect(plan.capabilities[0]?.capability.reasons).toContain(
			"A Search field starts with a suggested value.",
		);
	});

	it("does not require advanced Search for an app-defined query", () => {
		const patient = module({
			caseSearchConfig: {},
			caseListConfig: {
				columns: [],
				listColumnOrder: [],
				detailColumnOrder: [],
				searchInputs: [
					{
						uuid: testUuid("search-advanced-query"),
						kind: "advanced",
						type: "text",
						name: "query",
						label: "Query",
						predicate: { kind: "match-all" },
					},
				],
			},
		});
		const plan = projectSpaceCompatibilityProbePlan(
			doc({ modules: { [patient.uuid]: patient } }),
		);

		expect(plan.capabilities[0]?.featureFlags.map((flag) => flag.id)).toEqual([
			"case-search-base",
		]);
	});

	it("checks only base Search for an ordinary exact input", () => {
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
		const plan = projectSpaceCompatibilityProbePlan(
			doc({ modules: { [patient.uuid]: patient } }),
		);

		expect(plan.capabilities[0]?.featureFlags.map((flag) => flag.id)).toEqual([
			"case-search-base",
		]);
	});

	it("does not require advanced Search for an ineffective match-all filter", () => {
		const nameColumn = plainColumn(
			testUuid("column-name-match-all"),
			"name",
			"Name",
		);
		const patient = module({
			caseSearchConfig: {},
			caseListConfig: {
				columns: [nameColumn],
				listColumnOrder: [nameColumn.uuid],
				detailColumnOrder: [nameColumn.uuid],
				filter: { kind: "match-all" },
				searchInputs: [
					{
						uuid: testUuid("search-name-match-all"),
						kind: "simple",
						type: "text",
						name: "name",
						label: "Name",
						property: "name",
					},
				],
			},
		});
		const plan = projectSpaceCompatibilityProbePlan(
			doc({ modules: { [patient.uuid]: patient } }),
		);

		expect(plan.capabilities[0]?.featureFlags.map((flag) => flag.id)).toEqual([
			"case-search-base",
		]);
	});

	it("does not mistake owner-only case availability for Search", () => {
		const patient = module({
			caseSearchConfig: {
				searchActionEnabled: false,
				excludedOwnerIds: term(literal("owner-1")),
			},
		});
		expect(
			requiredProjectSpaceCapabilities(
				doc({ modules: { [patient.uuid]: patient } }),
			),
		).toEqual([]);
	});

	it("derives CommCare Connect from the app mode", () => {
		expect(
			requiredProjectSpaceCapabilities(doc({ connectType: "learn" })).map(
				(capability) => capability.id,
			),
		).toEqual(["commcare-connect"]);
	});

	it("derives CommCare Connect from alert content", () => {
		const alert: Automation = {
			uuid: testUuid("connect-alert"),
			kind: "conditional-alert",
			name: "Send opportunity",
			caseType: "patient",
			criteriaOperator: "all",
			criteria: [],
			setupOnlyCriteria: [],
			recipients: [{ uuid: testUuid("connect-owner"), kind: "owner" }],
			schedule: {
				kind: "immediate",
				events: [
					{
						uuid: testUuid("connect-event"),
						minutesToWait: 0,
						content: {
							kind: "connect-message",
							message: automationMessageText("A new opportunity is ready"),
						},
					},
				],
			},
			includeDescendantLocations: false,
			locationLevelUuids: [],
			userDataFilters: [],
			useUserCaseForFilter: false,
		};

		expect(
			requiredProjectSpaceCapabilities(
				doc({ automations: { [alert.uuid]: alert } }),
			).map((capability) => capability.id),
		).toEqual(["commcare-connect"]);
	});

	it("requires registration after an empty search only for a lowered no-matches form", () => {
		const formUuid = testUuid("form-register");
		const registration = {
			uuid: formUuid,
			id: "register",
			name: "Register patient",
			type: "registration" as const,
			entry: { kind: "search-no-matches" as const },
		};
		const searchFirst = module({ caseSearchConfig: { searchFirst: true } });
		const plan = projectSpaceCompatibilityProbePlan(
			doc({
				modules: { [searchFirst.uuid]: searchFirst },
				forms: { [formUuid]: registration },
				formOrder: { [searchFirst.uuid]: [formUuid] },
			}),
		);
		const capability = plan.capabilities.find(
			(item) => item.capability.id === "registration-after-empty-search",
		);
		expect(capability?.capability.reasons).toEqual([
			"A search that finds nothing offers to register a new case.",
		]);
		expect(capability?.featureFlags.map((flag) => flag.id)).toEqual([
			"no-matches-registration",
		]);
		expect(capability?.runtimeProbes).toEqual([]);

		// The same form on a module that does not open on search is a
		// validator finding, not a lowered Register action.
		const browse = module();
		expect(
			requiredProjectSpaceCapabilities(
				doc({
					modules: { [browse.uuid]: browse },
					forms: { [formUuid]: registration },
					formOrder: { [browse.uuid]: [formUuid] },
				}),
			).map((item) => item.id),
		).not.toContain("registration-after-empty-search");
	});

	it("keeps the two attachment delivery capabilities distinct", () => {
		const capture = (
			mode: "url" | "attachment",
			uuid: ReturnType<typeof testUuid>,
		) => ({
			uuid,
			id: `photo_${mode}`,
			kind: "image" as const,
			label: proseText("Photo"),
			caseWrite: { caseType: "patient", property: "photo", mode },
		});
		const urlUuid = testUuid("field-photo-url");
		const attachmentUuid = testUuid("field-photo-attachment");
		const plan = projectSpaceCompatibilityProbePlan(
			doc({
				fields: {
					[urlUuid]: capture("url", urlUuid),
					[attachmentUuid]: capture("attachment", attachmentUuid),
				},
			}),
		);

		expect(plan.capabilities.map((item) => item.capability.id)).toEqual([
			"case-attachments",
			"attachment-links",
		]);
	});
});

describe("project-space compatibility reports", () => {
	it("keeps an unknown destination semantic and not checked", () => {
		const report = projectSpaceCompatibilityForDownload(
			doc({ connectType: "deliver" }),
		);
		expect(report.status).toBe("not_checked");
		expect(report.required_capabilities).toMatchObject([
			{ id: "commcare-connect", state: "not_checked" },
		]);
		expect(report.blockers).toEqual([]);
		expect(report.message).toContain("Choose a project space");
	});

	it("blocks missing and unverified required capabilities", () => {
		const uses = requiredProjectSpaceCapabilities(
			doc({ connectType: "learn" }),
		);
		const report = projectSpaceCompatibilityForTarget(
			"clinic-space",
			[{ capability: uses[0], state: "unverified" }],
			[],
		);
		expect(report.status).toBe("blocked");
		expect(report.blockers).toMatchObject([
			{ id: "commcare-connect", state: "unverified" },
		]);
		expect(report.message).toContain("Nothing has been sent");
	});

	it("keeps a connected-account permission failure semantic and actionable", () => {
		const patient = module({ caseSearchConfig: {} });
		const uses = requiredProjectSpaceCapabilities(
			doc({ modules: { [patient.uuid]: patient } }),
		);
		const report = projectSpaceCompatibilityForTarget(
			"clinic-space",
			[
				{
					capability: uses[0],
					state: "unverified",
					issue: "connected-account-permission",
				},
			],
			[],
		);

		expect(report.blockers).toMatchObject([
			{
				id: "case-search",
				state: "unverified",
				issue: "connected-account-permission",
			},
		]);
		expect(report.message).toContain("Mobile App Access");
		expect(report.message).not.toContain("access_mobile_endpoints");
		expect(
			decodeProjectSpaceCompatibilityReport(
				encodeProjectSpaceCompatibilityReport(report),
			),
		).toEqual(report);
	});

	it("keeps a missing optimization advisory non-blocking", () => {
		const patient = module({ caseSearchConfig: {} });
		const plan = projectSpaceCompatibilityProbePlan(
			doc({ modules: { [patient.uuid]: patient } }),
		);
		const report = projectSpaceCompatibilityForTarget(
			"clinic-space",
			[{ capability: plan.capabilities[0].capability, state: "available" }],
			[{ advisory: plan.advisories[0].advisory, state: "missing" }],
		);

		expect(report.status).toBe("ready");
		expect(report.blockers).toEqual([]);
		expect(report.advisories).toMatchObject([
			{
				id: "large-search-performance",
				state: "missing",
				title: "Large searches may open more slowly",
			},
		]);
	});

	it("never serializes private flags, namespaces, or raw probe arrays", () => {
		const report = projectSpaceCompatibilityForDownload(
			doc({ connectType: "learn" }),
		);
		const serialized = JSON.stringify(report);
		expect(serialized).not.toContain("commcare_connect");
		expect(serialized).not.toContain("search_claim");
		expect(serialized).not.toContain("NAMESPACE_DOMAIN");
		expect(serialized).not.toContain("required_flags");
	});

	it("rejects malformed headers and round-trips the public contract", () => {
		expect(
			decodeProjectSpaceCompatibilityReport(encodeURIComponent("{}")),
		).toBeUndefined();
		const report = projectSpaceCompatibilityForDownload(
			doc({ connectType: "learn" }),
		);
		expect(
			decodeProjectSpaceCompatibilityReport(
				encodeProjectSpaceCompatibilityReport(report),
			),
		).toEqual(report);
	});
});
