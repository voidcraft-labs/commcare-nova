/**
 * The builder's two date-and-time gestures, through the production command
 * owner (`createBlueprintMutations`), as `blueprintMutationCommands.test.ts`
 * drives it.
 *
 * Contract (`useBlueprintMutations.ts::splitDatetimeQuestion`,
 * `addDatetimeAsTwoQuestions`): each commits one gated batch that one undo
 * reverts whole; a planner refusal commits nothing and returns its message;
 * the `inline` flavor never raises a toast. The insertion commits in an app
 * that runs in Web Apps, where the plain date-and-time question it stands in
 * for is refused, because the gate sees only the split shape.
 */

import { afterEach, describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { DATETIME_SPLIT_REFUSAL_MESSAGES } from "@/lib/doc/datetimeSplit";
import { createBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDocStoreApi,
	createBlueprintDocStore,
} from "@/lib/doc/store";
import type { BlueprintDoc, Uuid } from "@/lib/doc/types";
import { NEW_APP_SETTINGS } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { toastStore } from "@/lib/ui/toastStore";
import { assertAdmittedDoc } from "./admittedDoc";

const MODULE = testUuid("split-gesture-module");
const FORM = testUuid("split-gesture-form");
const NOTE = testUuid("split-gesture-note");
const VISIT_AT = testUuid("split-gesture-visit-at");

function appDoc(withDatetime: boolean): BlueprintDoc {
	return buildDoc({
		appId: "split-gesture",
		appName: "Split gesture",
		...(withDatetime && {
			appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn: "android" },
		}),
		modules: [
			{
				uuid: MODULE,
				name: "Visits",
				forms: [
					{
						uuid: FORM,
						name: "Visit",
						type: "survey",
						fields: [
							{ uuid: NOTE, kind: "text", id: "note", label: "Note" },
							...(withDatetime
								? [
										{
											uuid: VISIT_AT,
											kind: "datetime" as const,
											id: "visit_at",
											label: "Visit time",
										},
									]
								: []),
						],
					},
				],
			},
		],
	});
}

function setup(doc: BlueprintDoc) {
	assertAdmittedDoc(doc);
	const store = createBlueprintDocStore();
	store.getState().load(doc);
	store.getState().startTracking();
	const api = createBlueprintMutations(store, {
		canEdit: true,
		authoringLanguage: null,
		lookupCommitState: {
			kind: "unmanaged",
			lookupContext: LOOKUP_CONTEXT_UNAVAILABLE,
		},
	});
	return { store, api };
}

function kindsOf(store: BlueprintDocStoreApi, parent: Uuid): string[] {
	const doc = store.getState();
	return (doc.fieldOrder[parent] ?? []).map(
		(uuid) => doc.fields[uuid]?.kind ?? "missing",
	);
}

afterEach(() => toastStore.clear());

describe("asking for a date-and-time question's date and time separately", () => {
	it("commits the split as one batch that one undo reverts", () => {
		const { store, api } = setup(appDoc(true));
		const fieldsBefore = store.getState().fields;
		const orderBefore = store.getState().fieldOrder[FORM];
		const queued = store.getState().peekCommandBatches().length;

		const outcome = api.splitDatetimeQuestion(VISIT_AT);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(kindsOf(store, FORM)).toEqual(["text", "date", "time", "hidden"]);
		expect(store.getState().fields[outcome.dateUuid]?.kind).toBe("date");
		expect(store.getState().fields[outcome.timeUuid]?.kind).toBe("time");
		// The joining Hidden Value keeps the original's identity.
		expect(store.getState().fields[VISIT_AT]?.kind).toBe("hidden");
		expect(store.getState().peekCommandBatches().slice(queued)).toHaveLength(1);

		store.getState().undo();
		expect(store.getState().fieldOrder[FORM]).toEqual(orderBefore);
		expect(store.getState().fields).toEqual(fieldsBefore);
		expect(store.getState().canUndo).toBe(false);
	});

	it("commits nothing and returns the planner's message when the question isn't a date and time", () => {
		const { store, api } = setup(appDoc(true));
		const before = store.getState();

		const outcome = api.inline.splitDatetimeQuestion(NOTE);

		expect(outcome).toEqual({
			ok: false,
			messages: [
				DATETIME_SPLIT_REFUSAL_MESSAGES["not-a-date-and-time-question"],
			],
		});
		expect(store.getState()).toBe(before);
		// The inline flavor leaves the refusal to the row that asked.
		expect(toastStore.toasts).toHaveLength(0);
	});

	it("announces a refusal on the announcing flavor, in the split's words", () => {
		const { api } = setup(appDoc(true));

		api.splitDatetimeQuestion(NOTE);

		expect(toastStore.toasts.at(-1)).toMatchObject({
			title: "Nova couldn't split this question",
			message: DATETIME_SPLIT_REFUSAL_MESSAGES["not-a-date-and-time-question"],
		});
	});

	it("raises no toast when the inline flavor splits", () => {
		const { api } = setup(appDoc(true));

		expect(api.inline.splitDatetimeQuestion(VISIT_AT).ok).toBe(true);
		expect(toastStore.toasts).toHaveLength(0);
	});
});

describe("adding a date and a time as two questions", () => {
	it("commits a date, a time and the hidden value joining them in an app that runs on both", () => {
		const { store, api } = setup(appDoc(false));
		const fieldsBefore = store.getState().fields;
		const queued = store.getState().peekCommandBatches().length;

		const outcome = api.addDatetimeAsTwoQuestions(
			FORM,
			{ id: "new_datetime", label: "New Date/Time" },
			{ atIndex: 1 },
		);

		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		expect(kindsOf(store, FORM)).toEqual(["text", "date", "time", "hidden"]);
		expect(store.getState().fields[outcome.uuid]?.kind).toBe("hidden");
		expect(store.getState().fields[outcome.dateUuid]?.kind).toBe("date");
		expect(store.getState().fields[outcome.timeUuid]?.kind).toBe("time");
		expect(
			Object.values(store.getState().fields).some(
				(field) => field?.kind === "datetime",
			),
		).toBe(false);
		expect(store.getState().peekCommandBatches().slice(queued)).toHaveLength(1);

		store.getState().undo();
		expect(store.getState().fields).toEqual(fieldsBefore);
		expect(kindsOf(store, FORM)).toEqual(["text"]);
	});

	it("is the way to ask for both, since the plain date-and-time question is refused there", () => {
		const { store, api } = setup(appDoc(false));
		const before = store.getState();

		const outcome = api.inline.addField(FORM, {
			kind: "datetime",
			id: "new_datetime",
			label: proseText("New Date/Time"),
		});

		expect(outcome.ok).toBe(false);
		expect(store.getState()).toBe(before);
	});
});
