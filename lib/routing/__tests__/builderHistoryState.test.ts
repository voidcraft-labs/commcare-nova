// @vitest-environment happy-dom
/**
 * A browser history entry outlives the page that wrote it, the signed-in
 * member and their Project membership, so the builder keeps there
 * identifiers and the topology of its steps alone. What an entry was shown
 * with, the cases chosen, a held form menu and each search's answers, is
 * held with the Preview session that showed it (`previewEntryRecords.ts`).
 *
 * The real writers of `useClientPath.ts` drive a Preview walk here (a case
 * chosen, its list's form menu held, a search with a hidden value, a
 * language change, a form opened and submitted) and every entry the browser
 * keeps is read back, as the tab or a later page of it can read it.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { PreviewSearchState } from "@/lib/session/types";
import {
	builderHistoryStateOf,
	sealedBuilderHistoryState,
} from "../builderHistoryState";
import {
	previewEntryRecordsToRead,
	previewEntryRecordsToWrite,
} from "../previewEntryRecords";
import {
	beginPreviewStandingSearch,
	endPreviewStandingSearches,
	pushBuilderHistory,
	pushBuilderLensHistory,
	readCurrentPreviewSearchContexts,
	readCurrentPreviewSelections,
	recordPreviewSelections,
	subscribeBuilderPathChange,
} from "../useClientPath";

const APP = "/build/app-history";
const PATIENTS = testUuid("history-patients");
const VISIT = testUuid("history-visit");

/** Every value of the Project's data or the worker's typing the walk uses. */
const PRIVATE = [
	"Asha Rao",
	"asha-case",
	"Kisumu",
	"asha typed",
	"hidden-worker-value",
	"device-value",
	"registered-case",
];

/** The keys an entry may hold: the builder's closed set and Next's own. */
const ALLOWED = new Set([
	"__novaProjectScope",
	"__novaEntry",
	"__novaPreviousEntry",
	"__novaPreviousGap",
	"__novaPreviewSearches",
	"__novaPreviewSearchesEnd",
	"__NA",
]);

const SEARCH: Exclude<PreviewSearchState, { kind: "not-searched" }> = {
	kind: "completed",
	attempt: 1,
	submission: "history-search",
	answers: { patient_name: "asha typed", searched_by: "hidden-worker-value" },
	matchCount: 1,
	registeredCaseId: "registered-case",
	deviceValues: {
		value: { segments: { value: "device-value" }, choices: {} },
	},
};

const ASHA = { caseId: "asha-case", caseName: "Asha Rao" };

function selectionsOf(task: string) {
	return {
		task,
		menu: {
			[PATIENTS]: {
				caseType: "patient",
				cases: [{ ...ASHA, caseProperties: { village: "Kisumu" } }],
			},
		},
		target: {
			formUuid: VISIT,
			cases: [ASHA],
			caseListSearchText: "asha typed",
		},
		selected: { caseId: "asha-case", caseName: "Asha Rao" },
	};
}

describe("a builder history entry's state", () => {
	it("holds identifiers and topology only through a Preview walk, and Back still finds what each entry was shown with", () => {
		const session = `history-session-${testUuid("walk")}`;
		window.history.replaceState({ __NA: true }, "", APP);
		const stop = subscribeBuilderPathChange(() => {});
		try {
			/* The list, a search run there with a hidden value, and the case
			 * chosen: the entry records what it was shown with. */
			pushBuilderHistory(`${APP}/${PATIENTS}/results`);
			beginPreviewStandingSearch(
				[],
				{ moduleUuid: PATIENTS, state: SEARCH },
				session,
			);
			recordPreviewSelections(() => ({
				session,
				selections: selectionsOf("task-1"),
			}));
			/* Choosing Asha holds the list's form menu on an entry of its own,
			 * then a language change, then the form chosen there, submitted. */
			pushBuilderHistory(`${APP}/${PATIENTS}/results`, false, {
				menu: { moduleUuid: PATIENTS, cases: [ASHA] },
				session,
			});
			pushBuilderLensHistory(`${APP}/${PATIENTS}/results?lang=sw`);
			pushBuilderHistory(`${APP}/${VISIT}`);
			recordPreviewSelections(() => ({
				session,
				selections: selectionsOf("task-1"),
			}));
			endPreviewStandingSearches();

			/* Every entry the browser keeps, newest first. */
			const kept: string[] = [];
			for (let i = 0; i < 4; i += 1) {
				const state = window.history.state as Record<string, unknown>;
				for (const key of Object.keys(state)) expect(ALLOWED).toContain(key);
				kept.push(JSON.stringify(state));
				if (i < 3) window.history.back();
			}
			for (const text of kept)
				for (const value of PRIVATE) expect(text).not.toContain(value);

			/* Back on the list's entry, the session still has what it was
			 * shown with: its search's context and its selections. */
			expect(window.location.pathname).toBe(`${APP}/${PATIENTS}/results`);
			expect(readCurrentPreviewSearchContexts(session)).toEqual({
				"history-search": { moduleUuid: PATIENTS, state: SEARCH },
			});
			expect(readCurrentPreviewSelections(session)?.target?.cases).toEqual([
				ASHA,
			]);
			/* Another session, a new worker or a page loaded since, reads
			 * nothing of them. */
			expect(readCurrentPreviewSearchContexts(`${session}-next`)).toEqual({});
			expect(readCurrentPreviewSelections(`${session}-next`)).toBeUndefined();
		} finally {
			stop();
		}
	});
});

describe("the one write of a history state", () => {
	it("keeps the framework's keys and only the builder's own keys in their own shape", () => {
		const scope = { scopeId: "runtime", appId: "app", epoch: 1 };
		expect(
			sealedBuilderHistoryState({
				__NA: true,
				__PRIVATE_NEXTJS_INTERNALS_TREE: ["tree"],
				__novaProjectScope: scope,
				__novaEntry: "entry-1",
				__novaPreviousEntry: {
					path: "/build/app",
					entry: "entry-0",
					held: ASHA,
				},
				__novaPreviousGap: 2,
				__novaPreviewSearches: ["s-1"],
				__novaPreviewSearchesEnd: [],
				__novaPreviewSelections: { menu: { m: { cases: [ASHA] } } },
				__novaPreviewHeldMenu: { cases: [ASHA] },
				__novaPreviewSearchContexts: { "s-1": { state: SEARCH } },
			}),
		).toEqual({
			__NA: true,
			__PRIVATE_NEXTJS_INTERNALS_TREE: ["tree"],
			__novaProjectScope: scope,
			__novaEntry: "entry-1",
			__novaPreviousEntry: { path: "/build/app", entry: "entry-0" },
			__novaPreviousGap: 2,
			__novaPreviewSearches: ["s-1"],
			__novaPreviewSearchesEnd: [],
		});
	});

	it("drops a builder key that is not its own shape", () => {
		expect(
			builderHistoryStateOf({
				__novaProjectScope: { scopeId: 1 },
				__novaEntry: 7,
				__novaPreviousEntry: { entry: "e" },
				__novaPreviousGap: -1,
				__novaPreviewSearches: ["s", { answers: "Asha Rao" }],
				__novaPreviewSearchesEnd: "s",
			}),
		).toEqual({});
		expect(builderHistoryStateOf(null)).toEqual({});
	});
});

describe("the records of a Preview session", () => {
	it("are one session's: another session starts empty, and a session let go writes nothing again", () => {
		const first = `records-${testUuid("first")}`;
		const second = `records-${testUuid("second")}`;
		previewEntryRecordsToWrite(first).set("entry", { heldMenu: undefined });
		expect(previewEntryRecordsToRead(first).has("entry")).toBe(true);
		// A read under another session neither sees nor drops them.
		expect(previewEntryRecordsToRead(second).size).toBe(0);
		expect(previewEntryRecordsToRead(first).has("entry")).toBe(true);
		// A write of the next session lets the first go.
		previewEntryRecordsToWrite(second).set("entry", {});
		expect(previewEntryRecordsToRead(first).size).toBe(0);
		// A late write of the first (a claim answered after the worker moved
		// on) changes nothing the running session reads.
		previewEntryRecordsToWrite(first).set("late", {});
		expect(previewEntryRecordsToRead(second).has("late")).toBe(false);
		expect(previewEntryRecordsToRead(second).has("entry")).toBe(true);
	});
});
