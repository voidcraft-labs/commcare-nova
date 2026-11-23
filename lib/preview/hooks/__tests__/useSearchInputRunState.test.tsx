// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
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
import { openSearchRangesAction } from "@/lib/preview/engine/openSearchRangesAction";
import { isRangeWithDefault } from "@/lib/preview/engine/searchRangeOpening";
import { useSearchInputRunState } from "../useSearchInputRunState";

vi.mock("@/lib/preview/engine/openSearchRangesAction", () => ({
	openSearchRangesAction: vi.fn(),
}));

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

it("hands a new revision of the screen one query reference, from its first render through the commit that stores it", () => {
	/* A screen that adjusts its own state during render when the query
	 * reference moves (the case list's place on a search run again) settles
	 * only if each render of one revision reads one reference. */
	const environment = runEnvironment(searchInputs);
	const revised = [
		...searchInputs,
		simpleSearchInputDef(
			testUuid("00000000-0000-4000-8000-000000000203"),
			"village",
			"Village",
			"text",
			"village",
		),
	];
	const observed: {
		inputs: readonly SearchInputDef[];
		submitted: ReadonlyMap<string, string>;
	}[] = [];
	const { result, rerender } = renderHook(
		({ inputs }) => {
			const state = useSearchInputRunState({
				scopeKey: "module",
				searchInputs: inputs,
				session,
				environment,
			});
			observed.push({ inputs, submitted: state.submitted });
			return state;
		},
		{ initialProps: { inputs: searchInputs as readonly SearchInputDef[] } },
	);
	act(() => result.current.submit(new Map([["name", "Alice"]])));
	rerender({ inputs: revised });
	const references = new Set(
		observed
			.filter((item) => item.inputs === revised)
			.map((item) => item.submitted),
	);
	expect(references.size).toBe(1);
	expect(result.current.submitted.get("name")).toBe("Alice");
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

it("keeps opening dates and their receipt through an unrelated refresh and reads a new menu opening", async () => {
	const source = term(sessionContext("userid"));
	const uuid = testUuid("held-range");
	const fields = [
		simpleSearchInputDef(uuid, "period", "Dates", "date-range", "period", {
			default: source,
		}),
	];
	const environment = runEnvironment(fields);
	const field =
		environment.doc.modules[environment.moduleUuid].caseListConfig
			?.searchInputs[0];
	if (!field || !isRangeWithDefault(field))
		throw new Error("Expected a range with a default.");
	let week = "first week";
	vi.mocked(openSearchRangesAction)
		.mockImplementation(async () => ({
			kind: "opened",
			fields: [
				{
					field,
					answers: {
						"period:starting": week,
						"period:opening": week + " proof",
					},
				},
			],
		}))
		.mockResolvedValueOnce({
			kind: "opened",
			fields: [
				{
					field: { ...field, label: "Previous label" },
					answers: { "period:starting": "obsolete dates" },
				},
			],
		});
	const { result, rerender, unmount } = renderHook(
		({ scope, active }) =>
			useSearchInputRunState({
				scopeKey: scope,
				searchInputs: fields,
				session,
				environment: { ...environment },
				rangeTarget: active
					? { appId: "demo", device: webAppsDevice() }
					: undefined,
			}),
		{ initialProps: { scope: "menu one", active: true } },
	);
	try {
		await waitFor(() => expect(result.current.retryOpening).toBeDefined());
		expect(result.current.pending).toBe(true);
		act(() => result.current.retryOpening?.());
		await waitFor(() =>
			expect(result.current.draft.get("period:starting")).toBe("first week"),
		);
		act(() => result.current.submit(result.current.draft));
		week = "second week";
		rerender({ scope: "menu one", active: true });
		expect(result.current.submitted.get("period:opening")).toBe(
			"first week proof",
		);
		expect(openSearchRangesAction).toHaveBeenCalledTimes(2);
		rerender({ scope: "menu two", active: false });
		rerender({ scope: "menu one again", active: true });
		await waitFor(() =>
			expect(result.current.draft.get("period:starting")).toBe("second week"),
		);
		expect(openSearchRangesAction).toHaveBeenCalledTimes(3);
	} finally {
		unmount();
		vi.mocked(openSearchRangesAction).mockReset();
	}
});
