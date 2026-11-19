/**
 * Back and Forward (`previewSelectionsHistory.ts`): each history entry
 * records the case selections it was shown with, and Back or Forward onto an
 * entry puts them back on Web Apps wherever the session holds others (past
 * Home, taking up the task Home ended), as Formplayer replays a popped
 * address's selections (`utils.js::CloudcareUrl`, `router.js::listMenus`,
 * `MenuSessionRunnerService.advanceSessionWithSelections`). Android keeps the
 * session as it stands.
 *
 * The history is the browser's own model here: each entry's state written
 * through `builderEntryState`, the record written as the screen shows it into
 * the running session's records (`previewEntryRecords.ts`, the production
 * registry), and the real session store doing Home and the return.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { previewPlatformRules } from "@/lib/preview/platform";
import { createBuilderSessionStore } from "@/lib/session/store";
import type { PreviewMenuCaseSelection } from "@/lib/session/types";
import {
	type BuilderHistoryScope,
	reconcileBuilderHistoryEntry,
	scopedBuilderHistoryState,
} from "../historyPolicy";
import {
	heldPreviewEntryRecords,
	previewEntryOf,
	previewEntryRecordReader,
	previewEntryRecordsToRead,
	previewEntryRecordsToWrite,
} from "../previewEntryRecords";
import { builderEntryState } from "../previewHeldMenu";
import {
	previewSelectionsArrival,
	previewSelectionsInDocument,
	previewSelectionsTargetOf,
	type RecordedPreviewSelections,
} from "../previewSelectionsHistory";

const APP = "/build/app-a";
const HOUSEHOLDS = testUuid("households");
const MEMBERS = testUuid("members");
const VISIT = testUuid("visit-form");

const HOUSEHOLD: PreviewMenuCaseSelection = {
	caseType: "household",
	cases: [
		{
			caseId: "h-1",
			caseName: "Smith household",
			caseProperties: { ward: "3" },
		},
	],
};

interface Entry {
	readonly pathname: string;
	state: Record<string, unknown>;
}

/** The browser's history: a push from the current entry, Back, Forward.
 *  Each push carries the current entry's record on in the registry's
 *  records, as `useClientPath.ts` does. */
function browserHistory() {
	const entries: Entry[] = [{ pathname: APP, state: { __novaEntry: "home" } }];
	let index = 0;
	return {
		get current(): Entry {
			const entry = entries[index];
			if (entry === undefined) throw new Error("no current entry");
			return entry;
		},
		push(pathname: string): void {
			const records = heldPreviewEntryRecords();
			const reader = previewEntryRecordReader(records);
			const written = builderEntryState(
				{
					...this.current,
					record: reader(previewEntryOf(this.current.state)),
				},
				{ pathname, replace: false },
				reader,
			);
			records.set(previewEntryOf(written.state) ?? "", written.record);
			entries.splice(index + 1);
			entries.push({ pathname, state: written.state });
			index = entries.length - 1;
		},
		back(): void {
			index -= 1;
		},
		forward(): void {
			index += 1;
		},
	};
}

const WEB_APPS = previewPlatformRules("web-apps").poppedEntrySelections;
const ANDROID = previewPlatformRules("android").poppedEntrySelections;

function previewStore() {
	const store = createBuilderSessionStore({
		projectId: "project",
		role: "editor",
		canEdit: true,
	});
	store.getState().setPreviewing(true);
	return store;
}

type Store = ReturnType<typeof previewStore>;

/** What the screen does on every entry but Home: the entry's record in the
 *  running session holds the selections the session holds
 *  (`usePreviewSelectionsArrival`). */
function record(history: ReturnType<typeof browserHistory>, store: Store) {
	const state = store.getState();
	const entry = previewEntryOf(history.current.state) ?? "";
	const records = previewEntryRecordsToWrite(state.previewSessionId);
	records.set(entry, {
		...records.get(entry),
		selections: {
			task: state.previewTaskId,
			menu: state.previewMenuCaseSelections,
			target: previewSelectionsTargetOf(state.previewCaseTarget),
			selected: state.previewSelectedCase,
		},
	});
}

/** The selections the entry on show holds in the running session. */
function onEntry(
	history: ReturnType<typeof browserHistory>,
	store: Store,
): RecordedPreviewSelections | undefined {
	return previewEntryRecordsToRead(store.getState().previewSessionId).get(
		previewEntryOf(history.current.state) ?? "",
	)?.selections;
}

/** What a popstate does before the screen renders (the pop listener). */
function arrive(
	history: ReturnType<typeof browserHistory>,
	store: Store,
	replay: "address" | "session",
): "restore" | "replay" | "keep" {
	const state = store.getState();
	const arrival = previewSelectionsArrival({
		replay,
		atHome: history.current.pathname === APP,
		onEntry: onEntry(history, store),
		task: state.previewTaskId,
		current: {
			menu: state.previewMenuCaseSelections,
			target: previewSelectionsTargetOf(state.previewCaseTarget),
			selected: state.previewSelectedCase,
		},
	});
	if (arrival.kind !== "keep") {
		const recorded = previewSelectionsInDocument(arrival.recorded, {
			modules: { [HOUSEHOLDS]: {}, [MEMBERS]: {} },
			forms: { [VISIT]: {} },
		});
		if (arrival.kind === "restore") state.restorePreviewSelections(recorded);
		else state.replayPreviewSelections(recorded);
	}
	/* The screen the entry shows records what the session now holds. */
	if (history.current.pathname !== APP) record(history, store);
	return arrival.kind;
}

/** The household chosen on Households, a visit form chosen for a member. */
function chooseAVisit(
	history: ReturnType<typeof browserHistory>,
	store: Store,
) {
	history.push(`${APP}/${HOUSEHOLDS}`);
	record(history, store);
	store.getState().setPreviewMenuCaseSelection(HOUSEHOLDS, HOUSEHOLD);
	history.push(`${APP}/${MEMBERS}/results`);
	record(history, store);
	store.getState().setPreviewCaseTarget({
		formUuid: VISIT,
		cases: [{ caseId: "m-1", caseName: "Ada" }],
		caseListSearchText: "ad",
		/* The device world a link carried belongs to the one entry it
		 * opened, never to an address. */
		caseDatabase: { rows: [], indices: [] },
	});
	history.push(`${APP}/${VISIT}`);
	record(history, store);
}

function goHome(history: ReturnType<typeof browserHistory>, store: Store) {
	history.push(APP);
	store.getState().clearPreviewNavigation();
}

describe("Back past Home", () => {
	it("on Web Apps, shows a popped entry with the cases it was shown with", () => {
		const history = browserHistory();
		const store = previewStore();
		chooseAVisit(history, store);
		const task = store.getState().previewTaskId;
		goHome(history, store);
		expect(store.getState().previewMenuCaseSelections).toEqual({});
		expect(store.getState().previewCaseTarget).toBeUndefined();
		expect(store.getState().previewTaskId).not.toBe(task);

		history.back();
		expect(arrive(history, store, WEB_APPS)).toBe("restore");
		const restored = store.getState();
		expect(restored.previewTaskId).toBe(task);
		expect(restored.previewMenuCaseSelections).toEqual({
			[HOUSEHOLDS]: HOUSEHOLD,
		});
		expect(restored.previewCaseTarget).toEqual({
			formUuid: VISIT,
			cases: [{ caseId: "m-1", caseName: "Ada" }],
			caseListSearchText: "ad",
		});

		/* Within the task taken up again a further Back onto the Members
		 * list, shown before its member was chosen for the visit, shows it
		 * with the household alone, as its address holds. */
		history.back();
		expect(arrive(history, store, WEB_APPS)).toBe("replay");
		expect(store.getState().previewTaskId).toBe(task);
		expect(store.getState().previewMenuCaseSelections).toEqual({
			[HOUSEHOLDS]: HOUSEHOLD,
		});
		expect(store.getState().previewCaseTarget).toBeUndefined();
	});

	it("on Web Apps, each address past Home holds its own selections, and Forward past Home returns the later task's", () => {
		const history = browserHistory();
		const store = previewStore();
		chooseAVisit(history, store);
		goHome(history, store);
		/* A second task after Home: only Households chosen. */
		history.push(`${APP}/${HOUSEHOLDS}`);
		record(history, store);
		const second = { caseType: "household", cases: [{ caseId: "h-2" }] };
		store.getState().setPreviewMenuCaseSelection(HOUSEHOLDS, second);
		history.push(`${APP}/${MEMBERS}/results`);
		record(history, store);
		const secondTask = store.getState().previewTaskId;

		history.back(); // Households, same task, shown before its household
		expect(arrive(history, store, WEB_APPS)).toBe("replay");
		expect(store.getState().previewMenuCaseSelections).toEqual({});
		history.back(); // Home
		expect(arrive(history, store, WEB_APPS)).toBe("keep");
		store.getState().clearPreviewNavigation();
		history.back(); // the first task's visit form
		expect(arrive(history, store, WEB_APPS)).toBe("restore");
		expect(store.getState().previewMenuCaseSelections).toEqual({
			[HOUSEHOLDS]: HOUSEHOLD,
		});

		history.forward(); // Home again
		expect(arrive(history, store, WEB_APPS)).toBe("keep");
		store.getState().clearPreviewNavigation();
		history.forward(); // the second task's Households
		history.forward(); // and its Members list
		expect(arrive(history, store, WEB_APPS)).toBe("restore");
		expect(store.getState().previewTaskId).toBe(secondTask);
		expect(store.getState().previewMenuCaseSelections).toEqual({
			[HOUSEHOLDS]: second,
		});
		expect(store.getState().previewCaseTarget).toBeUndefined();
	});

	it("on Android, keeps the session as it stands: no address holds selections", () => {
		const history = browserHistory();
		const store = previewStore();
		chooseAVisit(history, store);
		goHome(history, store);
		history.back();
		expect(arrive(history, store, ANDROID)).toBe("keep");
		expect(store.getState().previewMenuCaseSelections).toEqual({});
		expect(store.getState().previewCaseTarget).toBeUndefined();
	});

	it("never returns another Preview session's cases", () => {
		const history = browserHistory();
		const store = previewStore();
		chooseAVisit(history, store);
		goHome(history, store);
		/* Another Preview run (or worker, platform, launch) starts a session. */
		store.getState().setPreviewing(false);
		store.getState().setPreviewing(true);
		history.back();
		expect(arrive(history, store, WEB_APPS)).toBe("keep");
		expect(store.getState().previewMenuCaseSelections).toEqual({});
	});

	it("ends the rest of the later task when it takes up an earlier one", () => {
		const history = browserHistory();
		const store = previewStore();
		chooseAVisit(history, store);
		goHome(history, store);
		store.getState().setPreviewParentCaseRequest({
			selectingModuleUuid: HOUSEHOLDS,
			returnModuleUuids: [MEMBERS],
		});
		history.back();
		expect(arrive(history, store, WEB_APPS)).toBe("restore");
		expect(store.getState().previewParentCaseRequest).toBeUndefined();
	});

	it("returns only the menus and form the document still has", () => {
		const recorded = {
			task: "t",
			menu: { [HOUSEHOLDS]: HOUSEHOLD, [testUuid("removed")]: HOUSEHOLD },
			target: { formUuid: testUuid("removed-form") },
			selected: { caseId: "h-1", caseName: "Smith household" },
		};
		expect(
			previewSelectionsInDocument(recorded, {
				modules: { [HOUSEHOLDS]: {} },
				forms: {},
			}),
		).toEqual({
			task: "t",
			menu: { [HOUSEHOLDS]: HOUSEHOLD },
			target: undefined,
			selected: { caseId: "h-1", caseName: "Smith household" },
		});
	});
});

describe("Back and Forward within one task", () => {
	/* A crumb cuts the session back to Households: the household stays, the
	 * visit's member goes, on an entry of its own. */
	function cutToHouseholds(
		history: ReturnType<typeof browserHistory>,
		store: Store,
	) {
		store.getState().setPreviewCaseTarget(undefined);
		history.push(`${APP}/${HOUSEHOLDS}`);
		record(history, store);
	}

	it("on Web Apps, shows a popped entry with the cases it was shown with, after a crumb let them go", () => {
		const history = browserHistory();
		const store = previewStore();
		chooseAVisit(history, store);
		cutToHouseholds(history, store);
		expect(store.getState().previewCaseTarget).toBeUndefined();

		history.back(); // the visit form, shown with its member
		expect(arrive(history, store, WEB_APPS)).toBe("replay");
		expect(store.getState().previewCaseTarget).toEqual({
			formUuid: VISIT,
			cases: [{ caseId: "m-1", caseName: "Ada" }],
			caseListSearchText: "ad",
		});
		expect(store.getState().previewMenuCaseSelections).toEqual({
			[HOUSEHOLDS]: HOUSEHOLD,
		});

		history.forward(); // the crumb's entry, without the member
		expect(arrive(history, store, WEB_APPS)).toBe("replay");
		expect(store.getState().previewCaseTarget).toBeUndefined();
	});

	it("on Web Apps, keeps what a form's target carries beyond its form and cases where the entry holds the same", () => {
		const history = browserHistory();
		const store = previewStore();
		chooseAVisit(history, store);
		history.back();
		history.forward(); // the visit form again: the session already shows it
		expect(arrive(history, store, WEB_APPS)).toBe("keep");
		expect(store.getState().previewCaseTarget?.caseDatabase).toEqual({
			rows: [],
			indices: [],
		});
		/* The member chosen again on a later list, the same form: the
		 * selections differ in the menu only, so the target keeps its world. */
		store.getState().setPreviewMenuCaseSelection(HOUSEHOLDS, undefined);
		record(history, store);
		store.getState().setPreviewMenuCaseSelection(HOUSEHOLDS, HOUSEHOLD);
		history.push(`${APP}/${MEMBERS}/results`);
		record(history, store);
		history.back();
		expect(arrive(history, store, WEB_APPS)).toBe("replay");
		expect(store.getState().previewMenuCaseSelections).toEqual({});
		expect(store.getState().previewCaseTarget?.caseDatabase).toEqual({
			rows: [],
			indices: [],
		});
	});

	it("on Web Apps, leaves the task's other facts standing", () => {
		const history = browserHistory();
		const store = previewStore();
		chooseAVisit(history, store);
		const task = store.getState().previewTaskId;
		cutToHouseholds(history, store);
		const request = {
			selectingModuleUuid: HOUSEHOLDS,
			returnModuleUuids: [MEMBERS],
		};
		store.getState().setPreviewParentCaseRequest(request);
		history.back();
		expect(arrive(history, store, WEB_APPS)).toBe("replay");
		expect(store.getState().previewTaskId).toBe(task);
		expect(store.getState().previewParentCaseRequest).toEqual(request);
	});

	it("on Android, keeps the session as it stands", () => {
		const history = browserHistory();
		const store = previewStore();
		chooseAVisit(history, store);
		cutToHouseholds(history, store);
		history.back();
		expect(arrive(history, store, ANDROID)).toBe("keep");
		expect(store.getState().previewCaseTarget).toBeUndefined();
	});
});

describe("the record of a history entry", () => {
	it("is the entry's own: a push does not inherit the entry it leaves", () => {
		const history = browserHistory();
		const store = previewStore();
		chooseAVisit(history, store);
		expect(onEntry(history, store)).toBeDefined();
		history.push(`${APP}/${HOUSEHOLDS}`);
		expect(onEntry(history, store)).toBeUndefined();
	});

	it("is the session's, never the entry's state: no case, name, property or filter text reaches history", () => {
		const history = browserHistory();
		const store = previewStore();
		chooseAVisit(history, store);
		goHome(history, store);
		for (const value of ["h-1", "Smith household", "m-1", "Ada", "ward"])
			expect(JSON.stringify(history.current.state)).not.toContain(value);
		history.back();
		const kept = JSON.stringify(history.current.state);
		for (const value of ["h-1", "Smith household", "m-1", "Ada", "ward"])
			expect(kept).not.toContain(value);
		expect(kept).not.toContain('"ad"');
		// What the entry was shown with is in the session's record.
		expect(onEntry(history, store)?.target?.cases).toEqual([
			{ caseId: "m-1", caseName: "Ada" },
		]);
	});

	it("is Project data: a stale generation's entry loses its id, and with it the record", () => {
		const active: BuilderHistoryScope = {
			scopeId: "runtime",
			appId: "app-a",
			epoch: 2,
		};
		const store = previewStore();
		const history = browserHistory();
		chooseAVisit(history, store);
		const stale = scopedBuilderHistoryState(history.current.state, {
			...active,
			epoch: 1,
		});
		const reconciled = reconcileBuilderHistoryEntry(
			{ pathname: history.current.pathname, search: "", state: stale },
			active,
			"pop",
		);
		expect(previewEntryOf(reconciled?.state)).toBeUndefined();
	});

	it("reads nothing a page wrote into the entry's state", () => {
		const history = browserHistory();
		const store = previewStore();
		chooseAVisit(history, store);
		history.current.state = {
			__novaPreviewSelections: {
				session: store.getState().previewSessionId,
				task: "t",
				menu: { [HOUSEHOLDS]: HOUSEHOLD },
			},
		};
		expect(onEntry(history, store)).toBeUndefined();
	});
});
