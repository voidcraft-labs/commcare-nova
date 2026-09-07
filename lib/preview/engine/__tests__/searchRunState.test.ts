import { afterEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { hiddenSearchInputDef, simpleSearchInputDef } from "@/lib/domain";
import {
	dateLiteral,
	literal,
	now,
	sessionContext,
	term,
} from "@/lib/domain/predicate";
import { previewAsMe, previewSessionValues } from "../identity";
import {
	buildSearchRunState,
	changeSearchRunDraft,
	clearSearchRun,
	reconcileSearchRunState,
	restoreSearchRun,
	withHiddenValues,
} from "../searchRunState";

const INPUT = testUuid("00000000-0000-4000-8000-000000000201");
const HIDDEN = testUuid("00000000-0000-4000-8000-000000000202");
const SESSION = previewSessionValues(
	previewAsMe({
		id: "worker-1",
		name: "Worker One",
		email: "worker@example.org",
	}),
);
const input = (value: string) =>
	simpleSearchInputDef(INPUT, "name", "Name", "text", "case_name", {
		default: term(literal(value)),
	});
const searchedBy = hiddenSearchInputDef(
	HIDDEN,
	"searched_by",
	"Searched by",
	term(sessionContext("username")),
);
const initial = (value = "Alice", scope = "module-a") =>
	buildSearchRunState(scope, [input(value), searchedBy], SESSION);
const answers = (name: string) => new Map([["name", name]]);
afterEach(() => vi.useRealTimers());

describe("search run commands", () => {
	it("acknowledges an admitted draft by identity while filtering foreign keys", () => {
		const first = initial();
		const submitted = answers("Manual code");
		const accepted = changeSearchRunDraft(first, first, submitted, false);
		expect(accepted.draft).toBe(submitted);
		const scanned = answers("BC-0042");
		const next = changeSearchRunDraft(accepted, first, scanned, false);
		expect(next.draft).toBe(scanned);
		expect(submitted).toEqual(answers("Manual code"));
		const foreign = new Map([...scanned, ["unknown", "untrusted"]]);
		const filtered = changeSearchRunDraft(next, first, foreign, false);
		expect(filtered.draft).toEqual(scanned);
		expect(filtered.draft).not.toBe(foreign);
		expect(foreign.get("unknown")).toBe("untrusted");
	});
	it("refreshes untouched defaults, preserves edits and treats clear as intentional until scope changes", () => {
		const first = initial();
		expect(first.draft).toEqual(answers("Alice"));
		expect(first.submitted.size).toBe(0);
		const refreshed = reconcileSearchRunState(first, initial("Alicia"));
		expect(refreshed.draft).toEqual(answers("Alicia"));
		const edited = changeSearchRunDraft(
			refreshed,
			refreshed,
			answers("Amara"),
			false,
		);
		const latest = reconcileSearchRunState(edited, initial("Ada"));
		expect(latest.draft).toEqual(answers("Amara"));
		const cleared = clearSearchRun(latest, latest);
		expect(reconcileSearchRunState(cleared, initial("Anne")).draft.size).toBe(
			0,
		);
		const switched = reconcileSearchRunState(
			cleared,
			initial("Bob", "module-b"),
		);
		expect(switched.draft).toEqual(answers("Bob"));
		expect(switched.hasSubmitted).toBe(false);
	});
	it("records explicit blank submission and clears both worker and hidden answers", () => {
		const desired = initial();
		const submitted = changeSearchRunDraft(desired, desired, new Map(), true);
		expect(submitted.hasSubmitted).toBe(true);
		expect(submitted.submitted.size).toBe(0);
		expect(
			withHiddenValues(submitted.submitted, submitted.submittedHidden),
		).toEqual(new Map([["searched_by", "worker@example.org"]]));
		const cleared = clearSearchRun(submitted, desired);
		expect(cleared.hasSubmitted).toBe(false);
		expect(
			withHiddenValues(cleared.submitted, cleared.submittedHidden).size,
		).toBe(0);
	});
	it("rejects forged hidden answers and restores the values carried by an existing search", () => {
		const desired = initial();
		const forged = new Map([
			["name", "Amara"],
			["searched_by", "forged"],
		]);
		const submitted = changeSearchRunDraft(desired, desired, forged, true);
		expect(submitted.draft).toEqual(answers("Amara"));
		expect(submitted.submittedHidden.get("searched_by")).toBe(
			"worker@example.org",
		);
		const restored = restoreSearchRun(desired, desired, forged);
		expect(restored.draft).toEqual(answers("Amara"));
		expect(restored.submittedHidden.get("searched_by")).toBe("forged");
		expect(restored.hasSubmitted).toBe(true);
	});
	it("drops incompatible answers and ends the submitted phase when the last prompt disappears", () => {
		const desired = initial();
		const submitted = changeSearchRunDraft(
			desired,
			desired,
			answers("Amara"),
			true,
		);
		const changed = buildSearchRunState(
			"module-a",
			[
				simpleSearchInputDef(INPUT, "name", "Date", "date", "date_opened", {
					default: term(dateLiteral("2026-07-16")),
				}),
			],
			SESSION,
		);
		const reconciled = reconcileSearchRunState(submitted, changed);
		expect(reconciled.draft).toEqual(answers("2026-07-16"));
		expect(reconciled.submitted.size).toBe(0);
		const removed = reconcileSearchRunState(
			submitted,
			buildSearchRunState("module-a", [], SESSION),
		);
		expect(removed.hasSubmitted).toBe(false);
		expect(removed.draft.size).toBe(0);
		expect(removed.submittedHidden.size).toBe(0);
	});
	it("replaces renamed hidden keys in a standing search and removes deleted keys", () => {
		const desired = initial();
		const submitted = changeSearchRunDraft(
			desired,
			desired,
			answers("Amara"),
			true,
		);
		const renamed = buildSearchRunState(
			"module-a",
			[
				input("Alice"),
				hiddenSearchInputDef(
					HIDDEN,
					"run_by",
					"Run by",
					term(sessionContext("username")),
				),
			],
			SESSION,
		);
		const reconciled = reconcileSearchRunState(submitted, renamed);
		expect(
			withHiddenValues(reconciled.submitted, reconciled.submittedHidden),
		).toEqual(
			new Map([
				["name", "Amara"],
				["run_by", "worker@example.org"],
			]),
		);
		expect(
			reconcileSearchRunState(
				reconciled,
				buildSearchRunState("module-a", [input("Alice")], SESSION),
			).submittedHidden.size,
		).toBe(0);
	});
	it("resolves hidden time on each submission while editing leaves the standing search unchanged", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-09-06T12:00:00Z"));
		const desired = buildSearchRunState(
			"module-a",
			[input("Alice"), hiddenSearchInputDef(HIDDEN, "time", "Time", now())],
			SESSION,
		);
		const first = changeSearchRunDraft(
			desired,
			desired,
			answers("Alice"),
			true,
		);
		expect(first.submittedHidden.get("time")).toBe("2026-09-06");
		vi.setSystemTime(new Date("2026-09-07T13:45:00Z"));
		const edited = changeSearchRunDraft(first, desired, answers("Ada"), false);
		expect(edited.submittedHidden).toBe(first.submittedHidden);
		expect(
			changeSearchRunDraft(
				edited,
				desired,
				answers("Ada"),
				true,
			).submittedHidden.get("time"),
		).toBe("2026-09-07");
	});
});
