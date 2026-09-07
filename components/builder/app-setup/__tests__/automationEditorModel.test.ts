import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	type Automation,
	type AutomationTimedEvent,
	automationMessageText,
	automationSchema,
	type CaseType,
} from "@/lib/domain";
import type { StoredLocation } from "@/lib/organization/types";
import {
	automationCommitErrorPath,
	automationLocationOptions,
	automationMessageReferenceCaseType,
	changeNewAutomationKind,
	clearLocationSettingsWithoutRecipient,
	cloneEditableValue,
	contentFor,
	localIsoDate,
	newAlert,
	newCaseUpdate,
	parseReminderIntervalDraft,
	pathStartsWith,
	recipientFor,
	recipientKindAvailable,
	remapWeeklyEventOffsets,
	timedEventComparator,
	updateAutomationContextReferenceCaseTypes,
	weekdayIndexForIsoDate,
} from "../automationEditorModel";

const id = testUuid;
function place(name: string): StoredLocation {
	return {
		id: id(name),
		name,
		siteCode: name,
		levelUuid: id("level"),
		parentId: null,
		externalId: null,
		latitude: null,
		longitude: null,
		values: {},
		archivedAt: null,
		orderKey: name,
	};
}
const caseTypes: CaseType[] = [
	{
		name: "visit",
		properties: [],
		parent_type: "patient",
		relationship: "child",
	},
	{
		name: "extension",
		properties: [],
		parent_type: "patient",
		relationship: "extension",
	},
	{ name: "patient", properties: [] },
];
function event(
	name: string,
	day: number,
	time = "09:00",
): AutomationTimedEvent {
	return {
		uuid: id(name),
		day,
		timing: { kind: "specific-time", time },
		content: { kind: "sms", message: automationMessageText("Hello") },
	};
}
describe("the automation editor's production draft decisions", () => {
	it("creates independent schema-admitted defaults and changes kind while preserving shared authored identity", () => {
		const original = newCaseUpdate("visit");
		expect(automationSchema.safeParse(original).success).toBe(true);
		const authored = {
			...original,
			name: "My follow-up",
			criteriaOperator: "any" as const,
			criteria: [
				{
					uuid: id("condition"),
					kind: "match-property" as const,
					scope: "case" as const,
					property: "status",
					matchType: "has-value" as const,
				},
			],
		};
		const next = changeNewAutomationKind(authored, "conditional-alert");
		expect(automationSchema.safeParse(next).success).toBe(true);
		expect(next).toMatchObject({
			uuid: original.uuid,
			name: "My follow-up",
			caseType: "visit",
			criteriaOperator: "any",
			criteria: authored.criteria,
		});
		expect(changeNewAutomationKind(next, "conditional-alert")).toBe(next);
		expect(changeNewAutomationKind(newAlert("visit"), "case-update").name).toBe(
			"New case update",
		);
		expect(changeNewAutomationKind(original, "conditional-alert").name).toBe(
			"New conditional alert",
		);
	});
	it("clones actual Immer drafts into independent editable values", () => {
		const original = newAlert("visit");
		let clone: Automation | undefined;
		const next = produce(original, (draft) => {
			draft.name = "Draft name";
			clone = cloneEditableValue(draft);
		});
		expect(clone).toEqual(next);
		expect(clone).not.toBe(next);
		if (clone?.kind !== "conditional-alert") throw new Error("missing clone");
		const clonedEvent = clone.schedule.events[0];
		if (!clonedEvent) throw new Error("Missing event");
		clonedEvent.content = {
			kind: "sms",
			message: automationMessageText("Independent"),
		};
		expect(next.schedule.events[0]?.content).toEqual(
			original.schedule.events[0]?.content,
		);
	});
	it.each([
		"0",
		"-1",
		"1.5",
		"1,,2",
		",1",
		"2e3",
		"9007199254740992",
		Array(101).fill("1").join(","),
	])(
		"refuses reminder draft %s without inventing committed intervals",
		(value) => {
			expect(parseReminderIntervalDraft(value)).toEqual({ ok: false });
		},
	);
	it("retains exact positive reminder order while permitting a trailing separator during typing", () => {
		expect(parseReminderIntervalDraft(" 5, 1,5, ")).toEqual({
			ok: true,
			intervals: [5, 1, 5],
		});
		expect(parseReminderIntervalDraft("  ")).toEqual({
			ok: true,
			intervals: [],
		});
		expect(parseReminderIntervalDraft(Array(100).fill("1").join(","))).toEqual({
			ok: true,
			intervals: Array(100).fill(1),
		});
	});
	it("preserves absolute weekdays and event identity across a new week start", () => {
		const schedule = {
			kind: "timed" as const,
			repeatEvery: 7,
			totalIterations: 2,
			startOffsetDays: 0,
			startDayOfWeek: 0,
			start: { kind: "rule-trigger" as const },
			events: [event("monday", 0), event("friday", 4)],
		};
		const next = produce(schedule, (draft) =>
			remapWeeklyEventOffsets(draft, 3),
		);
		expect(next.events.map((row) => [row.uuid, row.day])).toEqual([
			[id("friday"), 1],
			[id("monday"), 4],
		]);
		expect(next.startDayOfWeek).toBe(3);
		expect(produce(next, (draft) => remapWeeklyEventOffsets(draft, 0))).toEqual(
			schedule,
		);
	});
	it("orders month-end days after numeric days and daily times within their days", () => {
		expect(
			[
				event("last", -1),
				event("third", -3),
				event("second", -2),
				event("28", 28),
				event("1", 1),
			]
				.sort((a, b) => timedEventComparator("monthly", a, b))
				.map((e) => e.day),
		).toEqual([1, 28, -3, -2, -1]);
		expect(
			[
				event("later", 0, "17:00"),
				event("tomorrow", 1, "01:00"),
				event("early", 0, "08:30"),
			]
				.sort((a, b) => timedEventComparator("custom-daily", a, b))
				.map((e) => e.uuid),
		).toEqual([id("early"), id("later"), id("tomorrow")]);
	});
	it("uses local calendar components and ISO calendar weekdays", () => {
		const local = new Date(2026, 0, 2, 0, 3);
		expect(localIsoDate(local)).toBe("2026-01-02");
		expect(weekdayIndexForIsoDate("2026-01-05")).toBe(0);
		expect(weekdayIndexForIsoDate("2026-01-11")).toBe(6);
	});
	it("reserves singleton recipients and specific place identities but excludes the row being edited", () => {
		const self = { uuid: id("self"), kind: "self" as const };
		expect(recipientKindAvailable("self", [self], [], false, false)).toBe(
			false,
		);
		expect(
			recipientKindAvailable("self", [self], [], false, false, self.uuid),
		).toBe(true);
		const places = [place("one"), place("two")];
		const first = recipientFor("location", places, []);
		if (!first) throw new Error("missing first place");
		expect(first).toMatchObject({ locationUuid: places[0]?.id });
		const second = recipientFor("location", places, [first]);
		if (!second) throw new Error("missing second place");
		expect(second).toMatchObject({ locationUuid: places[1]?.id });
		expect(recipientFor("location", places, [first, second])).toBeUndefined();
		expect(
			recipientKindAvailable("location", [first, second], places, false, false),
		).toBe(false);
		expect(
			recipientKindAvailable(
				"location",
				[first, second],
				places,
				false,
				false,
				first.uuid,
			),
		).toBe(true);
	});
	it("admits recipient kinds against Connect and user-account filter constraints", () => {
		expect(recipientKindAvailable("self", [], [], true, false)).toBe(false);
		expect(
			recipientKindAvailable("location", [], [place("one")], true, false),
		).toBe(true);
		expect(recipientKindAvailable("self", [], [], false, true)).toBe(false);
		expect(recipientKindAvailable("mobile-worker", [], [], false, true)).toBe(
			true,
		);
	});
	it("does not fabricate external recipient or content identities", () => {
		expect(recipientFor("mobile-worker", [], [])).toMatchObject({
			kind: "mobile-worker",
			hqId: "",
		});
		expect(recipientFor("custom", [], [])).toMatchObject({
			kind: "custom",
			registeredId: "",
		});
		expect(contentFor("custom", [])).toEqual({
			kind: "custom",
			registeredId: "",
		});
		for (const kind of ["sms-survey", "ivr", "connect-survey"] as const) {
			expect(contentFor(kind, [])).toBeUndefined();
			expect(
				contentFor(kind, [{ uuid: id("form"), label: "Form" }]),
			).toMatchObject({
				kind,
				formUuid: id("form"),
				submitPartiallyCompletedForms: false,
				includeCaseUpdatesInPartialSubmissions: false,
			});
		}
	});
	it("clears dependent location settings only after the last location recipient is removed", () => {
		const original = {
			...newAlert("visit"),
			recipients: [
				{
					uuid: id("recipient"),
					kind: "location" as const,
					locationUuid: id("place"),
				},
			],
			includeDescendantLocations: true,
			locationLevelUuids: [id("level")],
		};
		expect(produce(original, clearLocationSettingsWithoutRecipient)).toEqual(
			original,
		);
		const next = produce(original, (draft) => {
			draft.recipients = [];
			clearLocationSettingsWithoutRecipient(draft);
		});
		expect(next).toMatchObject({
			includeDescendantLocations: false,
			locationLevelUuids: [],
		});
	});
	it("keeps unavailable saved place identity visible instead of selecting a different row", () => {
		expect(automationLocationOptions([place("one")], id("gone"))).toEqual([
			[id("gone"), "Saved place unavailable", true],
			[id("one"), "one (one)"],
		]);
	});
	it("projects parent and host references according to the chosen relationship", () => {
		expect(
			automationMessageReferenceCaseType(caseTypes, "visit", "parent"),
		).toBe("patient");
		expect(automationMessageReferenceCaseType(caseTypes, "visit", "host")).toBe(
			"",
		);
		expect(
			automationMessageReferenceCaseType(caseTypes, "extension", "host"),
		).toBe("patient");
		expect(
			automationMessageReferenceCaseType(caseTypes, "extension", "parent"),
		).toBe("");
		expect(
			automationMessageReferenceCaseType(caseTypes, "patient", "parent"),
		).toBe("");
	});
	it("retargets only typed case references while leaving literal placeholders untouched", () => {
		const original = newAlert("visit");
		original.userDataFilters = [
			{
				uuid: id("filter"),
				userPropertyUuid: id("property"),
				values: [
					{ kind: "literal", value: " {case.status} " },
					{ kind: "case-property", caseType: "visit", property: "status" },
				],
			},
		];
		const firstEvent = original.schedule.events[0];
		if (!firstEvent) throw new Error("Missing event");
		firstEvent.content = {
			kind: "sms",
			message: {
				parts: [
					{ kind: "text", text: " {case.status} " },
					{
						kind: "case-property",
						scope: "case",
						caseType: "visit",
						property: "status",
					},
					{
						kind: "case-property",
						scope: "host",
						caseType: "",
						property: "case_name",
					},
				],
			},
		};
		const next = produce(original, (draft) =>
			updateAutomationContextReferenceCaseTypes(draft, caseTypes, "extension"),
		);
		expect(next.userDataFilters[0]?.values).toEqual([
			{ kind: "literal", value: " {case.status} " },
			{ kind: "case-property", caseType: "extension", property: "status" },
		]);
		expect(next.schedule.events[0]?.content).toEqual({
			kind: "sms",
			message: {
				parts: [
					{ kind: "text", text: " {case.status} " },
					{
						kind: "case-property",
						scope: "case",
						caseType: "extension",
						property: "status",
					},
					{
						kind: "case-property",
						scope: "host",
						caseType: "patient",
						property: "case_name",
					},
				],
			},
		});
	});
	it("maps a gate finding to the edited automation before generic name errors and preserves numeric path identity", () => {
		const findings: NonNullable<
			Parameters<typeof automationCommitErrorPath>[0]["findings"]
		> = [
			{ details: { path: "name" } },
			{ details: { automationUuid: id("other"), path: "criteria.9.property" } },
			{
				details: {
					automationUuid: id("mine"),
					path: "schedule.events.1.content.message",
				},
			},
		];
		const path = automationCommitErrorPath({ findings }, id("mine"));
		expect(path).toEqual(["schedule", "events", 1, "content", "message"]);
		expect(pathStartsWith(path, ["schedule", "events", 1])).toBe(true);
		expect(pathStartsWith(path, ["schedule", "events", "1"])).toBe(false);
		expect(automationCommitErrorPath({ findings }, id("missing"))).toEqual([
			"name",
		]);
		expect(automationCommitErrorPath({}, id("mine"))).toEqual([]);
	});
});
