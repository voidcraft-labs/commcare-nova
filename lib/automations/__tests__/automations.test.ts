import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { automationFormChoices } from "@/lib/automations/formChoices";
import {
	automationMatchProjection,
	automationUsesHostScope,
} from "@/lib/automations/matching";
import { buildAutomationSetupGuide } from "@/lib/automations/setupGuidance";
import {
	type Automation,
	type AutomationSchedule,
	automationMessageText,
	automationRecipientSupportsUserDataFilter,
	automationSchema,
	type BlueprintDoc,
	isAutomationImplicitTextReadProperty,
	isAutomationMessageShadowedCaseProperty,
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
		updates: [],
		closeCase: true,
	});
	if (parsed.kind !== "case-update") throw new Error("wrong automation kind");
	return parsed;
}

function alertWithSchedule(
	schedule: AutomationSchedule,
): Extract<Automation, { kind: "conditional-alert" }> {
	return {
		uuid: testUuid("schedule-alert"),
		kind: "conditional-alert",
		name: "Schedule alert",
		caseType: "visit",
		criteriaOperator: "all",
		criteria: [],
		setupOnlyCriteria: [],
		recipients: [{ uuid: testUuid("schedule-recipient"), kind: "self" }],
		schedule,
		includeDescendantLocations: false,
		locationLevelUuids: [],
		userDataFilters: [],
		useUserCaseForFilter: false,
	};
}

describe("automation domain and projections", () => {
	it("publishes the automation-only metadata and message-shadow admission predicates", () => {
		expect(isAutomationImplicitTextReadProperty("case_id")).toBe(true);
		expect(isAutomationImplicitTextReadProperty("case_type")).toBe(true);
		expect(isAutomationImplicitTextReadProperty("case_name")).toBe(false);
		expect(isAutomationMessageShadowedCaseProperty("owner")).toBe(true);
		expect(isAutomationMessageShadowedCaseProperty("host")).toBe(true);
		expect(isAutomationMessageShadowedCaseProperty("last_modified_by")).toBe(
			true,
		);
		expect(isAutomationMessageShadowedCaseProperty("owner_id")).toBe(false);
		for (const kind of [
			"owner",
			"last-submitting-user",
			"case-property-username",
			"case-property-user-id",
			"location",
			"mobile-worker",
			"user-group",
		] as const) {
			expect(automationRecipientSupportsUserDataFilter(kind)).toBe(true);
		}
		for (const kind of [
			"self",
			"parent-case",
			"all-child-cases",
			"case-property-email",
			"case-group",
			"custom",
		] as const) {
			expect(automationRecipientSupportsUserDataFilter(kind)).toBe(false);
		}
	});

	it("labels duplicate form names by their published app and module path", () => {
		const doc = buildDoc({
			appName: "Care",
			modules: [
				{
					name: "Visits",
					forms: [{ name: "Follow up", type: "survey" }],
				},
				{
					name: "Referrals",
					forms: [{ name: "Follow up", type: "survey" }],
				},
			],
		});
		expect(automationFormChoices(doc).map((choice) => choice.label)).toEqual([
			"Care > Visits > Follow up",
			"Care > Referrals > Follow up",
		]);
	});

	it("includes a submenu's parent path without duplicating its form", () => {
		const doc = buildDoc({
			appName: "Care",
			modules: [
				{
					uuid: "care-menu",
					name: "Care menu",
					forms: [{ name: "Overview", type: "survey" }],
				},
				{
					uuid: "visits-menu",
					name: "Visits",
					forms: [{ name: "Follow up", type: "survey" }],
				},
			],
		});
		const parentUuid = doc.moduleOrder[0];
		const childUuid = doc.moduleOrder[1];
		doc.modules[childUuid].parentModuleUuid = parentUuid;
		expect(automationFormChoices(doc).map((choice) => choice.label)).toEqual([
			"Care > Care menu > Overview",
			"Care > Care menu > Visits > Follow up",
		]);
	});

	it("represents the canonical claim-cleanup rule with zero ordinary criteria", () => {
		const rule = claimCleanup();
		expect(rule.criteria).toEqual([]);
		expect(rule.serverModifiedBoundaryDays).toBe(30);
		expect(rule.closeCase).toBe(true);
		expect(
			automationSchema.safeParse({ ...rule, runOnSave: true }).success,
		).toBe(false);
	});

	it("stores exactly one HQ email form and keeps that target consistent", () => {
		const plain = alertWithSchedule({
			kind: "immediate",
			events: [
				{
					uuid: testUuid("plain-email-event"),
					minutesToWait: 0,
					content: {
						kind: "email",
						subject: automationMessageText("Visit due"),
						body: {
							kind: "plain-text",
							message: automationMessageText("Please attend"),
						},
					},
				},
			],
		});
		expect(automationSchema.safeParse(plain).success).toBe(true);
		expect(
			automationSchema.safeParse({
				...plain,
				schedule: {
					...plain.schedule,
					events: [
						...plain.schedule.events,
						{
							uuid: testUuid("rich-email-event"),
							minutesToWait: 5,
							content: {
								kind: "email" as const,
								subject: automationMessageText("Visit due"),
								body: {
									kind: "rich-text" as const,
									html: automationMessageText("<p>Please attend</p>"),
								},
							},
						},
					],
				},
			}).success,
		).toBe(false);
		expect(
			automationSchema.safeParse({
				...plain,
				schedule: {
					...plain.schedule,
					events: [
						{
							...plain.schedule.events[0],
							content: {
								kind: "email" as const,
								subject: automationMessageText(" Padded "),
								body: {
									kind: "plain-text" as const,
									message: automationMessageText(" Body "),
								},
							},
						},
					],
				},
			}).success,
		).toBe(false);
	});

	it("keeps HQ-only conditions out of the count and names every omission", () => {
		const doc = buildDoc({ appName: "Claims" });
		const rule: Automation = {
			...claimCleanup(),
			setupOnlyCriteria: [
				{ uuid: SETUP_UUID, kind: "ucr-filter", text: "stale_claims" },
			],
		};
		const projection = automationMatchProjection(doc, rule);
		expect(projection.countArgs.automationCriteria).toEqual({
			requiresUnambiguousHost: false,
			operator: "all",
			dates: [],
			comparisons: [],
			regexes: [],
			blankness: [],
			closedParents: [],
			locationOwnerSets: [],
		});
		expect(projection.omittedCriteria).toEqual([
			"User-configurable report (UCR) filter: stale_claims",
			"HQ server-modified age of at least 30 days",
		]);
		expect(projection.countArgs.predicate).toMatchObject({ kind: "eq" });
	});

	it("preserves HQ's empty ALL/ANY boolean identity in the count grammar", () => {
		const doc = buildDoc({ appName: "Empty criteria" });
		const rule = claimCleanup();
		const alert = alertWithSchedule({
			kind: "immediate",
			events: [
				{
					uuid: testUuid("empty-any-alert-event"),
					minutesToWait: 0,
					content: {
						kind: "sms",
						message: automationMessageText("No ordinary criteria"),
					},
				},
			],
		});
		for (const automation of [
			{ ...rule, criteriaOperator: "any" as const },
			{ ...alert, criteriaOperator: "any" as const },
		]) {
			expect(
				automationMatchProjection(doc, automation).countArgs.automationCriteria,
			).toEqual({
				requiresUnambiguousHost: false,
				operator: "any",
				dates: [],
				comparisons: [],
				regexes: [],
				blankness: [],
				closedParents: [],
				locationOwnerSets: [],
			});
		}
	});

	it("distinguishes host-matched counts from setup-only action reads", () => {
		const rule = claimCleanup();
		expect(automationUsesHostScope(rule)).toBe(false);
		const hostCriterion = {
			...rule,
			criteria: [
				{
					uuid: testUuid("host-preflight-criterion"),
					kind: "match-property" as const,
					scope: "host" as const,
					property: "state",
					matchType: "equal" as const,
					value: "open",
				},
			],
		};
		expect(automationUsesHostScope(hostCriterion)).toBe(true);
		expect(
			automationMatchProjection(buildDoc(), hostCriterion).countArgs
				.automationCriteria?.requiresUnambiguousHost,
		).toBe(true);

		const hostUpdate = {
			...rule,
			updates: [
				{
					uuid: testUuid("host-preflight-update"),
					target: { scope: "case" as const, property: "state" },
					value: {
						kind: "case-property" as const,
						source: { scope: "host" as const, property: "state" },
					},
				},
			],
		};
		expect(automationUsesHostScope(hostUpdate)).toBe(true);
		expect(
			automationMatchProjection(buildDoc(), hostUpdate).countArgs
				.automationCriteria?.requiresUnambiguousHost,
		).toBe(false);

		const hostUpdateTarget = {
			...rule,
			updates: [
				{
					uuid: testUuid("host-preflight-update-target"),
					target: { scope: "host" as const, property: "state" },
					value: { kind: "literal" as const, value: "review" },
				},
			],
		};
		expect(automationUsesHostScope(hostUpdateTarget)).toBe(true);
		expect(
			automationMatchProjection(buildDoc(), hostUpdateTarget).countArgs
				.automationCriteria?.requiresUnambiguousHost,
		).toBe(false);

		const alert = alertWithSchedule({
			kind: "immediate",
			events: [
				{
					uuid: testUuid("host-preflight-message-event"),
					minutesToWait: 0,
					content: {
						kind: "sms",
						message: {
							parts: [
								{
									kind: "case-property",
									scope: "host",
									caseType: "household",
									property: "state",
								},
							],
						},
					},
				},
			],
		});
		expect(automationUsesHostScope(alert)).toBe(true);
		expect(
			automationMatchProjection(buildDoc(), alert).countArgs.automationCriteria
				?.requiresUnambiguousHost,
		).toBe(false);
	});

	it("lowers the distinct case-update and conditional-alert criteria matrices", () => {
		const matchTypes = [
			["equal", { value: "active" }],
			["not-equal", { value: "closed" }],
			["has-value", {}],
			["has-no-value", {}],
			["date-days-before", { days: 3 }],
			["date-days-lte", { days: 3 }],
			["date-days-gt", { days: 3 }],
			["date-days", { days: 3 }],
		] as const;
		const criteria = matchTypes.map(([matchType, extra], index) => ({
			uuid: testUuid(`automation-match-${index}`),
			kind: "match-property" as const,
			scope: "case",
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
		);
		expect(projection.countArgs.automationCriteria?.blankness).toEqual([
			{ property: "status_code", hasValue: true, scope: "case" },
			{ property: "status_code", hasValue: false, scope: "case" },
		]);
		expect(projection.countArgs.automationCriteria?.comparisons).toEqual([
			{
				property: "status_code",
				value: "active",
				equal: true,
				scope: "case",
			},
			{
				property: "status_code",
				value: "closed",
				equal: false,
				scope: "case",
			},
		]);
		expect(projection.countArgs.automationCriteria?.dates).toEqual([
			{
				property: "due_date",
				days: 3,
				matchType: "date-days-before",
				scope: "case",
			},
			{
				property: "due_date",
				days: 3,
				matchType: "date-days-lte",
				scope: "case",
			},
			{
				property: "due_date",
				days: 3,
				matchType: "date-days-gt",
				scope: "case",
			},
			{
				property: "due_date",
				days: 3,
				matchType: "date-days",
				scope: "case",
			},
		]);

		const alert = alertWithSchedule({
			kind: "immediate",
			events: [
				{
					uuid: testUuid("criteria-matrix-event"),
					minutesToWait: 0,
					content: { kind: "sms", message: automationMessageText("Hello") },
				},
			],
		});
		alert.criteria = [
			{
				uuid: testUuid("criteria-matrix-regex"),
				kind: "match-property",
				scope: "case",
				property: "status_code",
				matchType: "regex",
				value: "A[0-9]+",
			},
		];
		expect(
			automationMatchProjection(buildDoc({ appName: "Alerts" }), alert)
				.countArgs.automationCriteria?.regexes,
		).toEqual([{ property: "status_code", pattern: "A[0-9]+" }]);
		expect(
			automationSchema.safeParse({
				...alert,
				criteria: [{ ...alert.criteria[0], matchType: "date-days" }],
			}).success,
		).toBe(false);
		expect(
			automationSchema.safeParse({
				...alert,
				serverModifiedBoundaryDays: 5,
			}).success,
		).toBe(false);
		expect(
			automationSchema.safeParse({
				...alert,
				criteria: [
					{
						uuid: testUuid("alert-parent-property"),
						kind: "match-property",
						scope: "parent",
						property: "status_code",
						matchType: "has-value",
					},
				],
			}).success,
		).toBe(false);
		expect(
			automationSchema.safeParse({
				...alert,
				criteria: [
					{ uuid: testUuid("alert-closed-parent"), kind: "closed-parent" },
				],
			}).success,
		).toBe(false);
		expect(
			automationSchema.safeParse({
				...rule,
				criteria: [
					{
						uuid: testUuid("case-update-regex"),
						kind: "match-property",
						scope: "case",
						property: "status_code",
						matchType: "regex",
						value: "A+",
					},
				],
			}).success,
		).toBe(false);
	});

	it("projects parent-property update criteria through the declared case relation", () => {
		const doc = buildDoc({
			appName: "Related criteria",
			caseTypes: [
				{
					name: "household",
					properties: [{ name: "state", label: "State", data_type: "text" }],
				},
				{
					name: "visit",
					parent_type: "household",
					relationship: "child",
					properties: [],
				},
			],
		});
		const rule: Extract<Automation, { kind: "case-update" }> = {
			...claimCleanup(),
			caseType: "visit",
			criteria: [
				{
					uuid: testUuid("parent-property-criterion"),
					kind: "match-property",
					scope: "parent",
					property: "state",
					matchType: "equal",
					value: "active",
				},
			],
		};
		const projection = automationMatchProjection(doc, rule);
		expect(projection.countArgs.automationCriteria?.comparisons).toEqual([
			{
				property: "state",
				value: "active",
				equal: true,
				scope: "parent",
			},
		]);
		expect(buildAutomationSetupGuide(doc, rule, []).steps.join(" ")).toContain(
			"Parent case property state equals",
		);
	});

	it("matches a location condition against its subtree and worker primary locations", () => {
		const locationUuid = testUuid("criterion-location");
		const childUuid = testUuid("criterion-location-child");
		const personaUuid = testUuid("criterion-location-persona");
		const doc = buildDoc({ appName: "Location criteria" }) as BlueprintDoc;
		doc.personas = {
			[personaUuid]: {
				uuid: personaUuid,
				name: "Asha",
				locations: { primaryUuid: childUuid },
			},
		};
		doc.personaOrder = [personaUuid];
		const locations: StoredLocation[] = [
			{
				id: locationUuid,
				levelUuid: testUuid("criterion-location-level"),
				parentId: null,
				siteCode: "north",
				name: "North",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
				archivedAt: null,
				orderKey: "a",
			},
			{
				id: childUuid,
				levelUuid: testUuid("criterion-location-child-level"),
				parentId: locationUuid,
				siteCode: "north-clinic",
				name: "North Clinic",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
				archivedAt: null,
				orderKey: "a",
			},
		];
		const criterion = {
			uuid: CRITERION_UUID,
			kind: "location" as const,
			locationUuid,
			includeDescendants: true,
		};
		const rule = automationSchema.parse({
			...claimCleanup(),
			criteria: [criterion],
		});
		const projection = automationMatchProjection(doc, rule, locations);
		expect(
			projection.countArgs.automationCriteria?.locationOwnerSets[0],
		).toEqual(expect.arrayContaining([locationUuid, childUuid, personaUuid]));
		expect(
			projection.countArgs.automationCriteria?.locationOwnerSets[0],
		).toHaveLength(3);
		const directOnly = automationMatchProjection(
			doc,
			{ ...rule, criteria: [{ ...criterion, includeDescendants: false }] },
			locations,
		);
		expect(directOnly.countArgs.automationCriteria?.locationOwnerSets).toEqual([
			[locationUuid],
		]);
		expect(
			automationSchema.safeParse({
				...rule,
				criteria: [
					criterion,
					{ ...criterion, uuid: testUuid("duplicate-location-criterion") },
				],
			}).success,
		).toBe(false);
		const alert = alertWithSchedule({
			kind: "immediate",
			events: [
				{
					uuid: testUuid("location-alert-event"),
					minutesToWait: 0,
					content: { kind: "sms", message: automationMessageText("Hello") },
				},
			],
		});
		expect(
			automationSchema.safeParse({ ...alert, criteria: [criterion] }).success,
		).toBe(true);
		const guide = buildAutomationSetupGuide(doc, rule, locations);
		expect(guide.steps.join(" ")).toContain("North");
		expect(guide.steps.join(" ")).toContain("descendant locations");
		expect(guide.caveats.join(" ")).toContain(
			"current visible rule and alert editors do not expose that picker",
		);
	});

	it("keeps alert recipients and filters in one representable HQ form shape", () => {
		const alert = alertWithSchedule({
			kind: "immediate",
			events: [
				{
					uuid: testUuid("recipient-shape-event"),
					minutesToWait: 0,
					content: { kind: "sms", message: automationMessageText("Hello") },
				},
			],
		});
		const duplicateOwner = [
			{ uuid: testUuid("recipient-owner-a"), kind: "owner" as const },
			{ uuid: testUuid("recipient-owner-b"), kind: "owner" as const },
		];
		for (const hqId of ["", "   ", " worker-1 "]) {
			expect(
				automationSchema.safeParse({
					...alert,
					recipients: [
						{
							uuid: testUuid(`recipient-worker-${hqId}`),
							kind: "mobile-worker",
							hqId,
						},
					],
				}).success,
			).toBe(false);
		}
		expect(
			automationSchema.safeParse({ ...alert, recipients: duplicateOwner })
				.success,
		).toBe(false);
		expect(
			automationSchema.safeParse({
				...alert,
				recipients: [
					{
						uuid: testUuid("recipient-property-a"),
						kind: "case-property-user-id",
						property: "worker_a",
					},
					{
						uuid: testUuid("recipient-property-b"),
						kind: "case-property-user-id",
						property: "worker_b",
					},
				],
			}).success,
		).toBe(false);
		expect(
			automationSchema.safeParse({
				...alert,
				recipients: [
					{
						uuid: testUuid("recipient-worker-a"),
						kind: "mobile-worker",
						hqId: "worker-1",
					},
					{
						uuid: testUuid("recipient-worker-b"),
						kind: "mobile-worker",
						hqId: "worker-1",
					},
				],
			}).success,
		).toBe(false);
		expect(
			automationSchema.safeParse({
				...alert,
				includeDescendantLocations: true,
			}).success,
		).toBe(false);
		expect(
			automationSchema.safeParse({
				...alert,
				locationLevelUuids: [testUuid("recipient-level")],
			}).success,
		).toBe(false);
		const userPropertyUuid = testUuid("recipient-filter-property");
		expect(
			automationSchema.safeParse({
				...alert,
				userDataFilters: [
					{
						uuid: testUuid("recipient-filter-a"),
						userPropertyUuid,
						values: [{ kind: "literal", value: "a" }],
					},
					{
						uuid: testUuid("recipient-filter-b"),
						userPropertyUuid,
						values: [{ kind: "literal", value: "b" }],
					},
				],
			}).success,
		).toBe(false);

		const locationUuid = testUuid("recipient-location");
		const levelUuid = testUuid("recipient-level-valid");
		expect(
			automationSchema.safeParse({
				...alert,
				recipients: [
					{
						uuid: testUuid("recipient-location-row"),
						kind: "location",
						locationUuid,
					},
				],
				includeDescendantLocations: true,
				locationLevelUuids: [levelUuid],
			}).success,
		).toBe(true);
	});

	it("requires concrete external IDs and setup-only instructions", () => {
		const alert = alertWithSchedule({
			kind: "immediate",
			events: [
				{
					uuid: testUuid("external-values-event"),
					minutesToWait: 0,
					content: { kind: "sms", message: automationMessageText("Hello") },
				},
			],
		});
		for (const registeredId of ["", "   ", " handler "]) {
			expect(
				automationSchema.safeParse({
					...alert,
					recipients: [
						{
							uuid: testUuid(`external-recipient-${registeredId}`),
							kind: "custom",
							registeredId,
						},
					],
				}).success,
			).toBe(false);
			expect(
				automationSchema.safeParse({
					...alert,
					schedule: {
						kind: "immediate",
						events: [
							{
								uuid: testUuid(`external-content-${registeredId}`),
								minutesToWait: 0,
								content: { kind: "custom", registeredId },
							},
						],
					},
				}).success,
			).toBe(false);
		}
		for (const defaultLanguageCode of ["", "   ", " fr "]) {
			expect(
				automationSchema.safeParse({ ...alert, defaultLanguageCode }).success,
			).toBe(false);
		}
		expect(
			automationSchema.safeParse({ ...alert, defaultLanguageCode: "fr" })
				.success,
		).toBe(true);
		expect(
			automationSchema.safeParse({
				...alert,
				setupOnlyCriteria: [
					{ uuid: SETUP_UUID, kind: "ucr-filter", text: "   " },
				],
			}).success,
		).toBe(false);
	});

	it("keeps token-looking message text literal until a reference is explicit", () => {
		const literal = automationMessageText("Literal {case.case_name}");
		const structural = {
			parts: [
				{ kind: "text" as const, text: "Projected " },
				{
					kind: "case-property" as const,
					scope: "case" as const,
					caseType: "visit",
					property: "case_name",
				},
				{ kind: "text" as const, text: " for " },
				{
					kind: "context-property" as const,
					context: "recipient" as const,
					property: "name" as const,
				},
			],
		};
		const literalGuide = buildAutomationSetupGuide(
			buildDoc({ appName: "Messages" }),
			alertWithSchedule({
				kind: "immediate",
				events: [
					{
						uuid: testUuid("literal-template-event"),
						minutesToWait: 0,
						content: { kind: "sms", message: literal },
					},
				],
			}),
			[],
		);
		const structuralGuide = buildAutomationSetupGuide(
			buildDoc({ appName: "Messages" }),
			alertWithSchedule({
				kind: "immediate",
				events: [
					{
						uuid: testUuid("structural-template-event"),
						minutesToWait: 0,
						content: { kind: "sms", message: structural },
					},
				],
			}),
			[],
		);
		expect(literalGuide.steps.join(" ")).toContain(
			'"Literal {{case.case_name}}"',
		);
		expect(structuralGuide.steps.join(" ")).toContain(
			'"Projected {case.name} for {recipient.name}"',
		);
	});

	it("keeps recipient-filter literals and case-property lookups unambiguous", () => {
		const alert = alertWithSchedule({
			kind: "immediate",
			events: [
				{
					uuid: testUuid("filter-value-event"),
					minutesToWait: 0,
					content: { kind: "sms", message: automationMessageText("Hello") },
				},
			],
		});
		alert.recipients = [
			{ uuid: testUuid("filter-value-owner"), kind: "owner" },
		];
		const userPropertyUuid = testUuid("filter-value-user-property");
		const filter = {
			uuid: testUuid("filter-value-row"),
			userPropertyUuid,
			values: [
				{ kind: "literal" as const, value: "" },
				{ kind: "literal" as const, value: "  exact  " },
				{
					kind: "case-property" as const,
					caseType: "visit",
					property: "case_color",
				},
			],
		};
		expect(
			automationSchema.safeParse({ ...alert, userDataFilters: [filter] })
				.success,
		).toBe(true);
		expect(
			automationSchema.safeParse({
				...alert,
				userDataFilters: [
					{
						...filter,
						values: [{ kind: "literal", value: "{case_color}" }],
					},
				],
			}).success,
		).toBe(false);
		expect(
			automationSchema.safeParse({
				...alert,
				userDataFilters: [
					{
						...filter,
						values: [
							{ kind: "literal", value: "yes" },
							{ kind: "literal", value: "yes" },
						],
					},
				],
			}).success,
		).toBe(false);
	});

	it("refuses recipient filters that HQ would bypass for non-user contacts", () => {
		const alert = alertWithSchedule({
			kind: "immediate",
			events: [
				{
					uuid: testUuid("recipient-filter-scope-event"),
					minutesToWait: 0,
					content: { kind: "sms", message: automationMessageText("Hello") },
				},
			],
		});
		const filter = {
			uuid: testUuid("recipient-filter-scope-filter"),
			userPropertyUuid: testUuid("recipient-filter-scope-property"),
			values: [{ kind: "literal" as const, value: "nurse" }],
		};

		for (const recipient of [
			{ uuid: testUuid("filtered-self"), kind: "self" as const },
			{ uuid: testUuid("filtered-parent"), kind: "parent-case" as const },
			{ uuid: testUuid("filtered-children"), kind: "all-child-cases" as const },
			{
				uuid: testUuid("filtered-email"),
				kind: "case-property-email" as const,
				property: "email",
			},
			{
				uuid: testUuid("filtered-case-group"),
				kind: "case-group" as const,
				hqId: "cases",
			},
			{
				uuid: testUuid("filtered-custom"),
				kind: "custom" as const,
				registeredId: "recipient_handler",
			},
		]) {
			const parsed = automationSchema.safeParse({
				...alert,
				recipients: [recipient],
				userDataFilters: [filter],
			});
			expect(parsed.success).toBe(false);
			if (!parsed.success) {
				expect(parsed.error.issues).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							path: ["recipients", 0, "kind"],
							message: expect.stringContaining(
								"applies these filters only to recipients that resolve to user accounts",
							),
						}),
					]),
				);
			}
		}

		expect(
			automationSchema.safeParse({
				...alert,
				recipients: [{ uuid: testUuid("filtered-owner"), kind: "owner" }],
				userDataFilters: [filter],
			}).success,
		).toBe(true);
	});

	it("refuses values and HTML-form shapes CommCare HQ would rewrite or reject", () => {
		const invalidValues = ["", "   ", " 'active' ", '"active"'];
		for (const value of invalidValues) {
			expect(
				automationSchema.safeParse({
					...claimCleanup(),
					criteria: [
						{
							uuid: CRITERION_UUID,
							kind: "match-property",
							scope: "case",
							property: "status",
							matchType: "equal",
							value,
						},
					],
				}).success,
			).toBe(false);
			expect(
				automationSchema.safeParse({
					...claimCleanup(),
					updates: [
						{
							uuid: testUuid(`invalid-literal-${value}`),
							target: { scope: "case", property: "status" },
							value: { kind: "literal", value },
						},
					],
				}).success,
			).toBe(false);
		}
		expect(
			automationSchema.safeParse({
				...claimCleanup(),
				criteria: [
					{
						uuid: CRITERION_UUID,
						kind: "match-property",
						scope: "case",
						property: "status",
						matchType: "regex",
						value: "",
					},
				],
			}).success,
		).toBe(false);

		const closedParent = (suffix: string) => ({
			uuid: testUuid(`closed-parent-${suffix}`),
			kind: "closed-parent" as const,
		});
		expect(
			automationSchema.safeParse({
				...claimCleanup(),
				criteria: [closedParent("one"), closedParent("two")],
			}).success,
		).toBe(false);
		expect(
			automationSchema.safeParse({
				...claimCleanup(),
				criteria: [
					{
						...closedParent("legacy"),
						identifier: "host",
						relationship: "extension",
					},
				],
			}).success,
		).toBe(false);
	});

	it("refuses unsupported Connect recipients and timed reset modes", () => {
		const connect = alertWithSchedule({
			kind: "immediate",
			events: [
				{
					uuid: testUuid("connect-event"),
					minutesToWait: 0,
					content: {
						kind: "connect-message",
						message: automationMessageText("Hello"),
					},
				},
			],
		});
		expect(automationSchema.safeParse(connect).success).toBe(false);
		expect(
			automationSchema.safeParse({
				...connect,
				recipients: [{ uuid: testUuid("connect-owner"), kind: "owner" }],
			}).success,
		).toBe(true);
		expect(
			automationSchema.safeParse({
				...connect,
				recipients: [
					{
						uuid: testUuid("removed-web-user"),
						kind: "web-user",
						hqId: "web-user-id",
					},
				],
			}).success,
		).toBe(false);

		const timed = alertWithSchedule({
			kind: "timed",
			repeatEvery: 1,
			totalIterations: 1,
			startOffsetDays: 0,
			startDayOfWeek: -1,
			start: { kind: "case-property", property: "date_opened" },
			events: [
				{
					uuid: testUuid("reset-timed-event"),
					day: 0,
					timing: { kind: "specific-time", time: "09:00" },
					content: { kind: "sms", message: automationMessageText("Hello") },
				},
			],
		});
		expect(
			automationSchema.safeParse({
				...timed,
				resetCaseProperty: "state",
			}).success,
		).toBe(false);
	});

	it("regenerates exact plan, route, cadence, threshold, and non-execution guidance", () => {
		const guide = buildAutomationSetupGuide(
			buildDoc({ appName: "Claims" }),
			claimCleanup(),
			[],
		);
		const text = [...guide.steps, ...guide.caveats].join(" ");
		expect(guide.requiredPlan).toBe("Data Cleanup (Pro or higher)");
		expect(text).toContain("/a/<domain>/data/edit/automatic_updates/");
		expect(text).toContain("Data → Edit Data → Automatic Case Update Rules");
		expect(text).toContain("10,000 updates");
		expect(text).toContain("checks the threshold between cases");
		expect(text).toContain("final total can exceed the threshold");
		expect(text).not.toContain("at most 10,000");
		expect(text).toContain("once daily");
		expect(text).toContain("does not run this automation in Preview");
		expect(text).toContain("RUN_AUTO_CASE_UPDATES_ON_SAVE");
		expect(text).toContain("project-wide");
		expect(text).not.toContain("50,000");
		for (const path of [
			"content/docs/automations.mdx",
			"docs/plans/complex-app-plan.md",
			"docs/research/advanced-case-actions.md",
		]) {
			const source = readFileSync(path, "utf8");
			expect(source, path).toMatch(/between cases|before the next case/);
			expect(source, path).toMatch(/can exceed|may carry the total above/);
			expect(source, path).not.toMatch(/at most 10,000|default cap/);
		}
		const publicDocs = readFileSync("content/docs/automations.mdx", "utf8");
		expect(publicDocs).not.toMatch(/\bcap\b/i);
		expect(publicDocs).not.toContain("\u2014");
		for (const path of [
			"content/docs/automations.mdx",
			"docs/plans/complex-app-plan.md",
			"docs/research/advanced-case-actions.md",
			"docs/research/commcare-locations.md",
		]) {
			const source = readFileSync(path, "utf8");
			expect(source, path).not.toMatch(
				/50(?:,000|k)\s+updates?\s*\/\s*day\s+cap/i,
			);
		}

		const projectedUpdate = buildAutomationSetupGuide(
			buildDoc({ appName: "Claims" }),
			{
				...claimCleanup(),
				updates: [
					{
						uuid: testUuid("guide-project-name-update"),
						target: { scope: "case", property: "case_name" },
						value: {
							kind: "case-property",
							source: { scope: "case", property: "last_modified" },
						},
					},
				],
			},
			[],
		).steps.join(" ");
		expect(projectedUpdate).toContain(
			"Update name (app property case_name) to the value of modified_on (app property last_modified)",
		);
	});

	it("warns every host-scoped guide about live extension ambiguity", () => {
		const hostCriterion: Automation = {
			...claimCleanup(),
			criteria: [
				{
					uuid: testUuid("guide-host-criterion"),
					kind: "match-property",
					scope: "host",
					property: "region",
					matchType: "equal",
					value: "north",
				},
			],
		};
		const hostUpdateSource: Automation = {
			...claimCleanup(),
			updates: [
				{
					uuid: testUuid("guide-host-update"),
					target: { scope: "case", property: "region" },
					value: {
						kind: "case-property",
						source: { scope: "host", property: "region" },
					},
				},
			],
		};
		const hostUpdateTarget: Automation = {
			...claimCleanup(),
			updates: [
				{
					uuid: testUuid("guide-host-update-target"),
					target: { scope: "host", property: "region" },
					value: { kind: "literal", value: "north" },
				},
			],
		};
		const hostMessage = alertWithSchedule({
			kind: "immediate",
			events: [
				{
					uuid: testUuid("guide-host-message-event"),
					minutesToWait: 0,
					content: {
						kind: "sms",
						message: {
							parts: [
								{
									kind: "case-property",
									scope: "host",
									caseType: "household",
									property: "region",
								},
							],
						},
					},
				},
			],
		});
		for (const automation of [
			hostCriterion,
			hostUpdateSource,
			hostUpdateTarget,
			hostMessage,
		]) {
			const caveats = buildAutomationSetupGuide(
				buildDoc({ appName: "Host reads" }),
				automation,
				[],
			).caveats.join(" ");
			expect(caveats).toContain(
				"Every host-scoped reference requires exactly one live extension at runtime",
			);
			expect(caveats).toContain(
				"Retained extra extension indices leave CommCare HQ's host choice undefined",
			);
			expect(caveats).toContain(
				"extra indices also make the case count unavailable",
			);
		}
		expect(
			buildAutomationSetupGuide(
				buildDoc({ appName: "No host read" }),
				claimCleanup(),
				[],
			).caveats.join(" "),
		).not.toContain("exactly one live extension");
	});

	it("renders date comparisons in the exact HQ current-date algebra", () => {
		const rule: Extract<Automation, { kind: "case-update" }> = {
			...claimCleanup(),
			criteria: [
				{
					uuid: testUuid("guide-date-lt"),
					kind: "match-property",
					scope: "case",
					property: "due_lt",
					matchType: "date-days-before",
					days: 5,
				},
				{
					uuid: testUuid("guide-date-lte"),
					kind: "match-property",
					scope: "case",
					property: "due_lte",
					matchType: "date-days-lte",
					days: -2,
				},
				{
					uuid: testUuid("guide-date-gt"),
					kind: "match-property",
					scope: "case",
					property: "due_gt",
					matchType: "date-days-gt",
					days: 0,
				},
				{
					uuid: testUuid("guide-date-gte"),
					kind: "match-property",
					scope: "case",
					property: "due_gte",
					matchType: "date-days",
					days: 7,
				},
			],
		};
		const text = buildAutomationSetupGuide(
			buildDoc({ appName: "Dates" }),
			rule,
			[],
		).steps.join(" ");
		expect(text).toContain(
			"Current date is less than the date in case property due_lt plus 5 days.",
		);
		expect(text).toContain(
			"Current date is less than or equal to the date in case property due_lte minus 2 days.",
		);
		expect(text).toContain(
			"Current date is greater than the date in case property due_gt.",
		);
		expect(text).toContain(
			"Current date is greater than or equal to the date in case property due_gte plus 7 days.",
		);
	});

	it("renders every survey, message, location, language, and filter setting", () => {
		const doc = buildDoc({
			appName: "Alerts",
			modules: [
				{
					name: "Visits",
					forms: [{ name: "Follow up", type: "survey" }],
				},
			],
		}) as BlueprintDoc;
		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
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
					uuid: testUuid("alert-property-criterion"),
					kind: "match-property",
					scope: "case",
					property: "case_name",
					matchType: "has-value",
				},
			],
			setupOnlyCriteria: [],
			recipients: [
				{ uuid: testUuid("alert-owner"), kind: "owner" },
				{
					uuid: testUuid("alert-location"),
					kind: "location",
					locationUuid: testUuid("alert-location-target"),
				},
			],
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
				],
			},
			includeDescendantLocations: true,
			locationLevelUuids: [levelUuid],
			defaultLanguageCode: "fr",
			userDataFilters: [],
			useUserCaseForFilter: false,
		};
		const guide = buildAutomationSetupGuide(doc, alert, []);
		const emailGuide = buildAutomationSetupGuide(
			doc,
			{
				...alert,
				uuid: testUuid("complete-email-alert"),
				schedule: {
					kind: "immediate",
					events: [
						{
							uuid: testUuid("email-event"),
							minutesToWait: 0,
							content: {
								kind: "email",
								subject: {
									parts: [
										{ kind: "text", text: "Visit due for " },
										{
											kind: "case-property",
											scope: "case",
											caseType: "visit",
											property: "case_name",
										},
									],
								},
								body: {
									kind: "rich-text",
									html: {
										parts: [
											{ kind: "text", text: "<p>Opened " },
											{
												kind: "case-property",
												scope: "case",
												caseType: "visit",
												property: "date_opened",
											},
											{ kind: "text", text: "</p>" },
										],
									},
								},
							},
						},
					],
				},
			},
			[],
		);
		const text = [...guide.steps, ...emailGuide.steps].join(" ");
		expect(text).toContain("/a/<domain>/messaging/conditional/");
		expect(text).toContain(
			"Case property name (app property case_name) has a value",
		);
		expect(guide.steps).toContain("Set Status to Active.");
		expect(text).toContain("Choose Immediately");
		expect(text).toContain(
			"published form path “Alerts > Visits > Follow up” in HQ’s form picker",
		);
		expect(text).not.toContain(formUuid);
		expect(text).toContain("expire after 72 hour(s)");
		expect(text).toContain("30, 60 minute(s)");
		expect(text).toContain("submit partially completed forms on");
		expect(text).toContain("{case.name}");
		expect(text).toContain('HTML source "<p>Opened {case.opened_on}</p>"');
		expect(emailGuide.caveats.join(" ")).toContain(
			"sanitizes the submitted HTML",
		);
		expect(guide.caveats.join(" ")).toContain("Inbound SMS access");
		expect(guide.caveats.join(" ")).toContain("Outbound SMS is still required");
		expect(text).toContain("Include descendant locations");
		expect(text).toContain("District");
		expect(text).toContain("Choose fr in the required Default language field");
		expect(text).toContain(
			"Configure fr as a language in the target CommCare HQ project first",
		);
		expect(text).toContain("Add no custom-user-data recipient filters");

		const projectDefaultGuide = buildAutomationSetupGuide(
			doc,
			{ ...alert, defaultLanguageCode: undefined },
			[],
		).steps.join(" ");
		expect(projectDefaultGuide).toContain(
			"Choose Project Default in the required Default language field",
		);
		expect(projectDefaultGuide).not.toContain(
			"Leave the default language blank",
		);

		const connectGuide = buildAutomationSetupGuide(
			doc,
			{
				...alert,
				uuid: testUuid("connect-prerequisite-alert"),
				recipients: [
					{ uuid: testUuid("connect-prerequisite-owner"), kind: "owner" },
				],
				schedule: {
					kind: "immediate",
					events: [
						{
							uuid: testUuid("connect-prerequisite-event"),
							minutesToWait: 0,
							content: {
								kind: "connect-message",
								message: automationMessageText("Visit due"),
							},
						},
					],
				},
			},
			[],
		).caveats.join(" ");
		expect(connectGuide).toContain("COMMCARE_CONNECT");
		expect(connectGuide).toContain("CommCare mobile worker (CommCareUser)");
		expect(connectGuide).toContain("active PersonalID link");

		const customHandlerGuide = buildAutomationSetupGuide(
			doc,
			{
				...alert,
				uuid: testUuid("custom-handler-alert"),
				recipients: [
					...alert.recipients,
					{
						uuid: testUuid("custom-handler-recipient"),
						kind: "custom",
						registeredId: "nova_custom_recipient",
					},
				],
				schedule: {
					kind: "immediate",
					events: [
						{
							uuid: testUuid("custom-handler-event"),
							minutesToWait: 0,
							content: {
								kind: "custom",
								registeredId: "nova_custom_content",
							},
						},
					],
				},
			},
			[],
		).caveats.join(" ");
		expect(customHandlerGuide).toContain(
			"requires a system administrator to save an alert",
		);
		expect(customHandlerGuide).toContain(
			"A project administrator cannot complete this setup alone",
		);

		const delayed = buildAutomationSetupGuide(
			doc,
			{
				...alert,
				uuid: testUuid("delayed-immediate-alert"),
				schedule: {
					kind: "immediate",
					events: [
						{
							uuid: testUuid("delayed-immediate-event"),
							minutesToWait: 5,
							content: {
								kind: "sms",
								message: automationMessageText("Later"),
							},
						},
					],
				},
			},
			[],
		).steps.join(" ");
		expect(delayed).toContain("Choose Custom Immediate Schedule");
	});

	it("renders exact recipient-filter JSON and every HQ-only prerequisite", () => {
		const doc = buildDoc({
			appName: "Filtered alerts",
			caseTypes: [
				{
					name: "visit",
					properties: [
						{ name: "case_color", label: "Case color", data_type: "text" },
					],
				},
			],
		}) as BlueprintDoc;
		const roleUuid = testUuid("guide-filter-role");
		const teamUuid = testUuid("guide-filter-team");
		doc.userProperties = {
			[roleUuid]: { uuid: roleUuid, slug: "role", label: "Role" },
			[teamUuid]: { uuid: teamUuid, slug: "team", label: "Team" },
		};
		doc.userPropertyOrder = [roleUuid, teamUuid];
		const base = alertWithSchedule({
			kind: "immediate",
			events: [
				{
					uuid: testUuid("guide-filter-event"),
					minutesToWait: 0,
					content: { kind: "sms", message: automationMessageText("Hello") },
				},
			],
		});
		base.recipients = [{ uuid: testUuid("guide-filter-owner"), kind: "owner" }];
		const complex: Extract<Automation, { kind: "conditional-alert" }> = {
			...base,
			setupOnlyCriteria: [
				{
					uuid: testUuid("guide-ucr-filter"),
					kind: "ucr-filter",
					text: "Cases in the overdue-visits report",
				},
				{
					uuid: testUuid("guide-custom-filter"),
					kind: "registered-custom",
					text: "registered_eligibility_filter",
				},
			],
			userDataFilters: [
				{
					uuid: testUuid("guide-role-filter"),
					userPropertyUuid: roleUuid,
					values: [
						{ kind: "literal", value: "yes" },
						{ kind: "literal", value: "" },
					],
				},
				{
					uuid: testUuid("guide-team-filter"),
					userPropertyUuid: teamUuid,
					values: [
						{ kind: "literal", value: "  north  " },
						{
							kind: "case-property",
							caseType: "visit",
							property: "case_color",
						},
					],
				},
			],
		};
		const guide = buildAutomationSetupGuide(doc, complex, []);
		const steps = guide.steps.join("\n");
		const caveats = guide.caveats.join("\n");
		expect(steps).toContain('"role": [\n    "yes",\n    ""\n  ]');
		expect(steps).toContain(
			'"team": [\n    "  north  ",\n    "{case_color}"\n  ]',
		);
		expect(steps).toContain("select “JSON”");
		expect(steps).toContain("User-configurable report (UCR) filter 1");
		expect(steps).toContain("Registered custom criterion 2");
		expect(caveats).toContain("CASE_UPDATES_UCR_FILTERS");
		expect(caveats).toContain("registered custom criterion");
		expect(caveats).toContain(
			"JSON recipient-filter mode only to system administrators",
		);
		expect(caveats).toContain(
			"evaluates recipient filters only for contacts that resolve to CommCare user accounts",
		);
		expect(caveats).toContain(
			"Every triggering case must contain case property case_color",
		);
		expect(caveats).toContain(
			"it cannot run the filter when a property is missing",
		);

		const simple = buildAutomationSetupGuide(
			doc,
			{
				...base,
				userDataFilters: [
					{
						uuid: testUuid("guide-simple-filter"),
						userPropertyUuid: roleUuid,
						values: [{ kind: "literal", value: "yes" }],
					},
				],
			},
			[],
		);
		expect(simple.steps.join(" ")).toContain(
			'property name to "role" and property value to "yes"',
		);
		expect(simple.steps.join(" ")).not.toContain("select “JSON”");
		expect(simple.caveats.join(" ")).not.toContain(
			"JSON recipient-filter mode",
		);

		const unset = buildAutomationSetupGuide(
			doc,
			{
				...base,
				userDataFilters: [
					{
						uuid: testUuid("guide-unset-filter"),
						userPropertyUuid: roleUuid,
						values: [{ kind: "literal", value: "" }],
					},
				],
			},
			[],
		);
		expect(unset.steps.join("\n")).toContain('"role": [\n    ""\n  ]');
		expect(unset.steps.join(" ")).toContain("select “JSON”");
	});

	it("projects stored timed days into the exact HQ setup form values", () => {
		const customDaily = alertWithSchedule({
			kind: "timed",
			repeatEvery: 1,
			totalIterations: 1,
			startOffsetDays: 0,
			startDayOfWeek: -1,
			start: { kind: "case-property", property: "date_opened" },
			events: [
				{
					uuid: testUuid("guide-custom-event"),
					day: 0,
					timing: { kind: "specific-time", time: "09:00" },
					content: { kind: "sms", message: automationMessageText("Hello") },
				},
			],
		});
		const customText = buildAutomationSetupGuide(
			buildDoc({ appName: "Guide" }),
			customDaily,
			[],
		).steps.join(" ");
		expect(customText).toContain("Choose Custom Daily Schedule");
		expect(customText).toContain(
			"date in case property opened_on (app property date_opened)",
		);
		expect(customText).toContain("day 1 in the HQ editor");
		expect(customText).not.toContain("day 0");
		if (customDaily.schedule.kind !== "timed") {
			throw new Error("expected timed schedule");
		}

		const propertyTimeText = buildAutomationSetupGuide(
			buildDoc({ appName: "Property-time guide" }),
			{
				...customDaily,
				uuid: testUuid("guide-property-time-alert"),
				schedule: {
					...customDaily.schedule,
					events: customDaily.schedule.events.map((event) => ({
						...event,
						uuid: testUuid("guide-property-time-event"),
						timing: {
							kind: "case-property-time" as const,
							property: "preferred_time",
						},
					})),
				},
			},
			[],
		).steps.join(" ");
		expect(propertyTimeText).toContain("must start with H:MM or HH:MM");
		expect(propertyTimeText).toContain("AM, PM, and seconds are accepted");
		expect(propertyTimeText).toContain(
			"blank or unrecognized values use 12:00 PM",
		);
		const fixedCustomDaily = automationSchema.parse(
			alertWithSchedule({
				kind: "timed",
				repeatEvery: 1,
				totalIterations: 1,
				startOffsetDays: 0,
				startDayOfWeek: -1,
				start: { kind: "specific-date", date: "2026-08-05" },
				events: [
					{
						uuid: testUuid("guide-fixed-custom-event"),
						day: 0,
						timing: { kind: "specific-time", time: "09:00" },
						content: {
							kind: "sms",
							message: automationMessageText("Hello"),
						},
					},
				],
			}),
		);
		const fixedCustomText = buildAutomationSetupGuide(
			buildDoc({ appName: "Fixed custom guide" }),
			fixedCustomDaily,
			[],
		).steps.join(" ");
		expect(fixedCustomText).toContain(
			"starting from the specific date 2026-08-05",
		);
		expect(fixedCustomText).toContain(
			"does not show a separate Begin/start-offset control",
		);
		expect(fixedCustomText).not.toContain("0-day start offset");

		const fixedWeekly = automationSchema.parse(
			alertWithSchedule({
				kind: "timed",
				repeatEvery: 7,
				totalIterations: 1,
				startOffsetDays: 0,
				startDayOfWeek: 2,
				start: { kind: "specific-date", date: "2026-08-05" },
				events: [
					{
						uuid: testUuid("guide-fixed-weekly-event"),
						day: 0,
						timing: { kind: "specific-time", time: "09:00" },
						content: {
							kind: "sms",
							message: automationMessageText("Hello"),
						},
					},
				],
			}),
		);
		const fixedWeeklyText = buildAutomationSetupGuide(
			buildDoc({ appName: "Fixed weekly guide" }),
			fixedWeekly,
			[],
		).steps.join(" ");
		expect(fixedWeeklyText).toContain(
			"derives the schedule week's first weekday from that date as Wednesday",
		);
		expect(fixedWeeklyText).not.toContain("begin the schedule week");
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

	it("enforces HQ survey reminder and partial-submission dependencies", () => {
		const surveyContent = {
			kind: "sms-survey" as const,
			formUuid: testUuid("survey-validity-form"),
			expirationHours: 1,
			reminderIntervalsMinutes: [30, 30],
			submitPartiallyCompletedForms: true,
			includeCaseUpdatesInPartialSubmissions: true,
		};
		const withContent = (content: typeof surveyContent) =>
			alertWithSchedule({
				kind: "immediate",
				events: [
					{
						uuid: testUuid("survey-validity-event"),
						minutesToWait: 0,
						content,
					},
				],
			});
		expect(automationSchema.safeParse(withContent(surveyContent)).success).toBe(
			false,
		);
		expect(
			automationSchema.safeParse(
				withContent({
					...surveyContent,
					reminderIntervalsMinutes: [59],
					submitPartiallyCompletedForms: false,
					includeCaseUpdatesInPartialSubmissions: true,
				}),
			).success,
		).toBe(false);
		expect(
			automationSchema.safeParse(
				withContent({
					...surveyContent,
					reminderIntervalsMinutes: [59],
				}),
			).success,
		).toBe(true);
	});

	it("enforces HQ immediate and custom-daily event timing", () => {
		const immediate = alertWithSchedule({
			kind: "immediate",
			events: [
				{
					uuid: testUuid("immediate-first"),
					minutesToWait: 0,
					content: { kind: "sms", message: automationMessageText("First") },
				},
				{
					uuid: testUuid("immediate-second"),
					minutesToWait: 4,
					content: { kind: "sms", message: automationMessageText("Second") },
				},
			],
		});
		expect(automationSchema.safeParse(immediate).success).toBe(false);
		expect(
			automationSchema.safeParse({
				...immediate,
				schedule: {
					...immediate.schedule,
					events: immediate.schedule.events.map((event, index) =>
						index === 1
							? {
									...event,
									minutesToWait: 5,
									content: {
										kind: "email" as const,
										subject: automationMessageText("Different mode"),
										body: {
											kind: "plain-text" as const,
											message: automationMessageText("Second"),
										},
									},
								}
							: event,
					),
				},
			}).success,
		).toBe(false);

		const timed = alertWithSchedule({
			kind: "timed",
			repeatEvery: 2,
			totalIterations: -1,
			startOffsetDays: 0,
			startDayOfWeek: -1,
			start: { kind: "rule-trigger" },
			events: [
				{
					uuid: testUuid("timed-first"),
					day: 0,
					timing: {
						kind: "random-window",
						time: "09:00",
						windowMinutes: 60,
					},
					content: { kind: "sms", message: automationMessageText("First") },
				},
				{
					uuid: testUuid("timed-second"),
					day: 0,
					timing: {
						kind: "random-window",
						time: "09:30",
						windowMinutes: 30,
					},
					content: {
						kind: "email",
						subject: automationMessageText("Next"),
						body: {
							kind: "plain-text",
							message: automationMessageText("Second"),
						},
					},
				},
			],
		});
		expect(automationSchema.safeParse(timed).success).toBe(false);
		expect(
			automationSchema.safeParse({
				...timed,
				schedule: {
					...timed.schedule,
					events: timed.schedule.events.map((event, index) =>
						index === 1
							? {
									...event,
									content: {
										kind: "sms" as const,
										message: automationMessageText("Second"),
									},
									timing: {
										kind: "random-window" as const,
										time: "10:00",
										windowMinutes: 30,
									},
								}
							: event,
					),
				},
			}).success,
		).toBe(true);
	});

	it("accepts only timed schedules that map to one HQ setup form", () => {
		const sharedContent = {
			kind: "sms" as const,
			message: automationMessageText("Monthly"),
		};
		const monthly = alertWithSchedule({
			kind: "timed",
			repeatEvery: -1,
			totalIterations: -1,
			startOffsetDays: 0,
			startDayOfWeek: -1,
			start: { kind: "rule-trigger" },
			events: [
				{
					uuid: testUuid("monthly-first"),
					day: 28,
					timing: { kind: "specific-time", time: "09:00" },
					content: sharedContent,
				},
				{
					uuid: testUuid("monthly-last"),
					day: -1,
					timing: { kind: "specific-time", time: "09:00" },
					content: sharedContent,
				},
			],
		});
		expect(automationSchema.safeParse(monthly).success).toBe(true);
		expect(
			automationSchema.safeParse({
				...monthly,
				schedule: {
					...monthly.schedule,
					events: [
						{
							...monthly.schedule.events[0],
							day: 29,
						},
					],
				},
			}).success,
		).toBe(false);
		expect(
			automationSchema.safeParse({
				...monthly,
				schedule: { ...monthly.schedule, startOffsetDays: 1 },
			}).success,
		).toBe(false);
	});

	it("admits only the regex subset shared by Python and PostgreSQL", () => {
		expect(isPortableAutomationRegex("^A[0-9]+(?:-B)?$")).toBe(false);
		expect(isPortableAutomationRegex("^A[0-9]+(-B)?$")).toBe(true);
		expect(isPortableAutomationRegex("(?<code>A+)")).toBe(false);
		expect(isPortableAutomationRegex("\\d+")).toBe(false);
		expect(isPortableAutomationRegex("[]")).toBe(false);
		expect(isPortableAutomationRegex("[^]")).toBe(false);
		expect(isPortableAutomationRegex("a{255}")).toBe(true);
		expect(isPortableAutomationRegex("a{1,255}")).toBe(true);
		expect(isPortableAutomationRegex("a{1,}")).toBe(true);
		expect(isPortableAutomationRegex("a{256}")).toBe(false);
		expect(isPortableAutomationRegex("a{255,256}")).toBe(false);
		expect(isPortableAutomationRegex("a{,3}")).toBe(false);
		expect(isPortableAutomationRegex("a{1")).toBe(false);
		expect(isPortableAutomationRegex("[[.a.]]")).toBe(false);
		expect(isPortableAutomationRegex("[[=a=]]")).toBe(false);
	});

	it("enforces upstream string bounds and persistable JSON integers", () => {
		for (const name of ["   ", " Surrounding space", "Trailing space "]) {
			expect(
				automationSchema.safeParse({ ...claimCleanup(), name }).success,
			).toBe(false);
		}
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
						scope: "case",
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
						scope: "case",
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
