// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { hiddenSearchInputDef, simpleSearchInputDef } from "@/lib/domain";
import { sessionContext, term } from "@/lib/domain/predicate";
import {
	previewAsMe,
	previewSessionValues,
} from "@/lib/preview/engine/identity";
import { useSearchInputRunState } from "../useSearchInputRunState";

const searchInputs = [
	simpleSearchInputDef(
		testUuid("00000000-0000-4000-8000-000000000201"),
		"name",
		"Name",
		"text",
		"case_name",
	),
];
const session = previewSessionValues(
	previewAsMe({
		id: "worker-1",
		name: "Worker One",
		email: "worker@example.org",
	}),
);

it("keeps the query reference stable across draft renders and masks an old scope during render", () => {
	const observed: { scope: string; submitted: ReadonlyMap<string, string> }[] =
		[];
	const { result, rerender } = renderHook(
		({ scope }) => {
			const state = useSearchInputRunState({
				scopeKey: scope,
				searchInputs,
				session,
			});
			observed.push({ scope, submitted: state.submitted });
			return state;
		},
		{ initialProps: { scope: "module-a" } },
	);
	act(() => result.current.submit(new Map([["name", "Alice"]])));
	const submitted = result.current.submitted;
	act(() => result.current.changeDraft(new Map([["name", "Ada"]])));
	expect(result.current.submitted).toBe(submitted);
	rerender({ scope: "module-b" });
	expect(
		observed
			.filter((item) => item.scope === "module-b")
			.every((item) => item.submitted.size === 0),
	).toBe(true);
});

it("validates a prospective search with the latest identity while preserving the standing search", () => {
	const inputs = [
		...searchInputs,
		hiddenSearchInputDef(
			testUuid("00000000-0000-4000-8000-000000000202"),
			"run_by",
			"Run by",
			term(sessionContext("username")),
		),
	];
	const { result, rerender } = renderHook(
		({ identity }) =>
			useSearchInputRunState({
				scopeKey: "module",
				searchInputs: inputs,
				session: identity,
			}),
		{ initialProps: { identity: session } },
	);
	act(() => result.current.submit(new Map([["name", "Alice"]])));
	const standing = result.current.submitted;
	const nextIdentity = previewSessionValues(
		previewAsMe({
			id: "worker-2",
			name: "Second Worker",
			email: "next@example.org",
		}),
	);
	rerender({ identity: nextIdentity });
	expect(result.current.resolveHidden().get("run_by")).toBe("next@example.org");
	expect(result.current.submitted).toBe(standing);
	expect(result.current.submitted.get("run_by")).toBe("worker@example.org");
	act(() => result.current.submit(new Map([["name", "Ada"]])));
	expect(result.current.submitted.get("run_by")).toBe("next@example.org");
});
