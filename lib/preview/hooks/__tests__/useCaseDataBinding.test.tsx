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
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReconcilerContext } from "@/lib/collab/context";
import type { CaseListConfig, CaseType } from "@/lib/domain";
import { literal, matchAll, term } from "@/lib/domain/predicate";
import type { LoadCasesResult } from "@/lib/preview/engine/caseDataBindingTypes";
import { BuilderSessionContext } from "@/lib/session/provider";
import { createBuilderSessionStore } from "@/lib/session/store";

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
	it("masks source-Project rows at the epoch boundary and rejects their late settle", async () => {
		let resolveSource: ((value: LoadCasesResult) => void) | undefined;
		let resolveDestination: ((value: LoadCasesResult) => void) | undefined;
		vi.mocked(loadCasesAction)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveSource = resolve;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveDestination = resolve;
					}),
			);
		const store = createBuilderSessionStore({ appId: APP_ID });
		const wrapper = ({ children }: { children: ReactNode }) => (
			<BuilderSessionContext value={store}>{children}</BuilderSessionContext>
		);
		const hook = renderHook(
			() => useCases({ appId: APP_ID, caseType: PATIENT.name }),
			{ wrapper },
		);

		await waitFor(() => expect(loadCasesAction).toHaveBeenCalledTimes(1));
		act(() => {
			store.getState().beginAccessRefresh();
		});
		// The epoch is part of the render identity, so no effect must run before
		// source rows disappear.
		expect(hook.result.current.state).toEqual({ kind: "loading" });
		/* The new epoch is intentionally dormant until GET installs its atomic
		 * Project/role/doc snapshot. A pre-snapshot read could otherwise publish
		 * source-authorized data under the destination generation. */
		await Promise.resolve();
		expect(loadCasesAction).toHaveBeenCalledTimes(1);

		await act(async () => {
			resolveSource?.({
				kind: "rows",
				rows: [
					{
						case_id: "source-case",
						app_id: APP_ID,
						case_type: PATIENT.name,
						owner_id: "source-owner",
						status: "open",
						opened_on: null,
						modified_on: null,
						closed_on: null,
						case_name: "Source household",
						external_id: null,
						parent_case_id: null,
						properties: {},
						calculated: {},
					},
				],
				constraintSource: "unconstrained",
			});
		});
		expect(hook.result.current.state).toEqual({ kind: "loading" });
		act(() => {
			store.getState().applyAccessSnapshot({
				projectId: "destination-project",
				role: "editor",
				canEdit: true,
			});
		});
		await waitFor(() => expect(loadCasesAction).toHaveBeenCalledTimes(2));

		await act(async () => {
			resolveDestination?.({
				kind: "empty",
				constraintSource: "unconstrained",
			});
		});
		await waitFor(() =>
			expect(hook.result.current.state).toEqual({
				kind: "empty",
				constraintSource: "unconstrained",
			}),
		);
	});

	it("keeps a legacy action result neutral when constraint metadata is unavailable", async () => {
		vi.mocked(loadCasesAction).mockResolvedValueOnce({ kind: "empty" });
		const hook = renderHook(() =>
			useCases({ appId: APP_ID, caseType: PATIENT.name }),
		);

		await waitFor(() => expect(hook.result.current.state.kind).toBe("empty"));
		expect(hook.result.current.state).toEqual({ kind: "empty" });
		expect(hook.result.current.queryConstraintSource).toBe("unknown");
	});

	it("forwards a bounded page and treats a page change as a request identity boundary", async () => {
		let resolveNext:
			| ((value: {
					kind: "rows";
					rows: [];
					totalCount: number;
					pageOffset: number;
					pageSize: number;
			  }) => void)
			| undefined;
		vi.mocked(loadCasesAction)
			.mockResolvedValueOnce({
				kind: "rows",
				rows: [],
				totalCount: 75,
				pageOffset: 0,
				pageSize: 50,
			})
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveNext = resolve;
					}),
			);
		let page = { offset: 0, limit: 50 };
		const hook = renderHook(() =>
			useCases({ appId: APP_ID, caseType: PATIENT.name, page }),
		);

		await waitFor(() => expect(hook.result.current.state.kind).toBe("rows"));
		expect(loadCasesAction).toHaveBeenLastCalledWith(
			expect.objectContaining({ page: { offset: 0, limit: 50 } }),
		);

		page = { offset: 50, limit: 50 };
		hook.rerender();
		expect(hook.result.current.state).toEqual({ kind: "loading" });
		expect(loadCasesAction).toHaveBeenLastCalledWith(
			expect.objectContaining({ page: { offset: 50, limit: 50 } }),
		);

		await act(async () =>
			resolveNext?.({
				kind: "rows",
				rows: [],
				totalCount: 75,
				pageOffset: 50,
				pageSize: 50,
			}),
		);
		await waitFor(() =>
			expect(hook.result.current.state).toMatchObject({
				kind: "rows",
				pageOffset: 50,
			}),
		);
	});

	it("keeps reload dependencies fixed-length when pagination appears", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "empty",
			constraintSource: "unconstrained",
		});
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		let page: { offset: number; limit: number } | undefined;
		try {
			const hook = renderHook(() =>
				useCases({ appId: APP_ID, caseType: PATIENT.name, page }),
			);
			await waitFor(() => expect(hook.result.current.state.kind).toBe("empty"));

			page = { offset: 0, limit: 50 };
			hook.rerender();
			await waitFor(() => expect(hook.result.current.state.kind).toBe("empty"));

			expect(
				consoleError.mock.calls.some((call) =>
					call.some(
						(value) =>
							typeof value === "string" &&
							value.includes("changed size between renders"),
					),
				),
			).toBe(false);
		} finally {
			consoleError.mockRestore();
		}
	});

	it("keeps the reload effect fixed-length when Results rules hydrate after mount", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "empty",
			constraintSource: "unconstrained",
		});
		const consoleError = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		let caseListConfig: CaseListConfig | undefined;
		let excludedOwnerIdsExpression: ReturnType<typeof term> | undefined;
		let caseTypes: readonly CaseType[] | undefined;
		try {
			const hook = renderHook(() =>
				useCases({
					appId: APP_ID,
					caseType: PATIENT.name,
					caseListConfig,
					excludedOwnerIdsExpression,
					caseTypes,
				}),
			);
			await waitFor(() => expect(loadCasesAction).toHaveBeenCalledTimes(1));

			caseListConfig = {
				columns: [],
				searchInputs: [],
				filter: matchAll(),
			};
			excludedOwnerIdsExpression = term(literal("owner-a"));
			caseTypes = [PATIENT];
			hook.rerender();

			await waitFor(() => expect(loadCasesAction).toHaveBeenCalledTimes(2));
			expect(loadCasesAction).toHaveBeenLastCalledWith(
				expect.objectContaining({
					caseListConfig,
					excludedOwnerIdsExpression,
					caseTypes,
				}),
			);
			expect(
				consoleError.mock.calls.some((call) =>
					call.some(
						(value) =>
							typeof value === "string" &&
							value.includes("changed size between renders"),
					),
				),
			).toBe(false);
		} finally {
			consoleError.mockRestore();
		}
	});

	it("does not reload for a fresh page object with unchanged primitive values", async () => {
		vi.mocked(loadCasesAction).mockResolvedValue({
			kind: "empty",
			constraintSource: "unconstrained",
		});
		const hook = renderHook(() =>
			useCases({
				appId: APP_ID,
				caseType: PATIENT.name,
				page: { offset: 0, limit: 50 },
			}),
		);

		await waitFor(() => expect(hook.result.current.state.kind).toBe("empty"));
		expect(loadCasesAction).toHaveBeenCalledTimes(1);
		hook.rerender();
		await Promise.resolve();
		expect(loadCasesAction).toHaveBeenCalledTimes(1);
	});

	it("hides rows synchronously when the app or case type changes", async () => {
		let resolveNext:
			| ((value: { kind: "empty"; constraintSource: "unconstrained" }) => void)
			| undefined;
		vi.mocked(loadCasesAction)
			.mockResolvedValueOnce({
				kind: "rows",
				rows: [],
				constraintSource: "unconstrained",
			})
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveNext = resolve;
					}),
			);
		let identity = { appId: APP_ID, caseType: PATIENT.name };
		const hook = renderHook(() => useCases(identity));

		await waitFor(() => expect(hook.result.current.state.kind).toBe("rows"));
		identity = { appId: "other-app", caseType: "visit" };
		hook.rerender();

		expect(hook.result.current.state).toEqual({ kind: "loading" });
		expect(hook.result.current.queryConstraintSource).toBe("unconstrained");

		await act(async () =>
			resolveNext?.({ kind: "empty", constraintSource: "unconstrained" }),
		);
		await waitFor(() => expect(hook.result.current.state.kind).toBe("empty"));
	});

	it("does not carry rows between modules that share a case type", async () => {
		let resolveNext:
			| ((value: { kind: "empty"; constraintSource: "authored-rules" }) => void)
			| undefined;
		vi.mocked(loadCasesAction)
			.mockResolvedValueOnce({
				kind: "rows",
				rows: [],
				constraintSource: "unconstrained",
			})
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveNext = resolve;
					}),
			);
		let requestScopeKey = "module-a";
		const hook = renderHook(() =>
			useCases({
				appId: APP_ID,
				caseType: PATIENT.name,
				requestScopeKey,
			}),
		);

		await waitFor(() => expect(hook.result.current.state.kind).toBe("rows"));
		requestScopeKey = "module-b";
		hook.rerender();
		expect(hook.result.current.state).toEqual({ kind: "loading" });

		await act(async () =>
			resolveNext?.({ kind: "empty", constraintSource: "authored-rules" }),
		);
		await waitFor(() => expect(hook.result.current.state.kind).toBe("empty"));
	});

	it("hides deleted rows synchronously after a population replacement", async () => {
		let resolveNext:
			| ((value: { kind: "empty"; constraintSource: "unconstrained" }) => void)
			| undefined;
		vi.mocked(loadCasesAction)
			.mockResolvedValueOnce({
				kind: "rows",
				rows: [],
				constraintSource: "unconstrained",
			})
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveNext = resolve;
					}),
			);
		const hook = renderHook(() =>
			useCases({
				appId: APP_ID,
				caseType: PATIENT.name,
				requestScopeKey: "module-a",
			}),
		);

		await waitFor(() => expect(hook.result.current.state.kind).toBe("rows"));
		act(() => invalidateCaseData(APP_ID, PATIENT.name, "replacement"));
		expect(hook.result.current.state).toEqual({ kind: "loading" });

		await act(async () =>
			resolveNext?.({ kind: "empty", constraintSource: "unconstrained" }),
		);
		await waitFor(() => expect(hook.result.current.state.kind).toBe("empty"));
	});
});

describe("useCaseCount request identity", () => {
	it("does not dedupe stalled calls across remounted reconciler runtimes at epoch zero", async () => {
		const resolvers: Array<(value: { kind: "count"; count: number }) => void> =
			[];
		vi.mocked(loadCaseCountAction).mockImplementation(
			() =>
				new Promise((resolve) => {
					resolvers.push(resolve);
				}),
		);
		const wrapperFor = (projectScopeId: string) => {
			const session = createBuilderSessionStore({ appId: APP_ID });
			return ({ children }: { children: ReactNode }) => (
				<BuilderSessionContext value={session}>
					<ReconcilerContext.Provider value={{ projectScopeId } as never}>
						{children}
					</ReconcilerContext.Provider>
				</BuilderSessionContext>
			);
		};

		const source = renderHook(
			() => useCaseCount({ appId: APP_ID, caseType: PATIENT.name }),
			{ wrapper: wrapperFor("source-runtime") },
		);
		await waitFor(() => expect(loadCaseCountAction).toHaveBeenCalledTimes(1));
		const destination = renderHook(
			() => useCaseCount({ appId: APP_ID, caseType: PATIENT.name }),
			{ wrapper: wrapperFor("destination-runtime") },
		);
		await waitFor(() => expect(loadCaseCountAction).toHaveBeenCalledTimes(2));

		await act(async () => {
			resolvers[0]?.({ kind: "count", count: 1 });
			resolvers[1]?.({ kind: "count", count: 2 });
		});
		await waitFor(() =>
			expect(destination.result.current.state).toEqual({
				kind: "count",
				count: 2,
			}),
		);
		expect(source.result.current.state).toEqual({ kind: "count", count: 1 });
	});

	it("hides the prior count synchronously when the case type changes", async () => {
		let resolveNext:
			| ((value: { kind: "count"; count: number }) => void)
			| undefined;
		vi.mocked(loadCaseCountAction)
			.mockResolvedValueOnce({ kind: "count", count: 30 })
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveNext = resolve;
					}),
			);
		let caseType = PATIENT.name;
		const hook = renderHook(() => useCaseCount({ appId: APP_ID, caseType }));

		await waitFor(() =>
			expect(hook.result.current.state).toEqual({ kind: "count", count: 30 }),
		);
		caseType = "visit";
		hook.rerender();

		expect(hook.result.current.state).toEqual({ kind: "loading" });

		await act(async () => resolveNext?.({ kind: "count", count: 2 }));
		await waitFor(() =>
			expect(hook.result.current.state).toEqual({ kind: "count", count: 2 }),
		);
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
					calculated: {},
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
