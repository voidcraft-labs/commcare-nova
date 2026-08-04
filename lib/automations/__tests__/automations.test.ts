import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	automationMatchProjection,
	localOwnerIdsForLocation,
} from "@/lib/automations/matching";
import { buildAutomationSetupGuide } from "@/lib/automations/setupGuidance";
import {
	type Automation,
	automationSchema,
	type BlueprintDoc,
	isPortableAutomationRegex,
} from "@/lib/domain";
import type { StoredLocation } from "@/lib/organization/types";

const RULE_UUID = testUuid("automation-rule");
const CRITERION_UUID = testUuid("automation-criterion");
const SETUP_UUID = testUuid("automation-setup-criterion");

function claimCleanup(): Extract<Automation, { kind: "case-update" }> {
	const parsed = automationSchema.parse({
		uuid: RULE_UUID,
		kind: "case-update",
		name: "Close abandoned claims",
		caseType: "commcare-case-claim",
		criteriaOperator: "all",
		criteria: [],
		setupOnlyCriteria: [],
		serverModifiedBoundaryDays: 30,
		runOnSave: false,
		updates: [],
		closeCase: true,
	});
	if (parsed.kind !== "case-update") throw new Error("wrong automation kind");
	return parsed;
}

function location(
	id: ReturnType<typeof testUuid>,
	parentId: ReturnType<typeof testUuid> | null,
	name: string,
): StoredLocation {
	return {
		id,
		name,
		siteCode: name.toLowerCase(),
		externalId: null,
		levelUuid: testUuid(`level-${name}`),
		parentId,
		latitude: null,
		longitude: null,
		archivedAt: null,
		values: {},
		orderKey: "a0",
	};
}

describe("automation domain and projections", () => {
	it("represents the canonical claim-cleanup rule with zero ordinary criteria", () => {
		const rule = claimCleanup();
		expect(rule.criteria).toEqual([]);
		expect(rule.serverModifiedBoundaryDays).toBe(30);
		expect(rule.closeCase).toBe(true);
	});

	it("keeps HQ-only conditions out of the count and names every omission", () => {
		const doc = buildDoc({ appName: "Claims" });
		const rule: Automation = {
			...claimCleanup(),
			setupOnlyCriteria: [
				{ uuid: SETUP_UUID, text: "UCR filter: stale_claims" },
			],
		};
		const projection = automationMatchProjection(doc, rule, []);
		expect(projection.countArgs.automationCriteria).toBeUndefined();
		expect(projection.omittedCriteria).toEqual([
			"UCR filter: stale_claims",
			"HQ server-modified age of at least 30 days",
		]);
		expect(projection.countArgs.predicate).toMatchObject({ kind: "eq" });
	});

	it("lowers all nine property match types and preserves regex for Postgres", () => {
		const matchTypes = [
			["equal", { value: "active" }],
			["not-equal", { value: "closed" }],
			["has-value", {}],
			["has-no-value", {}],
			["regex", { value: "A[0-9]+" }],
			["date-days-before", { days: 3 }],
			["date-days-lte", { days: 3 }],
			["date-days-gt", { days: 3 }],
			["date-days", { days: 3 }],
		] as const;
		const criteria = matchTypes.map(([matchType, extra], index) => ({
			uuid: testUuid(`automation-match-${index}`),
			kind: "match-property" as const,
			property: matchType.startsWith("date-") ? "due_date" : "status_code",
			matchType,
			...extra,
		}));
		const rule = automationSchema.parse({
			...claimCleanup(),
			criteria,
			serverModifiedBoundaryDays: undefined,
		});
		const projection = automationMatchProjection(
			buildDoc({ appName: "Rules" }),
			rule,
			[],
		);
		expect(projection.countArgs.automationCriteria?.regexes).toEqual([
			{ property: "status_code", pattern: "A[0-9]+" },
		]);
		expect(projection.countArgs.automationCriteria?.predicate).toBeDefined();
	});

	it("expands a location to descendants and Preview personas", () => {
		const district = testUuid("district");
		const facility = testUuid("facility");
		const persona = testUuid("persona");
		const doc = buildDoc({ appName: "Locations" }) as BlueprintDoc;
		doc.personas = {
			[persona]: {
				uuid: persona,
				name: "Asha",
				locations: { primaryUuid: facility, additionalUuids: [] },
				values: {},
			},
		};
		doc.personaOrder = [persona];
		expect(
			localOwnerIdsForLocation(
				doc,
				[
					location(district, null, "District"),
					location(facility, district, "Facility"),
				],
				district,
				true,
			),
		).toEqual([district, facility, persona].sort());
	});

	it("does not treat a Preview persona's additional assignment as HQ's primary location", () => {
		const district = testUuid("secondary-district");
		const facility = testUuid("secondary-facility");
		const elsewhere = testUuid("primary-elsewhere");
		const persona = testUuid("secondary-persona");
		const doc = buildDoc({ appName: "Locations" }) as BlueprintDoc;
		doc.personas = {
			[persona]: {
				uuid: persona,
				name: "Asha",
				locations: {
					primaryUuid: elsewhere,
					additionalUuids: [facility],
				},
				values: {},
			},
		};
		expect(
			localOwnerIdsForLocation(
				doc,
				[
					location(district, null, "District"),
					location(facility, district, "Facility"),
					location(elsewhere, null, "Elsewhere"),
				],
				district,
				true,
			),
		).toEqual([district, facility].sort());
	});

	it("regenerates exact plan, route, cadence, cap, and non-execution guidance", () => {
		const guide = buildAutomationSetupGuide(
			buildDoc({ appName: "Claims" }),
			claimCleanup(),
			[],
		);
		const text = [...guide.steps, ...guide.caveats].join(" ");
		expect(guide.requiredPlan).toBe("Data Cleanup (Pro or higher)");
		expect(text).toContain("Data → Edit Data → Automatic Case Update Rules");
		expect(text).toContain("10,000 updates");
		expect(text).toContain("once daily");
		expect(text).toContain("does not run this automation in Preview");
		expect(text).not.toContain("50,000");
	});

	it("renders every survey, message, location, language, and filter setting", () => {
		const doc = buildDoc({ appName: "Alerts" }) as BlueprintDoc;
		const formUuid = testUuid("alert-form");
		const levelUuid = testUuid("alert-level");
		doc.organizationLevels = {
			[levelUuid]: {
				uuid: levelUuid,
				code: "district",
				name: "District",
				caseFlow: { workers: "none", ownsCases: false },
				addressBook: { reach: "own-branch" },
			},
		};
		const alert: Automation = {
			uuid: testUuid("complete-alert"),
			kind: "conditional-alert",
			name: "Visit reminder",
			caseType: "visit",
			criteriaOperator: "all",
			criteria: [
				{
					uuid: testUuid("closed-parent-criterion"),
					kind: "closed-parent",
					identifier: "parent",
					relationship: "child",
				},
			],
			setupOnlyCriteria: [],
			recipients: [{ uuid: testUuid("alert-owner"), kind: "owner" }],
			schedule: {
				kind: "immediate",
				events: [
					{
						uuid: testUuid("survey-event"),
						minutesToWait: 0,
						content: {
							kind: "sms-survey",
							formUuid,
							expirationHours: 72,
							reminderIntervalsMinutes: [30, 60],
							submitPartiallyCompletedForms: true,
							includeCaseUpdatesInPartialSubmissions: true,
						},
					},
					{
						uuid: testUuid("email-event"),
						minutesToWait: 5,
						content: {
							kind: "email",
							subject: "Visit due",
							message: "Plain body",
							htmlMessage: "<p>HTML body</p>",
						},
					},
				],
			},
			includeDescendantLocations: true,
			locationLevelUuids: [levelUuid],
			defaultLanguageCode: "fr",
			userDataFilters: [],
			useUserCaseForFilter: false,
		};
		const guide = buildAutomationSetupGuide(doc, alert, []);
		const text = guide.steps.join(" ");
		expect(text).toContain("closed related case");
		expect(text).toContain("expire after 72 hour(s)");
		expect(text).toContain("30, 60 minute(s)");
		expect(text).toContain("submit partially completed forms on");
		expect(text).toContain('HTML message "<p>HTML body</p>"');
		expect(text).toContain("Include descendant locations");
		expect(text).toContain("District");
		expect(text).toContain("default language code to fr");
		expect(text).toContain("Add no custom-user-data recipient filters");
	});

	it("admits complete historical IVR settings and rejects incomplete survey content", () => {
		const ivr = automationSchema.safeParse({
			uuid: testUuid("historical-ivr-alert"),
			kind: "conditional-alert",
			name: "Historical IVR",
			caseType: "visit",
			criteriaOperator: "all",
			criteria: [],
			setupOnlyCriteria: [],
			recipients: [
				{ uuid: testUuid("historical-ivr-recipient"), kind: "self" },
			],
			schedule: {
				kind: "immediate",
				events: [
					{
						uuid: testUuid("historical-ivr-event"),
						minutesToWait: 0,
						content: {
							kind: "ivr",
							formUuid: testUuid("historical-ivr-form"),
							reminderIntervalsMinutes: [15],
							submitPartiallyCompletedForms: true,
							includeCaseUpdatesInPartialSubmissions: false,
							maxQuestionAttempts: 5,
						},
					},
				],
			},
			includeDescendantLocations: false,
			locationLevelUuids: [],
			userDataFilters: [],
			useUserCaseForFilter: false,
		});
		expect(ivr.success).toBe(true);
		expect(
			automationSchema.safeParse({
				...(ivr.success && ivr.data),
				schedule: {
					kind: "immediate",
					events: [
						{
							uuid: testUuid("incomplete-survey-event"),
							minutesToWait: 0,
							content: {
								kind: "sms-survey",
								formUuid: testUuid("incomplete-survey-form"),
							},
						},
					],
				},
			}).success,
		).toBe(false);
	});

	it("admits only the regex subset shared by Python and PostgreSQL", () => {
		expect(isPortableAutomationRegex("^A[0-9]+(?:-B)?$")).toBe(false);
		expect(isPortableAutomationRegex("^A[0-9]+(-B)?$")).toBe(true);
		expect(isPortableAutomationRegex("(?<code>A+)")).toBe(false);
		expect(isPortableAutomationRegex("\\d+")).toBe(false);
	});

	it("enforces upstream string bounds and persistable JSON integers", () => {
		expect(
			automationSchema.safeParse({
				...claimCleanup(),
				name: "x".repeat(127),
			}).success,
		).toBe(false);
		expect(
			automationSchema.safeParse({
				...claimCleanup(),
				criteria: [
					{
						uuid: CRITERION_UUID,
						kind: "match-property",
						property: "code",
						matchType: "equal",
						value: "x".repeat(127),
					},
				],
			}).success,
		).toBe(false);
		expect(
			automationSchema.safeParse({
				...claimCleanup(),
				serverModifiedBoundaryDays: -0,
			}).success,
		).toBe(false);
	});

	it("rejects malformed criteria and update-free case-update rules", () => {
		expect(
			automationSchema.safeParse({
				...claimCleanup(),
				criteria: [
					{
						uuid: CRITERION_UUID,
						kind: "match-property",
						property: "code",
						matchType: "regex",
					},
				],
			}).success,
		).toBe(false);
		expect(
			automationSchema.safeParse({
				...claimCleanup(),
				serverModifiedBoundaryDays: undefined,
				closeCase: false,
			}).success,
		).toBe(false);
	});
});
