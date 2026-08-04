// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	focusElement,
	settleBaseUiTransitions,
} from "@/__tests__/helpers/baseUiInteractions";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { AutomationFormChoice } from "@/lib/automations/formChoices";
import type { Automation, Uuid } from "@/lib/domain";
import type { StoredLocation } from "@/lib/organization/types";

const RULE_UUID = testUuid("ui-automation");
const UPDATE_UUID = testUuid("ui-automation-update");
const rule: Automation = {
	uuid: RULE_UUID,
	kind: "case-update",
	name: "Close resolved visits",
	caseType: "visit",
	criteriaOperator: "all",
	criteria: [],
	setupOnlyCriteria: [],
	updates: [
		{
			uuid: UPDATE_UUID,
			target: { scope: "case", property: "state" },
			value: { kind: "literal", value: "resolved" },
		},
	],
	closeCase: true,
};

const surveyAlert = {
	uuid: testUuid("ui-survey-alert"),
	kind: "conditional-alert",
	name: "Survey follow-up",
	caseType: "visit",
	criteriaOperator: "all",
	criteria: [],
	setupOnlyCriteria: [],
	recipients: [{ uuid: testUuid("ui-survey-recipient"), kind: "self" }],
	schedule: {
		kind: "immediate",
		events: [
			{
				uuid: testUuid("ui-survey-event"),
				minutesToWait: 0,
				content: {
					kind: "sms-survey",
					formUuid: testUuid("ui-survey-form"),
					expirationHours: 1,
					reminderIntervalsMinutes: [30],
					submitPartiallyCompletedForms: false,
					includeCaseUpdatesInPartialSubmissions: false,
				},
			},
		],
	},
	includeDescendantLocations: false,
	locationLevelUuids: [],
	userDataFilters: [],
	useUserCaseForFilter: false,
} satisfies Extract<Automation, { kind: "conditional-alert" }>;

const USER_PROPERTY_UUID = testUuid("ui-user-property");
const SECOND_USER_PROPERTY_UUID = testUuid("ui-user-property-second");

function repeatedRowsAlert(): Extract<
	Automation,
	{ kind: "conditional-alert" }
> {
	return {
		uuid: testUuid("ui-repeated-alert"),
		kind: "conditional-alert",
		name: "Repeated rows",
		caseType: "visit",
		criteriaOperator: "all",
		criteria: [0, 1].map((index) => ({
			uuid: testUuid(`ui-repeated-condition-${index}`),
			kind: "match-property" as const,
			scope: "case",
			property: `status_${index}`,
			matchType: "has-value" as const,
		})),
		setupOnlyCriteria: [0, 1].map((index) => ({
			uuid: testUuid(`ui-repeated-setup-${index}`),
			text: `HQ condition ${index}`,
		})),
		recipients: [
			{ uuid: testUuid("ui-repeated-recipient-0"), kind: "self" },
			{ uuid: testUuid("ui-repeated-recipient-1"), kind: "owner" },
		],
		schedule: {
			kind: "immediate",
			events: [0, 1].map((index) => ({
				uuid: testUuid(`ui-repeated-event-${index}`),
				minutesToWait: index === 0 ? 0 : 5,
				content: { kind: "sms" as const, message: `Message ${index}` },
			})),
		},
		includeDescendantLocations: false,
		locationLevelUuids: [],
		userDataFilters: [0, 1].map((index) => ({
			uuid: testUuid(`ui-repeated-filter-${index}`),
			userPropertyUuid:
				index === 0 ? USER_PROPERTY_UUID : SECOND_USER_PROPERTY_UUID,
			allowedValues: [`value-${index}`],
		})),
		useUserCaseForFilter: false,
	};
}

function monthlyAlert(): Extract<Automation, { kind: "conditional-alert" }> {
	return {
		...repeatedRowsAlert(),
		uuid: testUuid("ui-monthly-alert"),
		name: "Monthly alert",
		criteria: [],
		setupOnlyCriteria: [],
		recipients: [{ uuid: testUuid("ui-monthly-recipient"), kind: "owner" }],
		userDataFilters: [],
		schedule: {
			kind: "timed",
			repeatEvery: -1,
			totalIterations: 1,
			startOffsetDays: 0,
			startDayOfWeek: -1,
			start: { kind: "rule-trigger" },
			events: [1, 2].map((day) => ({
				uuid: testUuid(`ui-monthly-event-${day}`),
				day,
				timing: { kind: "specific-time" as const, time: "09:00" },
				content: { kind: "sms" as const, message: "Monthly message" },
			})),
		},
	};
}

function fullWeeklyAlert(): Extract<Automation, { kind: "conditional-alert" }> {
	return {
		...monthlyAlert(),
		uuid: testUuid("ui-full-weekly-alert"),
		name: "Full weekly alert",
		schedule: {
			kind: "timed",
			repeatEvery: 7,
			totalIterations: 1,
			startOffsetDays: 0,
			startDayOfWeek: 0,
			start: { kind: "rule-trigger" },
			events: Array.from({ length: 7 }, (_, day) => ({
				uuid: testUuid(`ui-weekly-event-${day}`),
				day,
				timing: { kind: "specific-time" as const, time: "09:00" },
				content: { kind: "sms" as const, message: "Weekly message" },
			})),
		},
	};
}

function weekdayRemapAlert(): Extract<
	Automation,
	{ kind: "conditional-alert" }
> {
	return {
		...monthlyAlert(),
		uuid: testUuid("ui-weekday-remap-alert"),
		name: "Weekday remap alert",
		schedule: {
			kind: "timed",
			repeatEvery: 7,
			totalIterations: 1,
			startOffsetDays: 0,
			startDayOfWeek: 2,
			start: { kind: "rule-trigger" },
			events: [
				{
					uuid: testUuid("ui-weekday-wednesday"),
					day: 0,
					timing: { kind: "specific-time", time: "09:00" },
					content: { kind: "sms", message: "Weekly message" },
				},
				{
					uuid: testUuid("ui-weekday-friday"),
					day: 2,
					timing: { kind: "specific-time", time: "09:00" },
					content: { kind: "sms", message: "Weekly message" },
				},
			],
		},
	};
}

const mocks = vi.hoisted(() => ({
	automations: [] as Automation[],
	forms: [] as AutomationFormChoice[],
	userProperties: [] as { uuid: Uuid; label: string; slug: string }[],
	levels: [] as { uuid: Uuid; name: string }[],
	locations: [] as StoredLocation[],
	canEdit: true,
	addAutomation: vi.fn(() => ({ ok: true, uuid: "new" })),
	replaceAutomation: vi.fn(() => ({ ok: true })),
	removeAutomation: vi.fn(() => ({ ok: true })),
	preview: vi.fn(),
}));

vi.mock("@/lib/automations/actions", () => ({
	previewAutomationAction: (...args: unknown[]) => mocks.preview(...args),
}));
vi.mock("@/lib/doc/hooks/useAutomationCollections", () => ({
	useAutomations: () => mocks.automations,
	useAutomationForms: () => mocks.forms,
}));
vi.mock("@/lib/doc/hooks/useCaseTypes", () => ({
	useEffectiveCaseTypes: () => [
		{
			name: "visit",
			properties: [],
		},
	],
}));
vi.mock("@/lib/doc/hooks/useOrganizationCollections", () => ({
	useOrganizationLevels: () => mocks.levels,
}));
vi.mock("@/lib/doc/hooks/useUserCollections", () => ({
	useUserProperties: () => mocks.userProperties,
}));
vi.mock("@/lib/doc/hooks/useBlueprintMutations", () => ({
	useBlueprintMutations: () => ({
		addAutomation: mocks.addAutomation,
		replaceAutomation: mocks.replaceAutomation,
		removeAutomation: mocks.removeAutomation,
		inline: {
			addAutomation: mocks.addAutomation,
			replaceAutomation: mocks.replaceAutomation,
			removeAutomation: mocks.removeAutomation,
		},
	}),
}));
vi.mock("@/lib/organization/useOrganization", () => ({
	useOrganization: () => ({
		locations: mocks.locations,
		loading: false,
		error: undefined,
		warning: undefined,
		refreshing: false,
		revision: "1",
		reload: vi.fn(),
	}),
}));
vi.mock("@/lib/session/hooks", () => ({
	useAppId: () => "app-automations",
	useCanEdit: () => mocks.canEdit,
}));
vi.mock("@/lib/session/provider", () => ({
	useBuilderSessionApi: () => ({
		getState: () => ({ canEdit: mocks.canEdit }),
	}),
}));

import { AutomationsSection, localIsoDate } from "../AutomationsSection";

async function chooseChoice(label: string, option: string): Promise<void> {
	await chooseFromChoice(screen.getByRole("combobox", { name: label }), option);
}

async function chooseFromChoice(
	choice: HTMLElement,
	option: string,
): Promise<void> {
	fireEvent.click(choice);
	await settleBaseUiTransitions();
	const item = screen.getByRole("option", { name: option });
	fireEvent.pointerDown(item, { pointerType: "mouse" });
	fireEvent.click(item);
	await settleBaseUiTransitions();
}

beforeEach(() => {
	mocks.automations = [];
	mocks.forms = [];
	mocks.userProperties = [];
	mocks.levels = [];
	mocks.locations = [];
	mocks.canEdit = true;
	mocks.addAutomation.mockClear();
	mocks.replaceAutomation.mockClear();
	mocks.removeAutomation.mockClear();
	mocks.preview.mockReset();
	mocks.preview.mockResolvedValue({
		success: true,
		data: {
			automationUuid: RULE_UUID,
			blueprintSeq: 3,
			organizationRevision: "1",
			currentMatchCount: 4,
			omittedCriteria: ["HQ server-modified age of at least 30 days"],
			setupGuide: {
				title: "Close resolved visits",
				requiredPlan: "Data Cleanup (Pro or higher)",
				steps: ["Open the rule editor."],
				caveats: ["Nova does not run this automation in Preview."],
			},
			executesLocally: false,
		},
	});
});

describe("AutomationsSection", () => {
	it("owns an honest empty state and a keyboard-focused add editor", async () => {
		render(<AutomationsSection />);
		expect(screen.getByText(/No automations yet/)).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Add automation" }));
		await settleBaseUiTransitions();
		const name = screen.getByRole("textbox", { name: "Name" });
		expect(document.activeElement).toBe(name);
		expect(
			screen.getByRole("combobox", { name: "Automation type" }),
		).toBeDefined();
		const authoredInputs = document.querySelectorAll(
			'[data-slot="input"], [data-slot="textarea"]',
		);
		expect(authoredInputs.length).toBeGreaterThan(0);
		for (const input of authoredInputs) {
			expect(input.getAttribute("autocomplete")).toBe("off");
			expect(input.hasAttribute("data-1p-ignore")).toBe(true);
		}
		fireEvent.change(name, { target: { value: "Resolve old visits" } });
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));
		expect(mocks.addAutomation).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "case-update",
				name: "Resolve old visits",
				caseType: "visit",
			}),
		);
	});

	it("refuses an invalid draft with human validation copy", async () => {
		render(<AutomationsSection />);
		fireEvent.click(screen.getByRole("button", { name: "Add automation" }));
		await settleBaseUiTransitions();
		fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
			target: { value: "" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));
		expect(screen.getByRole("alert").textContent).toBe(
			"Enter an automation name.",
		);
		fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
			target: { value: "  Padded name  " },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));
		expect(screen.getByRole("alert").textContent).toBe(
			"Enter a nonblank automation name without surrounding whitespace.",
		);
		expect(mocks.addAutomation).not.toHaveBeenCalled();
	});

	it("allows more property conditions but only one closed-parent condition", () => {
		render(<AutomationsSection />);
		fireEvent.click(screen.getByRole("button", { name: "Add automation" }));
		const propertyButton = screen.getByRole("button", {
			name: "Property condition",
		});
		const closedParentButton = screen.getByRole("button", {
			name: "Closed parent",
		});

		fireEvent.click(closedParentButton);

		expect(propertyButton.hasAttribute("disabled")).toBe(false);
		expect(closedParentButton.hasAttribute("disabled")).toBe(true);
		expect(screen.getByText(/standard parent link/i)).toBeDefined();
	});

	it("offers only the current HQ criteria for each automation kind", async () => {
		render(<AutomationsSection />);
		fireEvent.click(screen.getByRole("button", { name: "Add automation" }));
		await settleBaseUiTransitions();
		fireEvent.click(screen.getByRole("button", { name: "Property condition" }));
		await chooseChoice("Case source", "Parent case");
		expect(
			screen.getByRole("combobox", { name: "Case source" }).textContent,
		).toContain("Parent case");
		fireEvent.click(screen.getByRole("combobox", { name: "Comparison" }));
		await settleBaseUiTransitions();
		expect(
			screen.getByRole("option", {
				name: "Current date < property date + offset",
			}),
		).toBeDefined();
		expect(
			screen.queryByRole("option", { name: "Matches regular expression" }),
		).toBeNull();
		fireEvent.keyDown(document.activeElement ?? document.body, {
			key: "Escape",
		});
		await settleBaseUiTransitions();

		await chooseChoice("Automation type", "Conditional alert");
		fireEvent.click(screen.getByRole("button", { name: "Property condition" }));
		fireEvent.click(screen.getByRole("combobox", { name: "Comparison" }));
		await settleBaseUiTransitions();
		expect(
			screen.getByRole("option", { name: "Matches regular expression" }),
		).toBeDefined();
		expect(
			screen.queryByRole("option", {
				name: "Current date < property date + offset",
			}),
		).toBeNull();
		expect(screen.queryByRole("button", { name: "Closed parent" })).toBeNull();
		expect(screen.queryByText(/last changed on the server/i)).toBeNull();
	});

	it("authors one explicit HQ email form and explains rich-text sanitization", async () => {
		render(<AutomationsSection />);
		fireEvent.click(screen.getByRole("button", { name: "Add automation" }));
		await settleBaseUiTransitions();
		await chooseChoice("Automation type", "Conditional alert");
		await chooseChoice("Schedule content type", "Email");

		expect(
			screen.getByRole("combobox", { name: "Email body form" }).textContent,
		).toContain("Plain text");
		expect(screen.getByText(/Rich text emails is not enabled/)).toBeDefined();
		expect(
			screen.getByRole("textbox", { name: "Plain-text message" }),
		).toBeDefined();

		await chooseChoice("Email body form", "Rich text HTML");
		expect(
			screen.queryByRole("textbox", { name: "Plain-text message" }),
		).toBeNull();
		const html = screen.getByRole("textbox", {
			name: "Rich-text HTML source",
		});
		expect(
			screen.getByText(/HQ removes unsupported markup and CSS/),
		).toBeDefined();
		fireEvent.change(html, { target: { value: "<p>Visit due</p>" } });
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));

		expect(mocks.addAutomation).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "conditional-alert",
				schedule: expect.objectContaining({
					events: [
						expect.objectContaining({
							content: {
								kind: "email",
								subject: "Subject",
								body: {
									kind: "rich-text",
									html: "<p>Visit due</p>",
								},
							},
						}),
					],
				}),
			}),
		);
	});

	it("keeps recipients, descendant settings, and worker filters in one HQ form shape", async () => {
		const levelUuid = testUuid("ui-location-level");
		mocks.levels = [{ uuid: levelUuid, name: "Facility level" }];
		mocks.locations = [
			{
				id: testUuid("ui-location"),
				levelUuid,
				parentId: null,
				siteCode: "facility-a",
				name: "Facility A",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
				archivedAt: null,
				orderKey: "a0",
			},
		];
		mocks.userProperties = [
			{ uuid: USER_PROPERTY_UUID, label: "Region", slug: "region" },
			{
				uuid: SECOND_USER_PROPERTY_UUID,
				label: "District",
				slug: "district",
			},
		];

		render(<AutomationsSection />);
		fireEvent.click(screen.getByRole("button", { name: "Add automation" }));
		await settleBaseUiTransitions();
		await chooseChoice("Automation type", "Conditional alert");
		expect(
			screen.queryByRole("checkbox", {
				name: "Include descendant locations for location recipients",
			}),
		).toBeNull();

		await chooseChoice("Recipient 1", "Location");
		fireEvent.click(
			screen.getByText("Include descendant locations for location recipients"),
		);
		fireEvent.click(screen.getByText("Facility level"));
		await chooseChoice("Recipient 1", "Case owner");
		expect(screen.queryByText("Facility level")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Recipient" }));
		fireEvent.click(screen.getByRole("button", { name: "Recipient filter" }));
		fireEvent.click(screen.getByRole("button", { name: "Recipient filter" }));
		expect(
			screen.getByRole("button", { name: "Recipient filter" }),
		).toHaveProperty("disabled", true);
		fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
			target: { value: "Reminder" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));

		expect(mocks.addAutomation).toHaveBeenCalledWith(
			expect.objectContaining({
				recipients: [
					expect.objectContaining({ kind: "owner" }),
					expect.objectContaining({ kind: "self" }),
				],
				includeDescendantLocations: false,
				locationLevelUuids: [],
				userDataFilters: [
					expect.objectContaining({ userPropertyUuid: USER_PROPERTY_UUID }),
					expect.objectContaining({
						userPropertyUuid: SECOND_USER_PROPERTY_UUID,
					}),
				],
			}),
		);
	});

	it("requires an entered HQ recipient id instead of saving instruction copy", async () => {
		render(<AutomationsSection />);
		fireEvent.click(screen.getByRole("button", { name: "Add automation" }));
		await settleBaseUiTransitions();
		await chooseChoice("Automation type", "Conditional alert");
		await chooseChoice("Recipient 1", "Mobile worker in CommCare HQ");

		const hqId = screen.getByRole("textbox", { name: "CommCare HQ ID" });
		expect(hqId.getAttribute("value")).toBe("");
		expect(hqId.getAttribute("placeholder")).toBe("Enter the CommCare HQ ID");
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));
		expect(screen.getByRole("alert").textContent).toContain(
			"recipient ID must be nonblank",
		);
		expect(mocks.addAutomation).not.toHaveBeenCalled();

		fireEvent.change(hqId, { target: { value: "worker-1" } });
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));
		expect(mocks.addAutomation).toHaveBeenCalledWith(
			expect.objectContaining({
				recipients: [
					expect.objectContaining({
						kind: "mobile-worker",
						hqId: "worker-1",
					}),
				],
			}),
		);
	});

	it("disambiguates duplicate survey names with their published paths", async () => {
		const firstForm = testUuid("ui-duplicate-survey-first");
		const secondForm = testUuid("ui-duplicate-survey-second");
		mocks.forms = [
			{ uuid: firstForm, label: "Care > Visits > Follow up" },
			{ uuid: secondForm, label: "Care > Referrals > Follow up" },
		];
		mocks.automations = [
			{
				...surveyAlert,
				schedule: {
					...surveyAlert.schedule,
					events: [
						{
							...surveyAlert.schedule.events[0],
							content: {
								...surveyAlert.schedule.events[0].content,
								formUuid: firstForm,
							},
						},
					],
				},
			},
		];

		render(<AutomationsSection />);
		fireEvent.click(screen.getByRole("button", { name: /Survey follow-up/ }));
		await settleBaseUiTransitions();
		fireEvent.click(screen.getByRole("button", { name: "Edit automation" }));
		await settleBaseUiTransitions();
		const formChoice = screen.getByRole("combobox", { name: "Form" });
		expect(formChoice.textContent).toContain("Care > Visits > Follow up");
		fireEvent.click(formChoice);
		await settleBaseUiTransitions();
		expect(
			screen.getByRole("option", { name: "Care > Visits > Follow up" }),
		).toBeDefined();
		expect(
			screen.getByRole("option", { name: "Care > Referrals > Follow up" }),
		).toBeDefined();
	});

	it("keeps survey partial-submission controls valid and explains reminder refusal", async () => {
		mocks.automations = [surveyAlert];
		render(<AutomationsSection />);
		fireEvent.click(screen.getByRole("button", { name: /Survey follow-up/ }));
		await settleBaseUiTransitions();
		fireEvent.click(screen.getByRole("button", { name: "Edit automation" }));
		await settleBaseUiTransitions();
		expect(
			screen.getByText(
				"Leave empty for Project Default. Any code must already be configured in the target HQ project",
			),
		).toBeTruthy();

		const submitPartial = screen.getByRole("checkbox", {
			name: "Submit partially completed forms",
		});
		expect(submitPartial.getAttribute("aria-checked")).toBe("false");
		let includeUpdates = screen.getByRole("checkbox", {
			name: /Include case updates in partial submissions/,
		});
		expect(includeUpdates.getAttribute("aria-disabled")).toBe("true");
		fireEvent.click(screen.getByText("Submit partially completed forms"));
		includeUpdates = screen.getByRole("checkbox", {
			name: /Include case updates in partial submissions/,
		});
		expect(includeUpdates.getAttribute("aria-disabled")).toBeNull();
		fireEvent.click(
			screen.getByText("Include case updates in partial submissions"),
		);
		includeUpdates = screen.getByRole("checkbox", {
			name: /Include case updates in partial submissions/,
		});
		expect(includeUpdates.getAttribute("aria-checked")).toBe("true");
		fireEvent.click(screen.getByText("Submit partially completed forms"));
		includeUpdates = screen.getByRole("checkbox", {
			name: /Include case updates in partial submissions/,
		});
		expect(includeUpdates.getAttribute("aria-checked")).toBe("false");
		expect(includeUpdates.getAttribute("aria-disabled")).toBe("true");

		fireEvent.change(
			screen.getByRole("textbox", {
				name: "Reminder intervals in minutes",
			}),
			{ target: { value: "60" } },
		);
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));
		expect(screen.getByRole("alert").textContent).toContain(
			"Reminder intervals must add up to less than the survey expiration window.",
		);
		expect(mocks.replaceAutomation).not.toHaveBeenCalled();
	});

	it("switches setup forms and clones schedule-wide event values", async () => {
		render(<AutomationsSection />);
		fireEvent.click(screen.getByRole("button", { name: "Add automation" }));
		await settleBaseUiTransitions();

		await chooseChoice("Automation type", "Conditional alert");
		await chooseChoice("Schedule type", "Timed repeating schedule");
		await chooseChoice("CommCare HQ schedule form", "Weekly");
		fireEvent.click(screen.getByRole("button", { name: "Schedule event" }));
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));

		expect(mocks.addAutomation).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: "conditional-alert",
				schedule: expect.objectContaining({
					kind: "timed",
					repeatEvery: 7,
					startDayOfWeek: 0,
					events: [
						expect.objectContaining({ day: 0 }),
						expect.objectContaining({ day: 1 }),
					],
				}),
			}),
		);
	});

	it("keeps monthly and weekly day choices unique, ordered, and bounded", async () => {
		const monthly = monthlyAlert();
		mocks.automations = [monthly];
		render(<AutomationsSection />);
		fireEvent.click(screen.getByRole("button", { name: /Monthly alert/ }));
		await settleBaseUiTransitions();
		fireEvent.click(screen.getByRole("button", { name: "Edit automation" }));
		await settleBaseUiTransitions();

		const dayChoices = screen.getAllByRole("combobox", {
			name: "Day in CommCare HQ schedule",
		});
		fireEvent.click(dayChoices[0]);
		await settleBaseUiTransitions();
		expect(
			screen
				.getByRole("option", { name: "Day 2" })
				.getAttribute("aria-disabled"),
		).toBe("true");
		const lastDay = screen.getByRole("option", {
			name: "Last day of the month",
		});
		fireEvent.pointerDown(lastDay, { pointerType: "mouse" });
		fireEvent.click(lastDay);
		await settleBaseUiTransitions();
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));

		expect(mocks.replaceAutomation).toHaveBeenCalledWith(
			expect.objectContaining({
				schedule: expect.objectContaining({
					events: [
						expect.objectContaining({
							uuid: testUuid("ui-monthly-event-2"),
							day: 2,
						}),
						expect.objectContaining({
							uuid: testUuid("ui-monthly-event-1"),
							day: -1,
						}),
					],
				}),
			}),
			JSON.stringify(monthly),
		);
	});

	it("disables another weekly event when every HQ weekday is selected", async () => {
		mocks.automations = [fullWeeklyAlert()];
		render(<AutomationsSection />);
		fireEvent.click(screen.getByRole("button", { name: /Full weekly alert/ }));
		await settleBaseUiTransitions();
		fireEvent.click(screen.getByRole("button", { name: "Edit automation" }));
		await settleBaseUiTransitions();
		expect(
			screen.getByRole("button", { name: "Schedule event" }),
		).toHaveProperty("disabled", true);
	});

	it("labels weekly offsets as weekdays and preserves them when the start changes", async () => {
		const alert = weekdayRemapAlert();
		mocks.automations = [alert];
		render(<AutomationsSection />);
		fireEvent.click(
			screen.getByRole("button", { name: /Weekday remap alert/ }),
		);
		await settleBaseUiTransitions();
		fireEvent.click(screen.getByRole("button", { name: "Edit automation" }));
		await settleBaseUiTransitions();
		expect(
			screen
				.getAllByRole("combobox", { name: "Day in CommCare HQ schedule" })
				.map((choice) => choice.textContent),
		).toEqual(expect.arrayContaining(["Wednesday", "Friday"]));

		await chooseChoice("Start weekday", "Friday");
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));
		expect(mocks.replaceAutomation).toHaveBeenCalledWith(
			expect.objectContaining({
				schedule: expect.objectContaining({
					startDayOfWeek: 4,
					events: [
						expect.objectContaining({
							uuid: testUuid("ui-weekday-friday"),
							day: 0,
						}),
						expect.objectContaining({
							uuid: testUuid("ui-weekday-wednesday"),
							day: 5,
						}),
					],
				}),
			}),
			JSON.stringify(alert),
		);
	});

	it("sorts a newly added monthly day into canonical order", async () => {
		const monthly = monthlyAlert();
		if (monthly.schedule.kind !== "timed") throw new Error("expected timed");
		const first = monthly.schedule.events[0];
		const second = monthly.schedule.events[1];
		if (first === undefined || second === undefined) throw new Error("events");
		monthly.schedule.events = [
			second,
			{
				...first,
				uuid: testUuid("ui-monthly-last"),
				day: -1,
			},
		];
		mocks.automations = [monthly];
		render(<AutomationsSection />);
		fireEvent.click(screen.getByRole("button", { name: /Monthly alert/ }));
		await settleBaseUiTransitions();
		fireEvent.click(screen.getByRole("button", { name: "Edit automation" }));
		await settleBaseUiTransitions();
		fireEvent.click(screen.getByRole("button", { name: "Schedule event" }));
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));
		expect(mocks.replaceAutomation).toHaveBeenCalledWith(
			expect.objectContaining({
				schedule: expect.objectContaining({
					events: [
						expect.objectContaining({ day: 1 }),
						expect.objectContaining({ day: 2 }),
						expect.objectContaining({ day: -1 }),
					],
				}),
			}),
			JSON.stringify(monthly),
		);
	});

	it("uses themed date and locale-time fields while storing canonical values", async () => {
		render(<AutomationsSection />);
		fireEvent.click(screen.getByRole("button", { name: "Add automation" }));
		await settleBaseUiTransitions();
		await chooseChoice("Automation type", "Conditional alert");
		await chooseChoice("Schedule type", "Timed repeating schedule");
		await chooseChoice("Start from", "Specific date");

		expect(
			screen
				.getByRole("button", { name: "Start date" })
				.getAttribute("data-slot"),
		).toBe("date-picker");
		const time = screen.getByRole("textbox", { name: "Time" });
		expect(time.getAttribute("data-slot")).toBe("time-field");
		expect(time.getAttribute("type")).not.toBe("time");
		focusElement(time);
		fireEvent.change(time, { target: { value: "2:30 PM" } });
		fireEvent.blur(time);
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));
		expect(mocks.addAutomation).toHaveBeenCalledWith(
			expect.objectContaining({
				schedule: expect.objectContaining({
					events: [
						expect.objectContaining({
							timing: { kind: "specific-time", time: "14:30" },
						}),
					],
				}),
			}),
		);
	});

	it("initializes a specific date from the viewer's local calendar day", () => {
		expect(localIsoDate(new Date(2026, 7, 4, 23, 30))).toBe("2026-08-04");
	});

	it("moves focus through every repeated automation row family", async () => {
		mocks.userProperties = [
			{ uuid: USER_PROPERTY_UUID, label: "Region", slug: "region" },
			{
				uuid: SECOND_USER_PROPERTY_UUID,
				label: "District",
				slug: "district",
			},
		];
		mocks.automations = [repeatedRowsAlert()];
		render(<AutomationsSection />);
		fireEvent.click(screen.getByRole("button", { name: /Repeated rows/ }));
		await settleBaseUiTransitions();
		fireEvent.click(screen.getByRole("button", { name: "Edit automation" }));
		await settleBaseUiTransitions();

		for (const name of [
			"Remove condition",
			"Remove",
			"Remove recipient",
			"Remove filter",
		] as const) {
			const remove = screen.getAllByRole("button", { name });
			focusElement(remove[0]);
			fireEvent.click(remove[0]);
			await waitFor(() =>
				expect(document.activeElement).toBe(
					screen.getAllByRole("button", { name })[0],
				),
			);
		}

		let removeEvents = screen.getAllByRole("button", { name: "Remove event" });
		focusElement(removeEvents[0]);
		fireEvent.click(removeEvents[0]);
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("button", { name: "Remove event" }),
			),
		);
		removeEvents = screen.getAllByRole("button", { name: "Remove event" });
		fireEvent.click(removeEvents[0]);
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("button", { name: "Schedule event" }),
			),
		);
	});

	it("moves focus to the next case change after removal", async () => {
		mocks.automations = [
			{
				...rule,
				updates: [
					...rule.updates,
					{
						uuid: testUuid("ui-second-update"),
						target: { scope: "case", property: "priority" },
						value: { kind: "literal", value: "high" },
					},
				],
			},
		];
		render(<AutomationsSection />);
		fireEvent.click(
			screen.getByRole("button", { name: /Close resolved visits/ }),
		);
		await settleBaseUiTransitions();
		fireEvent.click(screen.getByRole("button", { name: "Edit automation" }));
		await settleBaseUiTransitions();
		const remove = screen.getAllByRole("button", { name: "Remove change" });
		focusElement(remove[0]);
		fireEvent.click(remove[0]);
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("button", { name: "Remove change" }),
			),
		);
	});

	it("counts current matches, names omissions, and exposes regenerated guidance", async () => {
		mocks.automations = [rule];
		render(<AutomationsSection />);
		fireEvent.click(
			screen.getByRole("button", { name: /Close resolved visits/ }),
		);
		await settleBaseUiTransitions();
		fireEvent.click(
			screen.getByRole("button", { name: "Count matching cases" }),
		);
		await waitFor(() => expect(screen.getByText("4")).toBeDefined());
		expect(screen.getByText(/Count excludes:/)).toBeDefined();
		expect(screen.getByText(/Data Cleanup \(Pro or higher\)/)).toBeDefined();
		expect(
			screen.getByText(/Nova does not run this automation in Preview/),
		).toBeDefined();
		expect(mocks.preview).toHaveBeenCalledWith({
			appId: "app-automations",
			automationUuid: RULE_UUID,
			expectedAutomation: rule,
		});
	});

	it("keeps every definition readable for a Project viewer and hides edits", async () => {
		mocks.automations = [rule];
		mocks.canEdit = false;
		render(<AutomationsSection />);
		expect(screen.queryByRole("button", { name: "Add automation" })).toBeNull();
		fireEvent.click(
			screen.getByRole("button", { name: /Close resolved visits/ }),
		);
		await settleBaseUiTransitions();
		expect(
			screen.queryByRole("button", { name: "Edit automation" }),
		).toBeNull();
		expect(
			screen.getByRole("button", { name: "Count matching cases" }),
		).toBeDefined();
	});

	it("shows an authoritative conflict instead of overwriting a co-editor", async () => {
		mocks.automations = [rule];
		const { rerender } = render(<AutomationsSection />);
		fireEvent.click(
			screen.getByRole("button", { name: /Close resolved visits/ }),
		);
		await settleBaseUiTransitions();
		fireEvent.click(screen.getByRole("button", { name: "Edit automation" }));
		await settleBaseUiTransitions();
		mocks.automations = [{ ...rule, name: "Peer changed this" }];
		rerender(<AutomationsSection />);
		expect(screen.getByText(/A co-editor changed or removed/)).toBeDefined();
		expect(
			screen.getByRole("button", { name: "Save automation" }),
		).toHaveProperty("disabled", true);
		expect(
			screen.getByRole("button", { name: "Remove automation" }),
		).toHaveProperty("disabled", true);
		fireEvent.click(screen.getByRole("button", { name: "Remove automation" }));
		expect(mocks.replaceAutomation).not.toHaveBeenCalled();
		expect(mocks.removeAutomation).not.toHaveBeenCalled();
	});

	it("passes the opened fingerprint to the atomic replacement", async () => {
		mocks.automations = [rule];
		render(<AutomationsSection />);
		fireEvent.click(
			screen.getByRole("button", { name: /Close resolved visits/ }),
		);
		await settleBaseUiTransitions();
		fireEvent.click(screen.getByRole("button", { name: "Edit automation" }));
		await settleBaseUiTransitions();
		fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
			target: { value: "My rename" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));
		expect(mocks.replaceAutomation).toHaveBeenCalledWith(
			expect.objectContaining({ name: "My rename" }),
			JSON.stringify(rule),
		);
	});

	it("returns focus to Add automation after removal", async () => {
		mocks.automations = [rule];
		render(<AutomationsSection />);
		fireEvent.click(
			screen.getByRole("button", { name: /Close resolved visits/ }),
		);
		await settleBaseUiTransitions();
		fireEvent.click(screen.getByRole("button", { name: "Edit automation" }));
		await settleBaseUiTransitions();
		fireEvent.click(screen.getByRole("button", { name: "Remove automation" }));
		fireEvent.click(screen.getByRole("button", { name: "Remove automation" }));
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("button", { name: "Add automation" }),
			),
		);
		expect(mocks.removeAutomation).toHaveBeenCalledWith(
			RULE_UUID,
			JSON.stringify(rule),
		);
	});
});
