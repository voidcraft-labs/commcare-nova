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
