import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { applyMutations } from "@/lib/doc/mutations";
import { type Mutation, mutationSchema } from "@/lib/doc/types";
import {
	type Automation,
	automationMessageText,
	type BlueprintDoc,
} from "@/lib/domain";

const AUTOMATION_UUID = testUuid("doc-automation");
const CONDITION_ONE = testUuid("doc-automation-condition-one");
const CONDITION_TWO = testUuid("doc-automation-condition-two");
const UPDATE_UUID = testUuid("doc-automation-update");

function rule(): Automation {
	return {
		uuid: AUTOMATION_UUID,
		kind: "case-update",
		name: "Resolve stale visits",
		caseType: "visit",
		criteriaOperator: "all",
		criteria: [
			{
				uuid: CONDITION_ONE,
				kind: "match-property",
				scope: "case",
				property: "state",
				matchType: "equal",
				value: "stale",
			},
		],
		setupOnlyCriteria: [],
		updates: [
			{
				uuid: UPDATE_UUID,
				target: { scope: "case", property: "state" },
				value: { kind: "literal", value: "resolved" },
			},
		],
		closeCase: false,
	};
}

function docWithRule(): BlueprintDoc {
	const doc = buildDoc({
		appName: "Visit automations",
		caseTypes: [
			{
				name: "visit",
				properties: [
					{ name: "state", label: "State", data_type: "text" },
					{ name: "priority", label: "Priority", data_type: "int" },
				],
			},
		],
	});
	doc.automations = { [AUTOMATION_UUID]: rule() };
	doc.automationOrder = [AUTOMATION_UUID];
	return doc;
}

function replayWire(prev: BlueprintDoc, next: BlueprintDoc): BlueprintDoc {
	const wire = JSON.parse(
		JSON.stringify({ mutations: diffDocsToMutations(prev, next) }),
	) as { mutations: unknown[] };
	const parsed = wire.mutations.map((mutation) =>
		mutationSchema.parse(mutation),
	);
	return produce(prev, (draft) => {
		applyMutations(draft, parsed as Mutation[]);
	});
}

describe("automation mutation replay", () => {
	it("keeps criterion edits discriminated by their immutable automation kind", () => {
		const base = {
			kind: "editAutomationItem",
			automationUuid: AUTOMATION_UUID,
			edit: {
				collection: "criterion",
				operation: "add",
				after: null,
			},
		} as const;
		expect(
			mutationSchema.safeParse({
				...base,
				targetKind: "case-update",
				edit: {
					...base.edit,
					value: {
						uuid: testUuid("mutation-update-date"),
						kind: "match-property",
						scope: "parent",
						property: "due",
						matchType: "date-days",
						days: 0,
					},
				},
			}).success,
		).toBe(true);
		expect(
			mutationSchema.safeParse({
				...base,
				targetKind: "conditional-alert",
				edit: {
					...base.edit,
					value: {
						uuid: testUuid("mutation-alert-date"),
						kind: "match-property",
						scope: "case",
						property: "due",
						matchType: "date-days",
						days: 0,
					},
				},
			}).success,
		).toBe(false);
	});

	it("round-trips granular scalar, nested add, update, remove, and reorder edits", () => {
		const prev = docWithRule();
		const next = produce(prev, (draft) => {
			const automation = draft.automations?.[AUTOMATION_UUID];
			if (automation?.kind !== "case-update") throw new Error("missing rule");
			automation.name = "Resolve urgent stale visits";
			automation.criteria.push({
				uuid: CONDITION_TWO,
				kind: "match-property",
				scope: "case",
				property: "priority",
				matchType: "has-value",
			});
			automation.criteria = [automation.criteria[1], automation.criteria[0]];
			automation.updates[0].value = { kind: "literal", value: "done" };
			automation.setupOnlyCriteria.push({
				uuid: testUuid("doc-automation-setup"),
				text: "UCR filter: urgent_visits",
			});
		});
		const mutations = diffDocsToMutations(prev, next);
		expect(mutations.map((mutation) => mutation.kind)).toContain(
			"editAutomationItem",
		);
		expect(toPersistableDoc(replayWire(prev, next))).toEqual(
			toPersistableDoc(next),
		);
	});

	it("replays a schedule-kind replacement and timed event edits", () => {
		const prev = docWithRule();
		const alertUuid = testUuid("doc-alert");
		const recipientUuid = testUuid("doc-alert-recipient");
		const eventUuid = testUuid("doc-alert-event");
		const alert: Automation = {
			uuid: alertUuid,
			kind: "conditional-alert",
			name: "Visit reminder",
			caseType: "visit",
			criteriaOperator: "any",
			criteria: [],
			setupOnlyCriteria: [],
			recipients: [{ uuid: recipientUuid, kind: "owner" }],
			schedule: {
				kind: "immediate",
				events: [
					{
						uuid: eventUuid,
						minutesToWait: 5,
						content: {
							kind: "sms",
							message: automationMessageText("Visit due"),
						},
					},
				],
			},
			includeDescendantLocations: false,
			locationLevelUuids: [],
			userDataFilters: [],
			useUserCaseForFilter: false,
		};
		prev.automations = { [alertUuid]: alert };
		prev.automationOrder = [alertUuid];
		const next = produce(prev, (draft) => {
			const saved = draft.automations?.[alertUuid];
			if (saved?.kind !== "conditional-alert") throw new Error("missing alert");
			saved.schedule = {
				kind: "timed",
				repeatEvery: -1,
				totalIterations: -1,
				startOffsetDays: 0,
				startDayOfWeek: -1,
				start: { kind: "case-property", property: "date_opened" },
				events: [
					{
						uuid: testUuid("doc-alert-timed-event"),
						day: 1,
						timing: { kind: "specific-time", time: "09:30" },
						content: {
							kind: "email",
							subject: automationMessageText("Due"),
							body: {
								kind: "plain-text",
								message: automationMessageText("Visit due"),
							},
						},
					},
				],
			};
		});
		expect(diffDocsToMutations(prev, next)).toContainEqual(
			expect.objectContaining({
				kind: "setAutomationSchedule",
				uuid: alertUuid,
			}),
		);
		expect(toPersistableDoc(replayWire(prev, next))).toEqual(
			toPersistableDoc(next),
		);
	});

	it("does not let an item edit leak across automation ownership", () => {
		const doc = docWithRule();
		const other = testUuid("doc-other-automation");
		const after = produce(doc, (draft) => {
			applyMutations(draft, [
				{
					kind: "editAutomationItem",
					automationUuid: other,
					targetKind: "case-update",
					edit: {
						collection: "criterion",
						operation: "remove",
						uuid: CONDITION_ONE,
					},
				},
			]);
		});
		expect(toPersistableDoc(after)).toEqual(toPersistableDoc(doc));
	});
});
