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

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseType } from "@/lib/domain";

// The hook imports a Server Action from a `"use server"` module.
// Vitest's `vi.mock` is hoisted above every import, so the mocked
// surface is what `useResetSampleCases` resolves at call time. Each
// test sets `mockResolvedValueOnce` against the action it wants to
// drive.
vi.mock("@/lib/preview/engine/caseDataBinding", () => ({
	loadCasesAction: vi.fn(),
	loadCaseDataAction: vi.fn(),
	populateSampleCasesAction: vi.fn(),
	resetSampleCasesAction: vi.fn(),
}));

import { resetSampleCasesAction } from "@/lib/preview/engine/caseDataBinding";
import { useResetSampleCases } from "../useCaseDataBinding";

const APP_ID = "app-hook-test";

/** The live `CaseType` definition the hook forwards verbatim to the
 *  action — the hook never reads its shape, so an empty-property literal
 *  keeps the fixture cheap. */
const PATIENT: CaseType = { name: "patient", properties: [] };

beforeEach(() => {
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
