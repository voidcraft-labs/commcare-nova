// @vitest-environment happy-dom

// lib/preview/hooks/__tests__/useCaseDataBinding.test.tsx
//
// Contract tests for the running-app view's hook layer. The hooks
// curry Server Actions into callbacks the React tree consumes; the
// actions themselves are tested separately against `caseDataBinding.ts`.
//
// `useResetSampleCases` pins the structural contract the consuming
// `CaseListScreen` "Reset sample data" affordance depends on:
//
//   1. The hook returns a fresh callback reference on every render,
//      matching the JSDoc'd "not memoized" contract.
//   2. Any undefined identifier short-circuits to the typed `error`
//      arm with the verbatim user-actionable message. The Server
//      Action is NOT called along that path.
//   3. With the args populated, the hook forwards `(appId, caseType)`
//      verbatim to `resetSampleCasesAction` — `caseType` is the live
//      `CaseType` definition the client passes through (never the whole
//      blueprint) — and returns the action's resolved result.

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseType } from "@/lib/domain";

// The hook imports a Server Action from a `"use server"` module.
// Vitest's `vi.mock` is hoisted above every import, so the mocked
// surface is what `useResetSampleCases` resolves at call time. Each
// test sets `mockResolvedValueOnce` against the action it wants to
// drive.
vi.mock("@/lib/preview/engine/caseDataBinding", () => ({
	loadCaseCountAction: vi.fn(),
	loadCasesAction: vi.fn(),
	loadCaseDataAction: vi.fn(),
	populateSampleCasesAction: vi.fn(),
	resetSampleCasesAction: vi.fn(),
}));

import {
	loadCaseCountAction,
	loadCaseDataAction,
	loadCasesAction,
	resetSampleCasesAction,
} from "@/lib/preview/engine/caseDataBinding";
import {
	invalidateCaseData,
	useCaseDataReplacementRevision,
	useCaseDataRevision,
} from "../caseDataInvalidation";
import {
	useCaseCount,
	useCaseData,
	useCases,
	useResetSampleCases,
} from "../useCaseDataBinding";

const APP_ID = "app-hook-test";

/** The live `CaseType` definition the hook forwards verbatim to the
 *  action — the hook never reads its shape, so an empty-property literal
 *  keeps the fixture cheap. */
const PATIENT: CaseType = { name: "patient", properties: [] };

beforeEach(() => {
	vi.mocked(loadCaseCountAction).mockReset();
	vi.mocked(loadCaseDataAction).mockReset();
	vi.mocked(loadCasesAction).mockReset();
	vi.mocked(resetSampleCasesAction).mockReset();
});

describe("useResetSampleCases", () => {
	it("returns a fresh callback reference on every render", () => {
		// The JSDoc'd contract: the hook is NOT memoized, so consecutive
		// renders MUST yield distinct callback identities.
		const { result, rerender } = renderHook(() =>
			useResetSampleCases({ appId: APP_ID, caseType: PATIENT }),
		);
		const first = result.current;
		rerender();
		const second = result.current;
		expect(second).not.toBe(first);
	});

	it("returns the typed error arm without calling the action when appId is undefined", async () => {
		// The undefined-arg short-circuit guards the
		// app-not-yet-hydrated path. The verbatim message string mirrors
		// `usePopulateSampleCases` so the consumer renders the same
		// fallback regardless of which affordance the user pressed.
		const { result } = renderHook(() =>
			useResetSampleCases({ appId: undefined, caseType: PATIENT }),
		);
		const action = result.current;
		const outcome = await action();
		expect(outcome).toEqual({
			kind: "error",
			message: "App or case type not yet available.",
		});
		expect(vi.mocked(resetSampleCasesAction)).not.toHaveBeenCalled();
	});

	it("returns the typed error arm without calling the action when caseType is undefined", async () => {
		const { result } = renderHook(() =>
			useResetSampleCases({ appId: APP_ID, caseType: undefined }),
		);
		const outcome = await result.current();
		expect(outcome).toEqual({
			kind: "error",
			message: "App or case type not yet available.",
		});
		expect(vi.mocked(resetSampleCasesAction)).not.toHaveBeenCalled();
	});

	it("forwards args to resetSampleCasesAction and returns its resolved result on the success path", async () => {
		// Drive the success arm. The hook is a thin curry; the test
		// pins both forwarded-args and the resolved-result passthrough.
		vi.mocked(resetSampleCasesAction).mockResolvedValueOnce({
			kind: "ok",
			inserted: 30,
		});
		const { result } = renderHook(() =>
			useResetSampleCases({ appId: APP_ID, caseType: PATIENT }),
		);
		const outcome = await result.current();
		expect(outcome).toEqual({ kind: "ok", inserted: 30 });
		expect(vi.mocked(resetSampleCasesAction)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(resetSampleCasesAction)).toHaveBeenCalledWith(
			APP_ID,
			PATIENT,
		);
	});

	it("invalidates every subscriber for the case type after a successful reset", async () => {
		vi.mocked(resetSampleCasesAction).mockResolvedValueOnce({
			kind: "ok",
			inserted: 30,
		});
		const revision = renderHook(() =>
			useCaseDataRevision(APP_ID, PATIENT.name),
		);
		const before = revision.result.current;
		const replacementRevision = renderHook(() =>
			useCaseDataReplacementRevision(APP_ID, PATIENT.name),
		);
		const replacementBefore = replacementRevision.result.current;
		const reset = renderHook(() =>
			useResetSampleCases({ appId: APP_ID, caseType: PATIENT }),
		);

		await act(async () => {
			await reset.result.current();
		});

		expect(revision.result.current).toBe(before + 1);
		expect(replacementRevision.result.current).toBe(replacementBefore + 1);
	});

	it("passes through the unauthenticated arm from the action", async () => {
		// `unauthenticated` is the action's session-absent arm. The
		// hook surfaces it verbatim — the consumer dispatches the same
		// way it would for the populate affordance.
		vi.mocked(resetSampleCasesAction).mockResolvedValueOnce({
			kind: "unauthenticated",
		});
		const { result } = renderHook(() =>
			useResetSampleCases({ appId: APP_ID, caseType: PATIENT }),
		);
		const outcome = await result.current();
		expect(outcome).toEqual({ kind: "unauthenticated" });
	});

	it("passes through the generic error arm from the action", async () => {
		// The generic `error` arm covers wire-level rejections + non-
		// typed throws inside the action. The hook surfaces the
		// message verbatim so the consumer can render it without
		// re-mapping.
		vi.mocked(resetSampleCasesAction).mockResolvedValueOnce({
			kind: "error",
			message: "connection refused",
		});
		const { result } = renderHook(() =>
			useResetSampleCases({ appId: APP_ID, caseType: PATIENT }),
		);
		const outcome = await result.current();
		expect(outcome).toEqual({ kind: "error", message: "connection refused" });
	});
});

describe("useCases query constraints", () => {
	it("keeps a legacy action result neutral when constraint metadata is unavailable", async () => {
		vi.mocked(loadCasesAction).mockResolvedValueOnce({ kind: "empty" });
		const hook = renderHook(() =>
			useCases({ appId: APP_ID, caseType: PATIENT.name }),
		);

		await waitFor(() => expect(hook.result.current.state.kind).toBe("empty"));
		expect(hook.result.current.state).toEqual({ kind: "empty" });
		expect(hook.result.current.queryConstraintSource).toBe("unknown");
	});
});

describe("case-data invalidation", () => {
	it("hides the prior selected row synchronously when its revision changes", async () => {
		let resolveReload: ((value: { kind: "missing" }) => void) | undefined;
		vi.mocked(loadCaseDataAction)
			.mockResolvedValueOnce({
				kind: "row",
				row: {
					case_id: "case-1",
					app_id: APP_ID,
					case_type: PATIENT.name,
					owner_id: "owner-1",
					status: "open",
					opened_on: null,
					modified_on: null,
					closed_on: null,
					case_name: "Alice",
					external_id: null,
					parent_case_id: null,
					properties: {},
				},
				ancestors: [],
			})
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveReload = resolve;
					}),
			);
		const selected = renderHook(() =>
			useCaseData({
				appId: APP_ID,
				caseType: PATIENT.name,
				caseId: "case-1",
				ancestorDepth: 0,
			}),
		);

		await waitFor(() => expect(selected.result.current.state.kind).toBe("row"));
		act(() => invalidateCaseData(APP_ID, PATIENT.name));
		/* The invalidation render returns `loading` before the refetch effect
		 * settles, never the row from the prior revision. */
		expect(selected.result.current.state).toEqual({ kind: "loading" });

		await act(async () => resolveReload?.({ kind: "missing" }));
		await waitFor(() =>
			expect(selected.result.current.state).toEqual({ kind: "missing" }),
		);
	});

	it("reloads the unfiltered count, list rows, and selected case after a write", async () => {
		vi.mocked(loadCaseCountAction).mockResolvedValue({
			kind: "count",
			count: 4,
		});
		vi.mocked(loadCasesAction).mockResolvedValue({ kind: "empty" });
		vi.mocked(loadCaseDataAction).mockResolvedValue({ kind: "missing" });

		const countHook = renderHook(() =>
			useCaseCount({ appId: APP_ID, caseType: PATIENT.name }),
		);
		const casesHook = renderHook(() =>
			useCases({ appId: APP_ID, caseType: PATIENT.name }),
		);
		const caseHook = renderHook(() =>
			useCaseData({
				appId: APP_ID,
				caseType: PATIENT.name,
				caseId: "case-1",
				ancestorDepth: 0,
			}),
		);

		await waitFor(() => {
			expect(countHook.result.current.state).toEqual({
				kind: "count",
				count: 4,
			});
			expect(casesHook.result.current.state).toEqual({ kind: "empty" });
			expect(caseHook.result.current.state).toEqual({ kind: "missing" });
		});
		expect(loadCaseCountAction).toHaveBeenCalledTimes(1);
		expect(loadCasesAction).toHaveBeenCalledTimes(1);
		expect(loadCaseDataAction).toHaveBeenCalledTimes(1);

		act(() => invalidateCaseData(APP_ID, PATIENT.name));

		await waitFor(() => {
			expect(loadCaseCountAction).toHaveBeenCalledTimes(2);
			expect(loadCasesAction).toHaveBeenCalledTimes(2);
			expect(loadCaseDataAction).toHaveBeenCalledTimes(2);
		});
	});

	it("keeps invalidation scoped to the written case type", async () => {
		vi.mocked(loadCaseCountAction).mockResolvedValue({
			kind: "count",
			count: 2,
		});
		renderHook(() => useCaseCount({ appId: APP_ID, caseType: "visit" }));
		await waitFor(() => expect(loadCaseCountAction).toHaveBeenCalledTimes(1));

		act(() => invalidateCaseData(APP_ID, PATIENT.name));

		await Promise.resolve();
		expect(loadCaseCountAction).toHaveBeenCalledTimes(1);
	});
});
