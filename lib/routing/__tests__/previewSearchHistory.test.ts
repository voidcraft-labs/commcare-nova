/**
 * Which searches each browser history entry records as standing, write by
 * write, as `useClientPath.ts` applies `builderEntryState` and
 * `previewSearchHistoryWrite`. Web Apps keeps a query on the page's address
 * (`cloudcare/js/formplayer/utils/utils.js::CloudcareUrl.setQueryData`), a
 * step forward carries it (`addSelection`), and a submission pushes an
 * address without it (`app.js`'s submit handler: `urlObject.onSubmit()`, then
 * `setUrlToObject`) while the earlier addresses keep theirs. Each entry's
 * state names its searches; the context of each, the worker's answers among
 * it, is in the entry's record, the running Preview session's.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { PreviewSearchState } from "@/lib/session/types";
import {
	NO_PREVIEW_ENTRY_RECORD,
	type PreviewEntryRecord,
	type PreviewHistoryEntry,
	previewEntryOf,
	previewEntryRecordReader,
} from "../previewEntryRecords";
import {
	type BuilderHistoryWrite,
	builderEntryState,
} from "../previewHeldMenu";
import {
	previewSearchesCarriedOn,
	previewSearchesOnEntry,
	previewSearchHistoryWrite,
	type RecordedPreviewSearch,
	readPreviewSearchContexts,
	readPreviewStandingSearches,
	withoutPreviewSearchesEnd,
	withPreviewSearchBegun,
	withPreviewSearchesEnded,
	withPreviewStandingSearches,
} from "../previewSearchHistory";

const patients = testUuid("patients");
const list = `/build/app/${patients}/results`;
const details = `/build/app/${patients}/cases/kofi`;
const form = `/build/app/${testUuid("visit")}`;
const menu = `/build/app/${patients}`;
const others = testUuid("others");

/** A completed search as an entry's record holds it. */
function recorded(
	submission: string,
	moduleUuid: string = patients,
): RecordedPreviewSearch {
	return {
		moduleUuid,
		state: {
			kind: "completed",
			attempt: 1,
			submission,
			answers: { patient_name: submission },
			matchCount: 1,
		},
	};
}

/** An entry of nothing but this state. */
function entryOf(state: Record<string, unknown>): PreviewHistoryEntry {
	return { state, record: NO_PREVIEW_ENTRY_RECORD };
}

/** A browser history the builder writes into, as `useClientPath.ts` does:
 * each entry's record filed by its id in the running session's records.
 * `newSession` starts a session whose records are empty. */
function history(first: string) {
	const entries: { pathname: string; state: Record<string, unknown> }[] = [
		{ pathname: first, state: { __novaEntry: "first" } },
	];
	let records = new Map<string, PreviewEntryRecord>();
	let at = 0;
	const reader = () => previewEntryRecordReader(records);
	const entryAt = (index: number): PreviewHistoryEntry => ({
		state: entries[index].state,
		record: reader()(previewEntryOf(entries[index].state)),
	});
	const write = (written: BuilderHistoryWrite) => {
		const current = entryAt(at);
		const kind =
			"lens" in written ? "lens" : written.replace ? "replace" : "push";
		const step = previewSearchHistoryWrite(
			current,
			builderEntryState(
				{ pathname: entries[at].pathname, ...current },
				written,
				reader(),
			),
			kind,
		);
		records.set(previewEntryOf(step.written.state) ?? "", step.written.record);
		const entry = { pathname: written.pathname, state: step.written.state };
		if (kind === "replace") {
			entries[at] = entry;
			return;
		}
		if (step.consumesEnd)
			entries[at] = {
				...entries[at],
				state: withoutPreviewSearchesEnd(current.state),
			};
		entries.splice(at + 1, entries.length, entry);
		at += 1;
	};
	/** Rewrite the current entry in place, as the record writers do. */
	const rewrite = (
		next: (entry: PreviewHistoryEntry) => PreviewHistoryEntry,
	) => {
		const written = next(entryAt(at));
		records.set(previewEntryOf(written.state) ?? "", written.record);
		entries[at] = { ...entries[at], state: written.state };
	};
	return {
		push: (pathname: string) => write({ pathname, replace: false }),
		replace: (pathname: string) => write({ pathname, replace: true }),
		lens: () => write({ pathname: entries[at].pathname, lens: true }),
		/** A search begun on the current entry (`beginPreviewStandingSearch`). */
		search: (submission: string, moduleUuid: string = patients) =>
			rewrite((entry) =>
				withPreviewSearchBegun(
					entry,
					readPreviewStandingSearches(entry.state),
					recorded(submission, moduleUuid),
				),
			),
		/** A form submitted on the current entry (`endPreviewStandingSearches`). */
		submit: () =>
			rewrite((entry) => ({
				...entry,
				state: withPreviewSearchesEnded(entry.state),
			})),
		back: (steps = 1) => {
			at -= steps;
		},
		forward: () => {
			at += 1;
		},
		newSession: () => {
			records = new Map();
		},
		get standing() {
			return readPreviewStandingSearches(entries[at].state);
		},
		get state() {
			return entries[at].state;
		},
		/** The module searches the screen on this entry holds, over what the
		 *  session holds now (`previewSearchesOnEntry`). */
		held(sessionStates: Readonly<Record<string, PreviewSearchState>>) {
			const entry = entryAt(at);
			return previewSearchesOnEntry(
				sessionStates,
				new Set(readPreviewStandingSearches(entry.state)),
				readPreviewSearchContexts(entry),
			);
		},
		get pathname() {
			return entries[at].pathname;
		},
	};
}

describe("a step forward carries the searches of the entry it leaves", () => {
	it("carries a search from its list to the case's details and the form", () => {
		const h = history(list);
		h.search("kofi-search");
		h.push(details);
		expect(h.standing).toEqual(["kofi-search"]);
		h.replace(form);
		expect(h.standing).toEqual(["kofi-search"]);
		h.lens();
		expect(h.standing).toEqual(["kofi-search"]);
	});
});

describe("a submission ends the searches on the screen it lands on alone", () => {
	it("lands with no search, and Back returns to every entry that held one", () => {
		const h = history(list);
		h.search("kofi-search");
		h.push(form);
		h.submit();
		// The landing, Web Apps' address after `onSubmit`, holds no query.
		h.push(list);
		expect(h.standing).toEqual([]);
		// The form's entry and the list's before it keep theirs.
		h.back();
		expect(h.pathname).toBe(form);
		expect(h.standing).toEqual(["kofi-search"]);
		h.back();
		expect(h.standing).toEqual(["kofi-search"]);
		// Forward reaches the landing as it was written.
		h.forward();
		h.forward();
		expect(h.standing).toEqual([]);
	});

	it("ends them on a landing that replaces the form's entry too", () => {
		const h = history(list);
		h.search("kofi-search");
		h.push(form);
		h.submit();
		h.replace(menu);
		expect(h.standing).toEqual([]);
	});

	it("carries on a search the landing keys to the registered case, alone", () => {
		const h = history(list);
		h.search("kofi-search");
		h.search("ama-search");
		h.push(form);
		h.submit();
		// A registration re-keys its menu's search, the same submission.
		h.search("kofi-search");
		h.push(list);
		expect(h.standing).toEqual(["kofi-search"]);
	});

	it("is the next step's alone: a step from the form's entry after Back carries its searches on again", () => {
		const h = history(list);
		h.search("kofi-search");
		h.push(form);
		h.submit();
		h.push(menu);
		h.back();
		h.push(details);
		expect(h.standing).toEqual(["kofi-search"]);
	});

	it("waits through a language change on the form, which keeps the screen", () => {
		const h = history(list);
		h.search("kofi-search");
		h.push(form);
		h.submit();
		h.lens();
		expect(h.standing).toEqual(["kofi-search"]);
		h.push(list);
		expect(h.standing).toEqual([]);
	});
});

describe("what an entry carries on", () => {
	it("is every search standing on it, or after a submission's end, those begun since", () => {
		const entry = withPreviewStandingSearches(entryOf({ other: 1 }), [
			"a",
			"b",
		]);
		expect(previewSearchesCarriedOn(entry.state)).toEqual(["a", "b"]);
		const ended = withPreviewSearchesEnded(entry.state);
		expect(ended.other).toBe(1);
		expect(previewSearchesCarriedOn(ended)).toEqual([]);
		const rekeyed = withPreviewSearchBegun(
			{ ...entry, state: ended },
			["a", "b"],
			recorded("b"),
		);
		expect(readPreviewStandingSearches(rekeyed.state)).toEqual(["a", "b"]);
		expect(previewSearchesCarriedOn(rekeyed.state)).toEqual(["b"]);
		expect(
			previewSearchesCarriedOn(withoutPreviewSearchesEnd(rekeyed.state)),
		).toEqual(["a", "b"]);
	});
});

describe("an entry's search stands where the session has since replaced it", () => {
	const kofi = recorded("kofi-search");
	const defaultSearch: PreviewSearchState = {
		kind: "completed",
		attempt: 2,
		submission: "default-search",
		answers: {},
		matchCount: 2,
	};

	it("takes the search back where the menu's default search ran again since", () => {
		// The worker searches Patients, opens a form from it and submits; the
		// list the submission lands on runs its default search, which the
		// session now holds. Back reaches the entries the search stood on.
		const h = history(list);
		h.search("kofi-search");
		h.push(form);
		h.submit();
		h.push(list);
		h.search("default-search");
		const session = { [patients]: defaultSearch };
		expect(h.held(session)[patients]).toBe(defaultSearch);
		h.back();
		expect(h.held(session)[patients]).toEqual(kofi.state);
		h.back();
		expect(h.held(session)[patients]).toEqual(kofi.state);
	});

	it("keeps the session's own search where it stands on the entry", () => {
		const h = history(list);
		h.search("kofi-search");
		const session = { [patients]: kofi.state };
		expect(h.held(session)[patients]).toBe(kofi.state);
		// A search of another module the entry recorded comes back beside it.
		h.search("ama-search", others);
		expect(h.held(session)[others]).toEqual(recorded("ama-search").state);
	});

	it("holds no search another Preview session ran", () => {
		const h = history(list);
		h.search("kofi-search");
		h.push(form);
		expect(h.held({})[patients]).toEqual(kofi.state);
		h.newSession();
		expect(h.held({})).toEqual({});
	});

	it("keeps no answer of a search in the entry's state", () => {
		const h = history(list);
		h.search("kofi-search");
		h.push(form);
		h.submit();
		const kept = [h.state];
		h.back();
		kept.push(h.state);
		for (const state of kept) {
			expect(readPreviewStandingSearches(state)).toEqual(["kofi-search"]);
			// The submission names the search; its answers are the record's.
			expect(JSON.stringify(state)).not.toContain("patient_name");
		}
	});

	it("records the latest context of each search, and none of a search let go", () => {
		const completed = recorded("kofi-search");
		const entry = withPreviewSearchBegun(entryOf({}), [], {
			...completed,
			state: {
				kind: "running",
				attempt: 1,
				submission: "kofi-search",
				answers: { patient_name: "kofi-search" },
			},
		});
		const settled = withPreviewSearchBegun(
			entry,
			readPreviewStandingSearches(entry.state),
			completed,
		);
		expect(readPreviewSearchContexts(settled)["kofi-search"]).toEqual(
			completed,
		);
		const letGo = withPreviewStandingSearches(settled, []);
		expect(readPreviewSearchContexts(letGo)).toEqual({});
		// A context a page wrote into the entry's state is no context: only
		// the session's record holds them.
		expect(
			readPreviewSearchContexts(
				entryOf({
					__novaPreviewSearches: ["x"],
					__novaPreviewSearchContexts: { x: recorded("x") },
				}),
			),
		).toEqual({});
	});
});
