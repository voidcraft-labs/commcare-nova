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
//      matching the JSDoc'd "not wrapped in `useCallback`" contract —
//      callers pass a fresh-per-render `blueprint` projection, so a
//      memoized callback would invalidate every render anyway and the
//      memoization would be structurally empty.
//   2. Any undefined arg short-circuits to the typed `error` arm with
//      the verbatim user-actionable message. The Server Action is NOT
//      called along that path.
//   3. With all args populated, the hook forwards `(appId, caseType,
//      blueprint)` verbatim to `resetSampleCasesAction` and returns the
//      action's resolved result.

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BlueprintDoc } from "@/lib/domain";

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

/**
 * Minimal `BlueprintDoc` literal — the hook never reads the
 * blueprint's shape; it only forwards the reference to the Server
 * Action. A literal with the required slots keeps the test fixture
 * cheap and decoupled from the case-store's full case-type
 * generator.
 */
const BLUEPRINT: BlueprintDoc = {
	appId: APP_ID,
	appName: "hook test app",
	connectType: null,
	caseTypes: [{ name: "patient", properties: [] }],
	modules: {},
	forms: {},
	fields: {},
	moduleOrder: [],
	formOrder: {},
	fieldOrder: {},
	fieldParent: {},
};

beforeEach(() => {
	vi.mocked(resetSampleCasesAction).mockReset();
});

describe("useResetSampleCases", () => {
	it("returns a fresh callback reference on every render", () => {
		// The JSDoc'd contract: the hook is NOT wrapped in
		// `useCallback`, so consecutive renders MUST yield distinct
		// callback identities. Memoizing here would invalidate every
		// render against a fresh-per-render `blueprint` projection, so
		// the contract is structural.
		const { result, rerender } = renderHook(() =>
			useResetSampleCases({
				appId: APP_ID,
				caseType: "patient",
				blueprint: BLUEPRINT,
			}),
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
			useResetSampleCases({
				appId: undefined,
				caseType: "patient",
				blueprint: BLUEPRINT,
			}),
		);
		const action = result.current;
		const outcome = await action();
		expect(outcome).toEqual({
			kind: "error",
			message: "App, case type, or blueprint not yet available.",
		});
		expect(vi.mocked(resetSampleCasesAction)).not.toHaveBeenCalled();
	});

	it("returns the typed error arm without calling the action when caseType is undefined", async () => {
		const { result } = renderHook(() =>
			useResetSampleCases({
				appId: APP_ID,
				caseType: undefined,
				blueprint: BLUEPRINT,
			}),
		);
		const outcome = await result.current();
		expect(outcome).toEqual({
			kind: "error",
			message: "App, case type, or blueprint not yet available.",
		});
		expect(vi.mocked(resetSampleCasesAction)).not.toHaveBeenCalled();
	});

	it("returns the typed error arm without calling the action when blueprint is undefined", async () => {
		const { result } = renderHook(() =>
			useResetSampleCases({
				appId: APP_ID,
				caseType: "patient",
				blueprint: undefined,
			}),
		);
		const outcome = await result.current();
		expect(outcome).toEqual({
			kind: "error",
			message: "App, case type, or blueprint not yet available.",
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
			useResetSampleCases({
				appId: APP_ID,
				caseType: "patient",
				blueprint: BLUEPRINT,
			}),
		);
		const outcome = await result.current();
		expect(outcome).toEqual({ kind: "ok", inserted: 30 });
		expect(vi.mocked(resetSampleCasesAction)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(resetSampleCasesAction)).toHaveBeenCalledWith(
			APP_ID,
			"patient",
			BLUEPRINT,
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
			useResetSampleCases({
				appId: APP_ID,
				caseType: "patient",
				blueprint: BLUEPRINT,
			}),
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
			useResetSampleCases({
				appId: APP_ID,
				caseType: "patient",
				blueprint: BLUEPRINT,
			}),
		);
		const outcome = await result.current();
		expect(outcome).toEqual({ kind: "error", message: "connection refused" });
	});
});
