// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	asUuid,
	type SearchInputDef,
	simpleSearchInputDef,
} from "@/lib/domain";
import { dateLiteral, literal, term } from "@/lib/domain/predicate";
import { previewSearchSessionValues } from "@/lib/preview/engine/searchExpressionEvaluation";
import { useSearchInputRunState } from "../useSearchInputRunState";

const INPUT_UUID = asUuid("00000000-0000-4000-8000-000000000201");
const SESSION = previewSearchSessionValues({
	id: "worker-1",
	name: "Worker One",
	email: "worker@example.org",
});

function inputWithDefault(value: string) {
	return simpleSearchInputDef(INPUT_UUID, "name", "Name", "text", "case_name", {
		default: term(literal(value)),
	});
}

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
});
