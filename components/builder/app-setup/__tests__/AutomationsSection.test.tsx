// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	focusElement,
	settleBaseUiTransitions,
} from "@/__tests__/helpers/baseUiInteractions";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { AutomationFormChoice } from "@/lib/automations/formChoices";
import {
	type Automation,
	automationMessageText,
	type CaseType,
	type Uuid,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
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
			kind: "ucr-filter" as const,
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
				content: {
					kind: "sms" as const,
					message: automationMessageText(`Message ${index}`),
				},
			})),
		},
		includeDescendantLocations: false,
		locationLevelUuids: [],
		userDataFilters: [0, 1].map((index) => ({
			uuid: testUuid(`ui-repeated-filter-${index}`),
			userPropertyUuid:
				index === 0 ? USER_PROPERTY_UUID : SECOND_USER_PROPERTY_UUID,
			values:
				index === 0
					? [
							{ kind: "literal" as const, value: "value-0" },
							{ kind: "literal" as const, value: "value-0-extra" },
						]
					: [{ kind: "literal" as const, value: "value-1" }],
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
				content: {
					kind: "sms" as const,
					message: automationMessageText("Monthly message"),
				},
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
				content: {
					kind: "sms" as const,
					message: automationMessageText("Weekly message"),
				},
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
					content: {
						kind: "sms",
						message: automationMessageText("Weekly message"),
					},
				},
				{
					uuid: testUuid("ui-weekday-friday"),
					day: 2,
					timing: { kind: "specific-time", time: "09:00" },
					content: {
						kind: "sms",
						message: automationMessageText("Weekly message"),
					},
				},
			],
		},
	};
}

const mocks = vi.hoisted(() => ({
	automations: [] as Automation[],
	caseTypes: [
		{
			name: "visit",
			properties: [],
		},
	] as CaseType[],
	forms: [] as AutomationFormChoice[],
	userProperties: [] as { uuid: Uuid; label: string; slug: string }[],
	levels: [] as { uuid: Uuid; name: string }[],
	locations: [] as StoredLocation[],
	canEdit: true,
	addAutomation: vi.fn((_automation: Automation): unknown => ({
		ok: true,
		uuid: "new",
	})),
	replaceAutomation: vi.fn(
		(_automation: Automation, _expectedFingerprint?: string): unknown => ({
			ok: true,
		}),
	),
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
	useEffectiveCaseTypes: () => mocks.caseTypes,
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

function expectLocalizedRefusal(control: HTMLElement): void {
	const alert = screen.getByRole("alert");
	expect(screen.getAllByRole("alert")).toHaveLength(1);
	expect(control.getAttribute("aria-invalid")).toBe("true");
	const describedBy = control.getAttribute("aria-describedby");
	expect(describedBy).not.toBeNull();
	expect(
		(describedBy ?? "")
			.split(/\s+/)
			.map((id) => document.getElementById(id)?.textContent),
	).toContain(alert.textContent);
}

beforeEach(() => {
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText: vi.fn().mockResolvedValue(undefined) },
	});
	mocks.automations = [];
	mocks.caseTypes = [{ name: "visit", properties: [] }];
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
		expect(screen.getByRole("dialog").className.split(" ")).toContain(
			"@container",
		);
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
		for (const trigger of document.querySelectorAll(
			'[data-slot="select-trigger"]',
		)) {
			expect(trigger.className).toContain("whitespace-normal");
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
		const emptyNameAlert = screen.getByRole("alert");
		expect(emptyNameAlert.textContent).toBe("Enter an automation name.");
		const name = screen.getByRole("textbox", { name: "Name" });
		expect(name.getAttribute("aria-invalid")).toBe("true");
		expect(name.getAttribute("aria-describedby")).not.toBeNull();
		expect(
			emptyNameAlert.closest('[data-slot="dialog-footer"]'),
		).not.toBeNull();
		expect(
			screen
				.getByRole("button", { name: "Save automation" })
				.getAttribute("aria-describedby"),
		).toBe(emptyNameAlert.id);
		fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
			target: { value: "  Padded name  " },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));
		expect(screen.getByRole("alert").textContent).toBe(
			"Enter a nonblank automation name without surrounding whitespace.",
		);
		expect(mocks.addAutomation).not.toHaveBeenCalled();
	});

	it("associates a shared commit-gate finding with its automation field", async () => {
		mocks.addAutomation.mockImplementationOnce((automation: Automation) => ({
			ok: false,
			messages: ["Give every automation a distinct name."],
			findings: [
				{
					code: "AUTOMATION_INVALID",
					scope: "app",
					message: "Two automations have the same name.",
					location: {},
					details: { automationUuid: automation.uuid, path: "name" },
				},
			],
		}));
		render(<AutomationsSection />);
		fireEvent.click(screen.getByRole("button", { name: "Add automation" }));
		await settleBaseUiTransitions();
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));

		const alert = screen.getByRole("alert");
		expect(alert.textContent).toBe("Give every automation a distinct name.");
		const name = screen.getByRole("textbox", { name: "Name" });
		expect(name.getAttribute("aria-invalid")).toBe("true");
		const describedBy = name.getAttribute("aria-describedby");
		expect(describedBy).not.toBeNull();
		expect(document.getElementById(describedBy ?? "")?.textContent).toBe(
			"Give every automation a distinct name.",
		);
	});

	it("localizes server-age and language refusals on their exact inputs", async () => {
		render(<AutomationsSection />);
		fireEvent.click(screen.getByRole("button", { name: "Add automation" }));
		await settleBaseUiTransitions();
		fireEvent.click(
			screen.getByText(
				"Only cases last changed on the server at least this many days ago",
			),
		);
		const days = screen.getByRole("spinbutton", { name: "Days" });
		fireEvent.change(days, { target: { value: "1.5" } });
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));
		expectLocalizedRefusal(days);

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		fireEvent.click(screen.getByRole("button", { name: "Add automation" }));
		await settleBaseUiTransitions();
		await chooseChoice("Automation type", "Conditional alert");
		const language = screen.getByRole("textbox", {
			name: "Default language code",
		});
		fireEvent.change(language, { target: { value: " en " } });
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));
		expectLocalizedRefusal(language);
	});

	it("localizes commit-gate property refusals on their exact inputs", async () => {
		mocks.automations = [monthlyAlert()];
		mocks.replaceAutomation.mockImplementationOnce(() => ({
			ok: false,
			messages: ["Choose a declared custom property for restart."],
			findings: [
				{
					code: "AUTOMATION_INVALID",
					scope: "app",
					message: "The restart property does not exist.",
					location: {},
					details: {
						automationUuid: monthlyAlert().uuid,
						path: "resetCaseProperty",
					},
				},
			],
		}));
		render(<AutomationsSection />);
		fireEvent.click(screen.getByRole("button", { name: /Monthly alert/ }));
		await settleBaseUiTransitions();
		fireEvent.click(screen.getByRole("button", { name: "Edit automation" }));
		await settleBaseUiTransitions();
		const reset = screen.getByRole("textbox", {
			name: "Restart when this case property changes",
		});
		fireEvent.change(reset, { target: { value: "unknown_property" } });
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));
		expectLocalizedRefusal(reset);

		mocks.replaceAutomation.mockImplementationOnce(() => ({
			ok: false,
			messages: ["Choose a date property for the stop date."],
			findings: [
				{
					code: "AUTOMATION_INVALID",
					scope: "app",
					message: "The stop property is not a date.",
					location: {},
					details: {
						automationUuid: monthlyAlert().uuid,
						path: "stopDateCaseProperty",
					},
				},
			],
		}));
		const stop = screen.getByRole("textbox", {
			name: "Stop after the date in this case property",
		});
		fireEvent.change(reset, { target: { value: "" } });
		fireEvent.change(stop, { target: { value: "status" } });
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));
		expectLocalizedRefusal(stop);
	});

	it("keeps empty recipient and schedule-event refusals on their groups", async () => {
		render(<AutomationsSection />);
		fireEvent.click(screen.getByRole("button", { name: "Add automation" }));
		await settleBaseUiTransitions();
		await chooseChoice("Automation type", "Conditional alert");
		fireEvent.click(screen.getByRole("button", { name: "Remove recipient" }));
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));
		expectLocalizedRefusal(screen.getByRole("group", { name: "Recipients" }));

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		fireEvent.click(screen.getByRole("button", { name: "Add automation" }));
		await settleBaseUiTransitions();
		await chooseChoice("Automation type", "Conditional alert");
		fireEvent.click(screen.getByRole("button", { name: "Remove event" }));
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));
		expectLocalizedRefusal(
			screen.getByRole("group", { name: "Schedule events" }),
		);
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

	it("keeps location conditions unavailable until a live place can back them", async () => {
		render(<AutomationsSection />);
		fireEvent.click(screen.getByRole("button", { name: "Add automation" }));
		await settleBaseUiTransitions();
		expect(
			screen.getByRole("button", { name: "Location condition" }),
		).toHaveProperty("disabled", true);

		const expectLocationKindDisabled = async () => {
			const condition = screen.getByRole("combobox", { name: "Condition 1" });
			fireEvent.click(condition);
			await settleBaseUiTransitions();
			const location = screen.getByRole("option", {
				name: "Case owner location",
			});
			expect(location.getAttribute("aria-disabled")).toBe("true");
			fireEvent.pointerDown(location, { pointerType: "mouse" });
			fireEvent.click(location);
			expect(condition.textContent).toContain("Case property");
			fireEvent.keyDown(document.activeElement ?? document.body, {
				key: "Escape",
			});
			await settleBaseUiTransitions();
		};

		fireEvent.click(screen.getByRole("button", { name: "Property condition" }));
		await expectLocationKindDisabled();

		await chooseChoice("Automation type", "Conditional alert");
		fireEvent.click(screen.getByRole("button", { name: "Property condition" }));
		await expectLocationKindDisabled();
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
								subject: automationMessageText("Subject"),
								body: {
									kind: "rich-text",
									html: automationMessageText("<p>Visit due</p>"),
								},
							},
						}),
					],
				}),
			}),
		);
	});

	it("keeps token-looking text literal and inserts property references structurally", async () => {
		render(<AutomationsSection />);
		fireEvent.click(screen.getByRole("button", { name: "Add automation" }));
		await settleBaseUiTransitions();
		await chooseChoice("Automation type", "Conditional alert");

		fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
			target: { value: "Literal {case.case_name}" },
		});
		fireEvent.click(
			screen.getByRole("button", { name: "Case property reference" }),
		);
		fireEvent.change(
			screen.getByRole("textbox", {
				name: "Message reference property 2",
			}),
			{ target: { value: "case_name" } },
		);
		fireEvent.click(screen.getByRole("button", { name: "Literal text" }));
		fireEvent.change(
			screen.getByRole("textbox", { name: "Message literal text 3" }),
			{ target: { value: " done" } },
		);
		fireEvent.click(
			screen.getByRole("button", { name: "Owner or recipient reference" }),
		);
		await chooseChoice("Message context source 4", "Message recipient");
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));

		expect(mocks.addAutomation).toHaveBeenCalledWith(
			expect.objectContaining({
				schedule: expect.objectContaining({
					events: [
						expect.objectContaining({
							content: {
								kind: "sms",
								message: {
									parts: [
										{
											kind: "text",
											text: "Literal {case.case_name}",
										},
										{
											kind: "case-property",
											scope: "case",
											caseType: "visit",
											property: "case_name",
										},
										{ kind: "text", text: " done" },
										{
											kind: "context-property",
											context: "recipient",
											property: "name",
										},
									],
								},
							},
						}),
					],
				}),
			}),
		);
	});

	it("authors one UUID-backed location condition from the live organization", async () => {
		const locationUuid = testUuid("ui-condition-location");
		mocks.locations = [
			{
				id: locationUuid,
				levelUuid: testUuid("ui-condition-level"),
				parentId: null,
				siteCode: "north",
				name: "North region",
				externalId: null,
				latitude: null,
				longitude: null,
				values: {},
				archivedAt: null,
				orderKey: "a",
			},
		];

		render(<AutomationsSection />);
		fireEvent.click(screen.getByRole("button", { name: "Add automation" }));
		await settleBaseUiTransitions();
		fireEvent.click(screen.getByRole("button", { name: "Location condition" }));

		expect(
			screen.getByRole("combobox", { name: "Location" }).textContent,
		).toContain("North region (north)");
		expect(
			screen
				.getByRole("checkbox", {
					name: /^Include descendant locations/,
				})
				.hasAttribute("data-checked"),
		).toBe(true);
		expect(
			screen.getByRole("button", { name: "Location condition" }),
		).toHaveProperty("disabled", true);

		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));
		expect(mocks.addAutomation).toHaveBeenCalledWith(
			expect.objectContaining({
				criteria: [
					expect.objectContaining({
						kind: "location",
						locationUuid,
						includeDescendants: true,
					}),
				],
			}),
		);
	});

	it("associates select hints with their trigger", async () => {
		mocks.automations = [monthlyAlert()];
		render(<AutomationsSection />);
		fireEvent.click(screen.getByRole("button", { name: /Monthly alert/ }));
		fireEvent.click(screen.getByRole("button", { name: "Edit automation" }));
		await settleBaseUiTransitions();

		const trigger = screen.getByRole("combobox", {
			name: "Schedule timing mode",
		});
		const descriptionId = trigger.getAttribute("aria-describedby");
		expect(descriptionId).toBeTruthy();
		expect(document.getElementById(descriptionId ?? "")?.textContent).toContain(
			"CommCare HQ applies one timing mode",
		);
	});

	it("keeps registered handlers blank until the author supplies a real ID", async () => {
		render(<AutomationsSection />);
		fireEvent.click(screen.getByRole("button", { name: "Add automation" }));
		await settleBaseUiTransitions();
		await chooseChoice("Automation type", "Conditional alert");
		await chooseChoice("Schedule content type", "Registered custom content");

		const registeredId = screen.getByRole("textbox", { name: "Registered ID" });
		expect(registeredId.getAttribute("value")).toBe("");
		expect(registeredId.getAttribute("placeholder")).toBe(
			"Enter the registered content ID",
		);
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));
		expect(screen.getByRole("alert").textContent).toContain(
			"registered ID must be nonblank",
		);
		expect(mocks.addAutomation).not.toHaveBeenCalled();

		fireEvent.change(registeredId, { target: { value: "custom-handler" } });
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));
		expect(mocks.addAutomation).toHaveBeenCalledWith(
			expect.objectContaining({
				schedule: expect.objectContaining({
					events: [
						expect.objectContaining({
							content: {
								kind: "custom",
								registeredId: "custom-handler",
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

	it("authors exact and structural recipient-filter values without trimming", async () => {
		mocks.userProperties = [
			{ uuid: USER_PROPERTY_UUID, label: "Region", slug: "region" },
		];
		mocks.caseTypes = [
			{
				name: "visit",
				properties: [
					{ name: "case_name", label: proseText("Name"), data_type: "text" },
					{ name: "case_color", label: proseText("Color"), data_type: "text" },
				],
			},
		];

		render(<AutomationsSection />);
		fireEvent.click(screen.getByRole("button", { name: "Add automation" }));
		await settleBaseUiTransitions();
		await chooseChoice("Automation type", "Conditional alert");
		fireEvent.click(screen.getByRole("button", { name: "Recipient filter" }));
		const first = screen.getByRole("textbox", {
			name: "Exact literal value 1",
		});
		fireEvent.change(first, { target: { value: "  north  " } });
		fireEvent.click(screen.getByRole("button", { name: "Accepted value" }));
		await chooseChoice("Value 2 type", "Value from this case");
		await chooseChoice("Case property", "case_color");
		fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
			target: { value: "Reminder" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));

		expect(mocks.addAutomation).toHaveBeenCalledWith(
			expect.objectContaining({
				userDataFilters: [
					expect.objectContaining({
						values: [
							{ kind: "literal", value: "  north  " },
							{
								kind: "case-property",
								caseType: "visit",
								property: "case_color",
							},
						],
					}),
				],
			}),
		);
	});

	it("stores the selected HQ-only condition family", async () => {
		render(<AutomationsSection />);
		fireEvent.click(screen.getByRole("button", { name: "Add automation" }));
		await settleBaseUiTransitions();
		fireEvent.click(screen.getByRole("button", { name: "HQ-only condition" }));
		await chooseChoice("Condition 1 type", "Registered custom criterion");
		fireEvent.change(
			screen.getByRole("textbox", { name: "Exact setup note 1" }),
			{ target: { value: "registered_eligibility_filter" } },
		);
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));

		expect(mocks.addAutomation).toHaveBeenCalledWith(
			expect.objectContaining({
				setupOnlyCriteria: [
					expect.objectContaining({
						kind: "registered-custom",
						text: "registered_eligibility_filter",
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
		expect(
			screen
				.getByRole("group", { name: "Recipient 1" })
				.getAttribute("aria-invalid"),
		).toBe("true");
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
		const eventGroup = screen.getByRole("group", {
			name: "Schedule event 1",
		});
		expect(eventGroup.getAttribute("aria-invalid")).toBe("true");
		const eventErrorId = eventGroup.getAttribute("aria-describedby");
		expect(eventErrorId).not.toBeNull();
		expect(document.getElementById(eventErrorId ?? "")?.textContent).toContain(
			"Reminder intervals must add up to less than the survey expiration window.",
		);
		expect(mocks.replaceAutomation).not.toHaveBeenCalled();
	});

	it("preserves a comma while typing reminder intervals and commits the list", async () => {
		mocks.automations = [surveyAlert];
		render(<AutomationsSection />);
		fireEvent.click(screen.getByRole("button", { name: /Survey follow-up/ }));
		await settleBaseUiTransitions();
		fireEvent.click(screen.getByRole("button", { name: "Edit automation" }));
		await settleBaseUiTransitions();

		const input = screen.getByRole("textbox", {
			name: "Reminder intervals in minutes",
		});
		focusElement(input);
		let typed = "";
		for (const character of "5, 10") {
			fireEvent.keyDown(input, { key: character });
			typed += character;
			fireEvent.input(input, {
				target: { value: typed },
				inputType: "insertText",
				data: character,
			});
			fireEvent.keyUp(input, { key: character });
			expect(input.getAttribute("value")).toBe(typed);
		}
		fireEvent.blur(input);
		expect(input.getAttribute("value")).toBe("5, 10");
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));

		expect(mocks.replaceAutomation).toHaveBeenCalledWith(
			expect.objectContaining({
				schedule: expect.objectContaining({
					events: [
						expect.objectContaining({
							content: expect.objectContaining({
								reminderIntervalsMinutes: [5, 10],
							}),
						}),
					],
				}),
			}),
			JSON.stringify(surveyAlert),
		);
	});

	it("refuses an invalid reminder text draft without mutating the definition", async () => {
		mocks.automations = [surveyAlert];
		render(<AutomationsSection />);
		fireEvent.click(screen.getByRole("button", { name: /Survey follow-up/ }));
		await settleBaseUiTransitions();
		fireEvent.click(screen.getByRole("button", { name: "Edit automation" }));
		await settleBaseUiTransitions();

		const input = screen.getByRole("textbox", {
			name: "Reminder intervals in minutes",
		});
		fireEvent.input(input, { target: { value: "5, nope" } });
		expect(input.getAttribute("aria-invalid")).toBe("true");
		fireEvent.blur(input);
		expect(input.getAttribute("value")).toBe("5, nope");
		fireEvent.click(screen.getByRole("button", { name: "Save automation" }));
		expect(screen.getByRole("alert").textContent).toContain(
			"Use up to 100 positive whole minutes separated by commas.",
		);
		expect(input.getAttribute("value")).toBe("5, nope");
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
		const removeValue = screen.getAllByRole("button", {
			name: "Remove value",
		})[0];
		if (removeValue === undefined) throw new Error("missing removable value");
		focusElement(removeValue);
		fireEvent.click(removeValue);
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getAllByRole("button", { name: "Accepted value" })[0],
			),
		);

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

	it("resets copied state when a refreshed setup guide changes", async () => {
		mocks.automations = [rule];
		mocks.preview
			.mockResolvedValueOnce({
				success: true,
				data: {
					automationUuid: RULE_UUID,
					blueprintSeq: 3,
					organizationRevision: "1",
					currentMatchCount: 4,
					omittedCriteria: [],
					setupGuide: {
						title: "First guide",
						requiredPlan: "Data Cleanup (Pro or higher)",
						steps: ["First setup step."],
						caveats: ["First caveat."],
					},
					executesLocally: false,
				},
			})
			.mockResolvedValueOnce({
				success: true,
				data: {
					automationUuid: RULE_UUID,
					blueprintSeq: 3,
					organizationRevision: "2",
					currentMatchCount: 5,
					omittedCriteria: [],
					setupGuide: {
						title: "Refreshed guide",
						requiredPlan: "Data Cleanup (Pro or higher)",
						steps: ["Refreshed setup step."],
						caveats: ["Refreshed caveat."],
					},
					executesLocally: false,
				},
			});
		render(<AutomationsSection />);
		fireEvent.click(
			screen.getByRole("button", { name: /Close resolved visits/ }),
		);
		await settleBaseUiTransitions();
		fireEvent.click(
			screen.getByRole("button", { name: "Count matching cases" }),
		);
		await screen.findByText("First setup step.");
		fireEvent.click(screen.getByRole("button", { name: "Copy guide" }));
		await screen.findByRole("button", { name: "Copied" });
		fireEvent.click(
			screen.getByRole("button", { name: "Refresh count and guide" }),
		);
		await screen.findByText("Refreshed setup step.");
		expect(screen.getByRole("button", { name: "Copy guide" })).toBeDefined();
		expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
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
		fireEvent.click(
			screen.getByRole("button", { name: "View full definition" }),
		);
		await settleBaseUiTransitions();
		expect(screen.getByRole("dialog").textContent).toContain(
			"Read the complete saved definition below",
		);
		expect(screen.getByRole("textbox", { name: "Name" })).toHaveProperty(
			"value",
			"Close resolved visits",
		);
		expect(
			screen.getByDisplayValue("state").closest("fieldset[disabled]"),
		).toHaveProperty("disabled", true);
		expect(
			screen.getByDisplayValue("resolved").closest("fieldset[disabled]"),
		).toHaveProperty("disabled", true);
		expect(
			screen
				.getByRole("checkbox", { name: "Close the matching case" })
				.hasAttribute("data-checked"),
		).toBe(true);
		expect(
			screen.queryByRole("button", { name: "Save automation" }),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Remove automation" }),
		).toBeNull();
		const footerClose = screen
			.getByRole("dialog")
			.querySelector('[data-slot="dialog-footer"] button');
		if (!(footerClose instanceof HTMLElement)) {
			throw new Error("expected the view-only footer Close button");
		}
		fireEvent.click(footerClose);
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
			screen
				.getByText(/A co-editor changed or removed/)
				.closest('[data-slot="dialog-footer"]'),
		).not.toBeNull();
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
