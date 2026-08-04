import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { automationFormChoices } from "@/lib/automations/formChoices";
import { automationMatchProjection } from "@/lib/automations/matching";
import { buildAutomationSetupGuide } from "@/lib/automations/setupGuidance";
import {
	type Automation,
	type AutomationSchedule,
	automationSchema,
	type BlueprintDoc,
	isPortableAutomationRegex,
} from "@/lib/domain";

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
						subject: "Visit due",
						body: { kind: "plain-text", message: "Please attend" },
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
								subject: "Visit due",
								body: {
									kind: "rich-text" as const,
									html: "<p>Please attend</p>",
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
								subject: " Padded ",
								body: {
									kind: "plain-text" as const,
									message: " Body ",
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
				{ uuid: SETUP_UUID, text: "UCR filter: stale_claims" },
			],
		};
		const projection = automationMatchProjection(doc, rule);
		expect(projection.countArgs.automationCriteria).toBeUndefined();
		expect(projection.omittedCriteria).toEqual([
			"UCR filter: stale_claims",
			"HQ server-modified age of at least 30 days",
		]);
		expect(projection.countArgs.predicate).toMatchObject({ kind: "eq" });
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
		expect(projection.countArgs.automationCriteria?.predicate).toBeDefined();

		const alert = alertWithSchedule({
			kind: "immediate",
			events: [
				{
					uuid: testUuid("criteria-matrix-event"),
					minutesToWait: 0,
					content: { kind: "sms", message: "Hello" },
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

	it("keeps alert recipients and filters in one representable HQ form shape", () => {
		const alert = alertWithSchedule({
			kind: "immediate",
			events: [
				{
					uuid: testUuid("recipient-shape-event"),
					minutesToWait: 0,
					content: { kind: "sms", message: "Hello" },
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
						allowedValues: ["a"],
					},
					{
						uuid: testUuid("recipient-filter-b"),
						userPropertyUuid,
						allowedValues: ["b"],
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
					content: { kind: "connect-message", message: "Hello" },
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
					content: { kind: "sms", message: "Hello" },
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

	it("regenerates exact plan, route, cadence, cap, and non-execution guidance", () => {
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
		expect(text).toContain("once daily");
		expect(text).toContain("does not run this automation in Preview");
		expect(text).toContain("RUN_AUTO_CASE_UPDATES_ON_SAVE");
		expect(text).toContain("project-wide");
		expect(text).not.toContain("50,000");

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
			"Update name (Nova property case_name) to the value of modified_on (Nova property last_modified)",
		);
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
								subject: "Visit due for {case.case_name}",
								body: {
									kind: "rich-text",
									html: "<p>Opened {case.date_opened}</p>",
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
			"Case property name (Nova property case_name) has a value",
		);
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
							content: { kind: "sms", message: "Later" },
						},
					],
				},
			},
			[],
		).steps.join(" ");
		expect(delayed).toContain("Choose Custom Immediate Schedule");
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
					content: { kind: "sms", message: "Hello" },
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
			"date in case property opened_on (Nova property date_opened)",
		);
		expect(customText).toContain("day 1 in the HQ editor");
		expect(customText).not.toContain("day 0");
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
					content: { kind: "sms", message: "First" },
				},
				{
					uuid: testUuid("immediate-second"),
					minutesToWait: 4,
					content: { kind: "sms", message: "Second" },
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
										subject: "Different mode",
										body: { kind: "plain-text" as const, message: "Second" },
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
					content: { kind: "sms", message: "First" },
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
						subject: "Next",
						body: { kind: "plain-text", message: "Second" },
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
									content: { kind: "sms" as const, message: "Second" },
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
		const sharedContent = { kind: "sms" as const, message: "Monthly" };
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
