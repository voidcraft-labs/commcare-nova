import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import { mutationTargetsInvalid } from "@/lib/doc/mutationTargetAdmission";
import { createBlueprintDocStore } from "@/lib/doc/store";
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

function alert(uuid: ReturnType<typeof testUuid>, suffix: string): Automation {
	return {
		uuid,
		kind: "conditional-alert",
		name: `Visit reminder ${suffix}`,
		caseType: "visit",
		criteriaOperator: "all",
		criteria: [],
		setupOnlyCriteria: [],
		recipients: [
			{ uuid: testUuid(`doc-alert-recipient-${suffix}`), kind: "owner" },
		],
		schedule: {
			kind: "immediate",
			events: [
				{
					uuid: testUuid(`doc-alert-event-${suffix}`),
					minutesToWait: 5,
					content: {
						kind: "sms",
						message: automationMessageText(`Visit due ${suffix}`),
					},
				},
			],
		},
		includeDescendantLocations: false,
		locationLevelUuids: [],
		userDataFilters: [],
		useUserCaseForFilter: false,
	};
}

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
	it("requires immutable target kinds on top-level remove and move commands", () => {
		expect(
			mutationSchema.safeParse({
				kind: "removeAutomation",
				uuid: AUTOMATION_UUID,
			}).success,
		).toBe(false);
		expect(
			mutationSchema.safeParse({
				kind: "moveAutomation",
				uuid: AUTOMATION_UUID,
				after: null,
			}).success,
		).toBe(false);
		expect(
			mutationSchema.safeParse({
				kind: "removeAutomation",
				uuid: AUTOMATION_UUID,
				targetKind: "case-update",
			}).success,
		).toBe(true);
		expect(
			mutationSchema.safeParse({
				kind: "moveAutomation",
				uuid: AUTOMATION_UUID,
				targetKind: "case-update",
				after: null,
			}).success,
		).toBe(true);
	});

	it.each(["removeAutomation", "moveAutomation"] as const)(
		"makes a stale-kind %s a total reducer no-op and an admission refusal",
		(kind) => {
			const before = docWithRule();
			const otherUuid = testUuid(`doc-stale-${kind}-alert`);
			const other = alert(otherUuid, `stale-${kind}`);
			before.automations = { ...before.automations, [otherUuid]: other };
			before.automationOrder = [AUTOMATION_UUID, otherUuid];
			const mutation: Mutation =
				kind === "removeAutomation"
					? {
							kind,
							uuid: AUTOMATION_UUID,
							targetKind: "conditional-alert",
						}
					: {
							kind,
							uuid: AUTOMATION_UUID,
							targetKind: "conditional-alert",
							after: otherUuid,
						};

			expect(mutationTargetsInvalid(before, [mutation])).toBe(true);
			const after = produce(before, (draft) => {
				applyMutations(draft, [mutation]);
			});
			expect(toPersistableDoc(after)).toEqual(toPersistableDoc(before));
		},
	);

	it("applies and idempotently replays current-kind removals and moves", () => {
		const before = docWithRule();
		const otherUuid = testUuid("doc-current-kind-alert");
		before.automations = {
			...before.automations,
			[otherUuid]: alert(otherUuid, "current-kind"),
		};
		before.automationOrder = [AUTOMATION_UUID, otherUuid];
		const move = admitMutationBatch([
			{
				kind: "moveAutomation",
				uuid: AUTOMATION_UUID,
				targetKind: "case-update",
				after: otherUuid,
			},
		]);
		expect(mutationTargetsInvalid(before, move)).toBe(false);
		const moved = produce(before, (draft) => {
			applyMutations(draft, [...move, ...move]);
		});
		expect(moved.automationOrder).toEqual([otherUuid, AUTOMATION_UUID]);

		const remove = admitMutationBatch([
			{
				kind: "removeAutomation",
				uuid: AUTOMATION_UUID,
				targetKind: "case-update",
			},
		]);
		expect(mutationTargetsInvalid(moved, remove)).toBe(false);
		const removed = produce(moved, (draft) => {
			applyMutations(draft, [...remove, ...remove]);
		});
		expect(removed.automations?.[AUTOMATION_UUID]).toBeUndefined();
		expect(removed.automationOrder).toEqual([otherUuid]);
	});

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
		const locationUuid = testUuid("doc-automation-location");
		const next = produce(prev, (draft) => {
			const automation = draft.automations?.[AUTOMATION_UUID];
			if (automation?.kind !== "case-update") throw new Error("missing rule");
			automation.name = "Resolve urgent stale visits";
			automation.criteria.push({
				uuid: CONDITION_TWO,
				kind: "location",
				locationUuid,
				includeDescendants: true,
			});
			automation.criteria = [automation.criteria[1], automation.criteria[0]];
			automation.updates[0].value = { kind: "literal", value: "done" };
			automation.setupOnlyCriteria.push({
				uuid: testUuid("doc-automation-setup"),
				kind: "ucr-filter",
				text: "urgent_visits",
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

	it("replays mixed additions and reorders in criterion, recipient, and event sequences", () => {
		const prev = docWithRule();
		const alertUuid = testUuid("doc-mixed-alert");
		const criterionA = testUuid("doc-mixed-criterion-a");
		const criterionB = testUuid("doc-mixed-criterion-b");
		const criterionC = testUuid("doc-mixed-criterion-c");
		const recipientA = testUuid("doc-mixed-recipient-a");
		const recipientB = testUuid("doc-mixed-recipient-b");
		const recipientC = testUuid("doc-mixed-recipient-c");
		const eventA = testUuid("doc-mixed-event-a");
		const eventB = testUuid("doc-mixed-event-b");
		const eventC = testUuid("doc-mixed-event-c");
		const automation = alert(alertUuid, "mixed");
		if (automation.kind !== "conditional-alert") throw new Error("alert");
		automation.criteria = [criterionA, criterionB].map((uuid, index) => ({
			uuid,
			kind: "match-property" as const,
			scope: "case" as const,
			property: `status_${index}`,
			matchType: "has-value" as const,
		}));
		automation.recipients = [
			{ uuid: recipientA, kind: "owner" },
			{ uuid: recipientB, kind: "last-submitting-user" },
		];
		automation.schedule.events = [eventA, eventB].map((uuid, index) => ({
			uuid,
			minutesToWait: 5,
			content: {
				kind: "sms" as const,
				message: automationMessageText(`Message ${index}`),
			},
		}));
		prev.automations = { [alertUuid]: automation };
		prev.automationOrder = [alertUuid];

		const next = produce(prev, (draft) => {
			const saved = draft.automations?.[alertUuid];
			if (saved?.kind !== "conditional-alert") throw new Error("missing alert");
			if (saved.schedule.kind !== "immediate")
				throw new Error("missing immediate schedule");
			saved.criteria = [
				saved.criteria[1],
				{
					uuid: criterionC,
					kind: "match-property",
					scope: "case",
					property: "status_2",
					matchType: "has-value",
				},
				saved.criteria[0],
			];
			saved.recipients = [
				saved.recipients[1],
				{ uuid: recipientC, kind: "mobile-worker", hqId: "worker-1" },
				saved.recipients[0],
			];
			saved.schedule.events = [
				saved.schedule.events[1],
				{
					uuid: eventC,
					minutesToWait: 5,
					content: {
						kind: "sms",
						message: automationMessageText("Message 2"),
					},
				},
				saved.schedule.events[0],
			];
		});

		expect(toPersistableDoc(replayWire(prev, next))).toEqual(
			toPersistableDoc(next),
		);
	});

	it("replays a mixed addition and reorder of case updates", () => {
		const prev = docWithRule();
		const updateB = testUuid("doc-mixed-update-b");
		const updateC = testUuid("doc-mixed-update-c");
		const currentRule = prev.automations?.[AUTOMATION_UUID];
		if (currentRule?.kind !== "case-update") throw new Error("missing rule");
		currentRule.updates.push({
			uuid: updateB,
			target: { scope: "case", property: "priority" },
			value: { kind: "literal", value: "1" },
		});
		const next = produce(prev, (draft) => {
			const automation = draft.automations?.[AUTOMATION_UUID];
			if (automation?.kind !== "case-update") throw new Error("missing rule");
			automation.updates = [
				automation.updates[1],
				{
					uuid: updateC,
					target: { scope: "case", property: "completed" },
					value: { kind: "literal", value: "yes" },
				},
				automation.updates[0],
			];
		});

		expect(toPersistableDoc(replayWire(prev, next))).toEqual(
			toPersistableDoc(next),
		);
	});

	it("replays a mixed addition and reorder of top-level automations", () => {
		const prev = docWithRule();
		const alertB = testUuid("doc-order-alert-b");
		const alertC = testUuid("doc-order-alert-c");
		prev.automations = {
			...prev.automations,
			[alertB]: alert(alertB, "B"),
		};
		prev.automationOrder = [AUTOMATION_UUID, alertB];
		const next = produce(prev, (draft) => {
			draft.automations = {
				...draft.automations,
				[alertC]: alert(alertC, "C"),
			};
			draft.automationOrder = [alertB, alertC, AUTOMATION_UUID];
		});

		const mutations = diffDocsToMutations(prev, next);
		for (const mutation of mutations) {
			if (mutation.kind !== "moveAutomation") continue;
			expect(mutation.targetKind).toBe(next.automations?.[mutation.uuid]?.kind);
		}
		expect(toPersistableDoc(replayWire(prev, next))).toEqual(
			toPersistableDoc(next),
		);
	});

	it("diffs removals with the removed automation's immutable kind", () => {
		const prev = docWithRule();
		const next = produce(prev, (draft) => {
			delete draft.automations;
			delete draft.automationOrder;
		});
		expect(diffDocsToMutations(prev, next)).toContainEqual({
			kind: "removeAutomation",
			uuid: AUTOMATION_UUID,
			targetKind: "case-update",
		});
	});

	it("keeps target-kind preconditions in move and add-removal undo commands", () => {
		const base = docWithRule();
		const otherUuid = testUuid("doc-undo-alert");
		const added = alert(otherUuid, "undo");
		const store = createBlueprintDocStore();
		store.getState().load(base);
		store.getState().startTracking();

		const add = admitMutationBatch([
			{ kind: "addAutomation", automation: added },
		]);
		store.getState().applyMany(add);
		expect(store.getState().takeCommandBatches()).toEqual([add]);
		store.getState().undo();
		expect(store.getState().takeCommandBatches()).toEqual([
			admitMutationBatch([
				{
					kind: "removeAutomation",
					uuid: otherUuid,
					targetKind: "conditional-alert",
				},
			]),
		]);

		store.getState().redo();
		store.getState().takeCommandBatches();
		const move = admitMutationBatch([
			{
				kind: "moveAutomation",
				uuid: AUTOMATION_UUID,
				targetKind: "case-update",
				after: otherUuid,
			},
		]);
		store.getState().applyMany(move);
		store.getState().takeCommandBatches();
		store.getState().undo();
		expect(store.getState().takeCommandBatches()).toEqual([
			admitMutationBatch([
				{
					kind: "moveAutomation",
					uuid: AUTOMATION_UUID,
					targetKind: "case-update",
					after: null,
				},
			]),
		]);
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
