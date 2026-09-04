// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	hiddenSearchInputDef,
	type SearchInputDef,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	dateLiteral,
	literal,
	now,
	sessionContext,
	term,
} from "@/lib/domain/predicate";
import {
	previewAsMe,
	previewSessionValues,
} from "@/lib/preview/engine/identity";
import { useSearchInputRunState } from "../useSearchInputRunState";

const INPUT_UUID = testUuid("00000000-0000-4000-8000-000000000201");
const HIDDEN_UUID = testUuid("00000000-0000-4000-8000-000000000202");
const TIME_UUID = testUuid("00000000-0000-4000-8000-000000000203");
const SESSION = previewSessionValues(
	previewAsMe({
		id: "worker-1",
		name: "Worker One",
		email: "worker@example.org",
	}),
);

function inputWithDefault(value: string) {
	return simpleSearchInputDef(INPUT_UUID, "name", "Name", "text", "case_name", {
		default: term(literal(value)),
	});
}

/** A system value the worker never sees: who ran the search. */
const SEARCHED_BY = hiddenSearchInputDef(
	HIDDEN_UUID,
	"searched_by",
	"Searched by",
	term(sessionContext("username")),
);

describe("useSearchInputRunState", () => {
	it("seeds the authored default as a draft without submitting it", () => {
		const { result } = renderHook(() =>
			useSearchInputRunState({
				scopeKey: "module-a",
				searchInputs: [inputWithDefault("Alice")],
				session: SESSION,
			}),
		);

		expect(Object.fromEntries(result.current.draft)).toEqual({ name: "Alice" });
		expect(Object.fromEntries(result.current.submitted)).toEqual({});
		expect(result.current.hasSubmitted).toBe(false);
	});

	it("distinguishes an explicit blank submit from the untouched initial list", () => {
		const { result } = renderHook(() =>
			useSearchInputRunState({
				scopeKey: "module-a",
				searchInputs: [inputWithDefault("Alice")],
				session: SESSION,
			}),
		);

		act(() => result.current.submit(new Map()));
		expect(result.current.hasSubmitted).toBe(true);
		expect(result.current.queryActive).toBe(false);
		expect(Object.fromEntries(result.current.submitted)).toEqual({});

		act(() => result.current.clear());
		expect(result.current.hasSubmitted).toBe(false);
	});

	it("updates an untouched default but preserves a worker-edited value", () => {
		const { result, rerender } = renderHook(
			({ defaultValue }) =>
				useSearchInputRunState({
					scopeKey: "module-a",
					searchInputs: [inputWithDefault(defaultValue)],
					session: SESSION,
				}),
			{ initialProps: { defaultValue: "Alice" } },
		);

		rerender({ defaultValue: "Alicia" });
		expect(result.current.draft.get("name")).toBe("Alicia");

		act(() => result.current.changeDraft(new Map([["name", "Amara"]])));
		rerender({ defaultValue: "Ada" });
		expect(result.current.draft.get("name")).toBe("Amara");
	});

	it("clear is intentional and a module switch starts a fresh search session", () => {
		const { result, rerender } = renderHook(
			({ scopeKey, defaultValue }) =>
				useSearchInputRunState({
					scopeKey,
					searchInputs: [inputWithDefault(defaultValue)],
					session: SESSION,
				}),
			{
				initialProps: { scopeKey: "module-a", defaultValue: "Alice" },
			},
		);

		act(() => result.current.submit(new Map([["name", "Alice"]])));
		expect(result.current.queryActive).toBe(true);
		expect(result.current.hasSubmitted).toBe(true);
		act(() => result.current.clear());
		expect(Object.fromEntries(result.current.draft)).toEqual({});
		expect(Object.fromEntries(result.current.submitted)).toEqual({});
		expect(result.current.hasSubmitted).toBe(false);

		// Same-module default refresh cannot resurrect an explicitly-cleared value.
		rerender({ scopeKey: "module-a", defaultValue: "Alicia" });
		expect(Object.fromEntries(result.current.draft)).toEqual({});

		// Entering another module is a new runtime session and gets its own default.
		rerender({ scopeKey: "module-b", defaultValue: "Bob" });
		expect(Object.fromEntries(result.current.draft)).toEqual({ name: "Bob" });
		expect(Object.fromEntries(result.current.submitted)).toEqual({});
		expect(result.current.hasSubmitted).toBe(false);
	});

	it("drops a stale answer when the prompt changes to an incompatible widget", () => {
		const textInput = inputWithDefault("Alice");
		const dateInput = simpleSearchInputDef(
			INPUT_UUID,
			"name",
			"Date",
			"date",
			"date_opened",
			{ default: term(dateLiteral("2026-07-16")) },
		);
		const { result, rerender } = renderHook(
			({ input }: { input: SearchInputDef }) =>
				useSearchInputRunState({
					scopeKey: "module-a",
					searchInputs: [input],
					session: SESSION,
				}),
			{ initialProps: { input: textInput as SearchInputDef } },
		);

		act(() => result.current.submit(new Map([["name", "Amara"]])));
		rerender({ input: dateInput });
		expect(Object.fromEntries(result.current.draft)).toEqual({
			name: "2026-07-16",
		});
		expect(Object.fromEntries(result.current.submitted)).toEqual({});
	});

	it("ends the submitted phase when the final search prompt is removed", () => {
		const { result, rerender } = renderHook(
			({ searchInputs }: { searchInputs: readonly SearchInputDef[] }) =>
				useSearchInputRunState({
					scopeKey: "module-a",
					searchInputs,
					session: SESSION,
				}),
			{ initialProps: { searchInputs: [inputWithDefault("Alice")] } },
		);

		act(() => result.current.submit(new Map([["name", "Alice"]])));
		expect(result.current.hasSubmitted).toBe(true);
		expect(result.current.queryActive).toBe(true);

		rerender({ searchInputs: [] });
		expect(result.current.hasSubmitted).toBe(false);
		expect(Object.fromEntries(result.current.draft)).toEqual({});
		expect(Object.fromEntries(result.current.submitted)).toEqual({});
	});
});

describe("useSearchInputRunState — hidden inputs", () => {
	it("keeps a hidden input out of the draft the form renders", () => {
		const { result } = renderHook(() =>
			useSearchInputRunState({
				scopeKey: "module-a",
				searchInputs: [inputWithDefault("Alice"), SEARCHED_BY],
				session: SESSION,
			}),
		);

		expect(Object.fromEntries(result.current.draft)).toEqual({ name: "Alice" });
		expect(Object.fromEntries(result.current.submitted)).toEqual({});
		expect(result.current.draftActive).toBe(true);
	});

	it("resolves hidden values at submit and carries them beside the answers", () => {
		const { result } = renderHook(() =>
			useSearchInputRunState({
				scopeKey: "module-a",
				searchInputs: [inputWithDefault("Alice"), SEARCHED_BY],
				session: SESSION,
			}),
		);

		act(() => result.current.submit(new Map([["name", "Amara"]])));
		expect(Object.fromEntries(result.current.submitted)).toEqual({
			name: "Amara",
			searched_by: "worker@example.org",
		});
		// The draft is still only what the worker can edit.
		expect(Object.fromEntries(result.current.draft)).toEqual({ name: "Amara" });
	});

	it("drops a worker-supplied value under a hidden input's key", () => {
		// The Search screen has no widget for a hidden input, so a value under
		// its key can only be stale or forged; the resolved system value wins.
		const { result } = renderHook(() =>
			useSearchInputRunState({
				scopeKey: "module-a",
				searchInputs: [inputWithDefault("Alice"), SEARCHED_BY],
				session: SESSION,
			}),
		);

		act(() =>
			result.current.changeDraft(
				new Map([
					["name", "Amara"],
					["searched_by", "someone-else"],
				]),
			),
		);
		expect(Object.fromEntries(result.current.draft)).toEqual({ name: "Amara" });

		act(() =>
			result.current.submit(
				new Map([
					["name", "Amara"],
					["searched_by", "someone-else"],
				]),
			),
		);
		expect(result.current.submitted.get("searched_by")).toBe(
			"worker@example.org",
		);
	});

	it("carries a hidden value even when every visible prompt is blank", () => {
		const { result } = renderHook(() =>
			useSearchInputRunState({
				scopeKey: "module-a",
				searchInputs: [inputWithDefault(""), SEARCHED_BY],
				session: SESSION,
			}),
		);

		act(() => result.current.submit(new Map()));
		expect(result.current.hasSubmitted).toBe(true);
		expect(Object.fromEntries(result.current.submitted)).toEqual({
			searched_by: "worker@example.org",
		});
	});

	it("reads a `now()` search time at the moment of each Search", () => {
		const searchTime = hiddenSearchInputDef(
			TIME_UUID,
			"search_time",
			"Search time",
			now(),
		);
		const { result } = renderHook(() =>
			useSearchInputRunState({
				scopeKey: "module-a",
				searchInputs: [inputWithDefault("Alice"), searchTime],
				session: SESSION,
			}),
		);

		act(() => result.current.submit(new Map([["name", "Alice"]])));
		const first = result.current.submitted.get("search_time");
		expect(first).toBeTruthy();
		expect(Number.isNaN(Date.parse(first ?? ""))).toBe(false);
	});

	it("clears hidden values with the rest of the search session", () => {
		const { result, rerender } = renderHook(
			({ scopeKey }) =>
				useSearchInputRunState({
					scopeKey,
					searchInputs: [inputWithDefault("Alice"), SEARCHED_BY],
					session: SESSION,
				}),
			{ initialProps: { scopeKey: "module-a" } },
		);

		act(() => result.current.submit(new Map([["name", "Alice"]])));
		expect(result.current.submitted.has("searched_by")).toBe(true);

		act(() => result.current.clear());
		expect(Object.fromEntries(result.current.submitted)).toEqual({});

		act(() => result.current.submit(new Map([["name", "Alice"]])));
		expect(result.current.submitted.has("searched_by")).toBe(true);
		rerender({ scopeKey: "module-b" });
		expect(Object.fromEntries(result.current.submitted)).toEqual({});
	});
});
