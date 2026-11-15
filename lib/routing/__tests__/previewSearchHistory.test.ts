/**
 * Which searches each browser history entry records as standing, write by
 * write, as `useClientPath.ts` applies `builderEntryState` and
 * `previewSearchHistoryWrite`. Web Apps keeps a query on the page's address
 * (`cloudcare/js/formplayer/utils/utils.js::CloudcareUrl.setQueryData`), a
 * step forward carries it (`addSelection`), and a submission pushes an
 * address without it (`app.js`'s submit handler: `urlObject.onSubmit()`, then
 * `setUrlToObject`) while the earlier addresses keep theirs.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { PreviewSearchState } from "@/lib/session/types";
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
const SESSION = "session-a";

/** A completed search as an entry records it. */
function recorded(
	submission: string,
	moduleUuid: string = patients,
	session: string = SESSION,
): RecordedPreviewSearch {
	return {
		moduleUuid,
		session,
		state: {
			kind: "completed",
			attempt: 1,
			submission,
			answers: { patient_name: submission },
			matchCount: 1,
		},
	};
}

/** A browser history the builder writes into, as `useClientPath.ts` does. */
function history(first: string) {
	const entries: { pathname: string; state: Record<string, unknown> }[] = [
		{ pathname: first, state: {} },
	];
	let at = 0;
	const write = (written: BuilderHistoryWrite) => {
		const current = entries[at];
		const kind =
			"lens" in written ? "lens" : written.replace ? "replace" : "push";
		const step = previewSearchHistoryWrite(
			current.state,
			builderEntryState(current, written),
			kind,
		);
		const entry = { pathname: written.pathname, state: step.written };
		if (kind === "replace") {
			entries[at] = entry;
			return;
		}
		if (step.consumesEnd)
			entries[at] = {
				...current,
				state: withoutPreviewSearchesEnd(current.state),
			};
		entries.splice(at + 1, entries.length, entry);
		at += 1;
	};
	/** Rewrite the current entry's state in place, as the record writers do. */
	const rewrite = (
		next: (state: Record<string, unknown>) => Record<string, unknown>,
	) => {
		entries[at] = { ...entries[at], state: next(entries[at].state) };
	};
	return {
		push: (pathname: string) => write({ pathname, replace: false }),
		replace: (pathname: string) => write({ pathname, replace: true }),
		lens: () => write({ pathname: entries[at].pathname, lens: true }),
		/** A search begun on the current entry (`beginPreviewStandingSearch`). */
		search: (submission: string, moduleUuid: string = patients) =>
			rewrite((state) =>
				withPreviewSearchBegun(
					state,
					readPreviewStandingSearches(state),
					recorded(submission, moduleUuid),
				),
			),
		/** A form submitted on the current entry (`endPreviewStandingSearches`). */
		submit: () => rewrite(withPreviewSearchesEnded),
		back: (steps = 1) => {
			at -= steps;
		},
		forward: () => {
			at += 1;
		},
		get standing() {
			return readPreviewStandingSearches(entries[at].state);
		},
		/** The module searches the screen on this entry holds, over what the
		 *  session holds now (`previewSearchesOnEntry`). */
		held(
			sessionStates: Readonly<Record<string, PreviewSearchState>>,
			session: string = SESSION,
		) {
			const state = entries[at].state;
			return previewSearchesOnEntry(
				sessionStates,
				new Set(readPreviewStandingSearches(state)),
				readPreviewSearchContexts(state),
				session,
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
		const entry = withPreviewStandingSearches({ other: 1 }, ["a", "b"]);
		expect(previewSearchesCarriedOn(entry)).toEqual(["a", "b"]);
		const ended = withPreviewSearchesEnded(entry);
		expect(ended.other).toBe(1);
		expect(previewSearchesCarriedOn(ended)).toEqual([]);
		const rekeyed = withPreviewSearchBegun(ended, ["a", "b"], recorded("b"));
		expect(readPreviewStandingSearches(rekeyed)).toEqual(["a", "b"]);
		expect(previewSearchesCarriedOn(rekeyed)).toEqual(["b"]);
		expect(
			previewSearchesCarriedOn(withoutPreviewSearchesEnd(rekeyed)),
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
		expect(h.held({}, "session-b")).toEqual({});
		expect(h.held({})[patients]).toEqual(kofi.state);
	});

	it("records the latest context of each search, and none of a search let go", () => {
		const completed = recorded("kofi-search");
		const entry = withPreviewSearchBegun({}, [], {
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
			readPreviewStandingSearches(entry),
			completed,
		);
		expect(readPreviewSearchContexts(settled)["kofi-search"]).toEqual(
			completed,
		);
		const letGo = withPreviewStandingSearches(settled, []);
		expect(readPreviewSearchContexts(letGo)).toEqual({});
		// A record no Preview wrote holds nothing.
		expect(
			readPreviewSearchContexts({
				__novaPreviewSearches: ["x"],
				__novaPreviewSearchContexts: { x: { moduleUuid: patients } },
			}),
		).toEqual({});
	});
});
