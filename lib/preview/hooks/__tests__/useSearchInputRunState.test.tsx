// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import {
	promptLookupContext,
	promptLookupRows,
	searchPromptWorkerPlaceFixture,
	WORKER_PLACE_SEARCH_MENUS,
} from "@/lib/commcare/__tests__/searchPromptFixture";
import type { SearchInputDef } from "@/lib/domain";
import { hiddenSearchInputDef, simpleSearchInputDef } from "@/lib/domain";
import { sessionContext, term } from "@/lib/domain/expression";
import { webAppsDevice } from "@/lib/preview/engine/__tests__/fixtures/previewDevices";
import {
	previewAsMe,
	previewSessionValues,
} from "@/lib/preview/engine/identity";
import { previewLookupData } from "@/lib/preview/engine/lookupEvaluation";
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
	webAppsDevice(),
);

it("keeps the query reference stable across draft renders and masks an old scope during render", () => {
	const environment = runEnvironment(searchInputs);
	const observed: { scope: string; submitted: ReadonlyMap<string, string> }[] =
		[];
	const { result, rerender } = renderHook(
		({ scope }) => {
			const state = useSearchInputRunState({
				scopeKey: scope,
				searchInputs,
				session,
				environment,
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
	const environment = runEnvironment(inputs);
	const { result, rerender } = renderHook(
		({ identity }) =>
			useSearchInputRunState({
				scopeKey: "module",
				searchInputs: inputs,
				session: identity,
				environment,
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
		webAppsDevice(),
	);
	rerender({ identity: nextIdentity });
	expect(result.current.resolveHidden().get("run_by")).toBe("next@example.org");
	expect(result.current.submitted).toBe(standing);
	expect(result.current.submitted.get("run_by")).toBe("worker@example.org");
	act(() => result.current.submit(new Map([["name", "Ada"]])));
	expect(result.current.submitted.get("run_by")).toBe("next@example.org");
});

it("waits for the lookup data its choice lists read, then refuses an empty table as the screen opens", () => {
	/* Skip to results launches its default search only once the screen has
	 * opened (`caseListPhase.ts::caseListLaunchesDefaultSearch` reads
	 * `pending`), so a choice list Core refuses as Formplayer's query screen
	 * is built (`QueryScreen.init`) refuses before any search runs. */
	const doc = searchPromptWorkerPlaceFixture();
	const moduleUuid =
		doc.moduleOrder[WORKER_PLACE_SEARCH_MENUS.indexOf("choices")];
	const inputs = doc.modules[moduleUuid]?.caseListConfig?.searchInputs ?? [];
	if (promptLookupContext.kind !== "available")
		throw new Error("The prompt fixture holds its lookup tables.");
	const empty = previewLookupData({
		projectRevision: "1",
		definitions: promptLookupContext.definitions,
		rowsByTable: new Map(
			[...promptLookupRows].map(([tableId]) => [tableId, []]),
		),
	});
	const { result, rerender } = renderHook(
		({ lookup, failed }) =>
			useSearchInputRunState({
				scopeKey: "choices",
				searchInputs: inputs,
				session,
				environment: {
					doc,
					moduleUuid,
					...(lookup !== undefined && { lookup }),
				},
				lookupLoadFailed: failed,
			}),
		{
			initialProps: {
				lookup: undefined as typeof empty | undefined,
				failed: false,
			},
		},
	);
	expect(result.current.pending).toBe(true);
	expect(result.current.refusal).toBeUndefined();
	rerender({ lookup: empty, failed: false });
	expect(result.current.pending).toBeUndefined();
	expect(result.current.refusal).toBeDefined();
	// A failed lookup load opens the screen over what it holds, never waiting.
	rerender({ lookup: undefined, failed: true });
	expect(result.current.pending).toBeUndefined();
	expect(result.current.refusal).toBeUndefined();
});

function runEnvironment(inputs: readonly SearchInputDef[]) {
	const doc = buildDoc({
		caseTypes: [{ name: "person", properties: [] }],
		modules: [
			{
				name: "People",
				caseType: "person",
				caseListConfig: { ...caseListConfig([]), searchInputs: [...inputs] },
			},
		],
	});
	return { doc, moduleUuid: doc.moduleOrder[0] };
}
