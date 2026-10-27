// @vitest-environment happy-dom

// Hook orchestration at the Server Action boundary: actual resources, session
// state and invalidation; controlled action promises. Server authorization,
// SQL matching and persistence are proved by the action/Postgres suites.

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import {
	ReconcilerContext,
	type ReconcilerContextValue,
} from "@/lib/collab/context";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import type { BlueprintDoc, CaseListConfig, CaseType } from "@/lib/domain";
import { literal, matchAll, term } from "@/lib/domain/expression";
import type {
	CaseRowWithCalculated,
	LoadCasesResult,
} from "@/lib/preview/engine/caseDataBindingTypes";
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

/** The document the running Preview reads its platform and language from. */
function Doc({ children }: { children: ReactNode }) {
	return <BlueprintDocProvider appId={APP_ID}>{children}</BlueprintDocProvider>;
}

/** The live `CaseType` definition the hook forwards verbatim to the
 *  action — the hook never reads its shape, so an empty-property literal
 *  keeps the fixture cheap. */
const PATIENT: CaseType = { name: "patient", properties: [] };

const pendingActions = new Set<{
	promise: Promise<unknown>;
	cancel: () => void;
}>();
function scopeContext(projectScopeId: string): ReconcilerContextValue {
	const unexpected = (): never => {
		throw new Error("This resource only consumes reconciler runtime identity");
	};
	return {
		projectScopeId,
		get reconciler() {
			return unexpected();
		},
		activate: unexpected,
		subscribePresence: unexpected,
		subscribeAppOrganization: unexpected,
		subscribePreviewProjectSpace: unexpected,
		subscribeLookupManifest: unexpected,
		subscribeProjectScopeReset: unexpected,
		isProjectScopeCurrent: unexpected,
	};
}
function ownedActionPromise<T>(
	executor: (resolve: (value: T | PromiseLike<T>) => void) => void,
): Promise<T> {
	const gate = Promise.withResolvers<T>();
	pendingActions.add({
		promise: gate.promise,
		cancel: () => gate.reject(new Error("Action peer closed during teardown")),
	});
	executor(gate.resolve);
	return gate.promise;
}
afterEach(async () => {
	cleanup();
	for (const task of pendingActions) task.cancel();
	await Promise.allSettled([...pendingActions].map((task) => task.promise));
	pendingActions.clear();
	vi.restoreAllMocks();
});
const CASE_ROW: CaseRowWithCalculated = {
	case_id: "source-case",
	app_id: APP_ID,
	case_type: "patient",
	owner_id: "worker",
	status: "open",
	opened_on: null,
	modified_on: null,
	closed_on: null,
	case_name: "Source patient",
	external_id: null,
	parent_case_id: null,
	properties: {},
	calculated: {},
};

beforeEach(() => {
	vi.mocked(loadCaseCountAction).mockReset();
	vi.mocked(loadCaseDataAction).mockReset();
	vi.mocked(loadCasesAction).mockReset();
	vi.mocked(resetSampleCasesAction).mockReset();
});

describe("useResetSampleCases", () => {
	it("forwards the selected persona so regenerated rows keep the visible worker owner", async () => {
		const personaUuid = "persona-asha";
		vi.mocked(resetSampleCasesAction).mockResolvedValueOnce({
			kind: "ok",
			inserted: 30,
		});
		const store = createBuilderSessionStore({ appId: APP_ID });
		store.getState().setPreviewPersonaUuid(personaUuid);
		const wrapper = ({ children }: { children: ReactNode }) => (
			<BuilderSessionContext value={store}>
				<Doc>{children}</Doc>
			</BuilderSessionContext>
		);
		const { result } = renderHook(
			() => useResetSampleCases({ appId: APP_ID, caseType: PATIENT }),
			{ wrapper },
		);

		await result.current();
		expect(resetSampleCasesAction).toHaveBeenCalledWith(
			APP_ID,
			PATIENT,
			personaUuid,
		);
	});

	it("drops the preview persona before edit-mode sample-data actions return", async () => {
		vi.mocked(resetSampleCasesAction).mockResolvedValueOnce({
			kind: "ok",
			inserted: 30,
		});
		const store = createBuilderSessionStore({ appId: APP_ID });
		store.getState().setPreviewing(true);
		store.getState().setPreviewPersonaUuid("persona-asha");
		const wrapper = ({ children }: { children: ReactNode }) => (
			<BuilderSessionContext value={store}>
				<Doc>{children}</Doc>
			</BuilderSessionContext>
		);
		const { result } = renderHook(
			() => useResetSampleCases({ appId: APP_ID, caseType: PATIENT }),
			{ wrapper },
		);

		act(() => store.getState().setPreviewing(false));
		await result.current();

		expect(resetSampleCasesAction).toHaveBeenCalledWith(
			APP_ID,
			PATIENT,
			undefined,
		);
	});

	it("invalidates every subscriber for the case type after a successful reset", async () => {
		vi.mocked(resetSampleCasesAction).mockResolvedValueOnce({
			kind: "ok",
			inserted: 30,
		});
		const revision = renderHook(
			() => useCaseDataRevision(APP_ID, PATIENT.name),
			{ wrapper: Doc },
		);
		const before = revision.result.current;
		const replacementRevision = renderHook(
			() => useCaseDataReplacementRevision(APP_ID, PATIENT.name),
			{ wrapper: Doc },
		);
		const replacementBefore = replacementRevision.result.current;
		const reset = renderHook(
			() => useResetSampleCases({ appId: APP_ID, caseType: PATIENT }),
			{ wrapper: Doc },
		);

		await act(async () => {
			await reset.result.current();
		});

		expect(revision.result.current).toBe(before + 1);
		expect(replacementRevision.result.current).toBe(replacementBefore + 1);
	});
});

describe("useCases query constraints", () => {
	it("masks source-Project rows at the epoch boundary and rejects their late settle", async () => {
		let resolveSource: ((value: LoadCasesResult) => void) | undefined;
		let resolveDestination: ((value: LoadCasesResult) => void) | undefined;
		vi.mocked(loadCasesAction)
			.mockImplementationOnce(() =>
				ownedActionPromise((resolve) => {
					resolveSource = resolve;
				}),
			)
			.mockImplementationOnce(() =>
				ownedActionPromise((resolve) => {
					resolveDestination = resolve;
				}),
			);
		const store = createBuilderSessionStore({ appId: APP_ID });
		const wrapper = ({ children }: { children: ReactNode }) => (
			<BuilderSessionContext value={store}>
				<Doc>{children}</Doc>
			</BuilderSessionContext>
		);
		const hook = renderHook(
			() => useCases({ appId: APP_ID, caseType: PATIENT.name }),
			{ wrapper },
		);

		await waitFor(() => expect(loadCasesAction).toHaveBeenCalledTimes(1));
		act(() => {
			store.getState().beginAccessRefresh();
		});
		// The epoch is part of the render identity, so source rows disappear in
		// the same render. The query is deliberately idle while no authoritative
		// Project snapshot exists; it becomes loading only after authorization.
		expect(hook.result.current.state).toEqual({ kind: "idle" });
		/* The new epoch is intentionally dormant until GET installs its atomic
		 * Project/role/doc snapshot. A pre-snapshot read could otherwise publish
		 * source-authorized data under the destination generation. */
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
		expect(hook.result.current.state).toEqual({ kind: "idle" });
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

	it("forwards a bounded page and treats a page change as a request identity boundary", async () => {
		let resolveNext:
			| ((value: {
					kind: "rows";
					rows: CaseRowWithCalculated[];
					totalCount: number;
					pageOffset: number;
					pageSize: number;
					constraintSource: "unconstrained";
			  }) => void)
			| undefined;
		vi.mocked(loadCasesAction)
			.mockResolvedValueOnce({
				constraintSource: "unconstrained",
				kind: "rows",
				rows: [CASE_ROW],
				totalCount: 75,
				pageOffset: 0,
				pageSize: 50,
			})
			.mockImplementationOnce(() =>
				ownedActionPromise((resolve) => {
					resolveNext = resolve;
				}),
			);
		let page = { offset: 0, limit: 50 };
		const hook = renderHook(
			() => useCases({ appId: APP_ID, caseType: PATIENT.name, page }),
			{ wrapper: Doc },
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
				constraintSource: "unconstrained",
				kind: "rows",
				rows: [CASE_ROW],
				totalCount: 75,
				pageOffset: 50,
				pageSize: 50,
			}),
		);
		await waitFor(() =>
			expect(hook.result.current.state).toMatchObject({
				constraintSource: "unconstrained",
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
		const consoleError = vi.spyOn(console, "error");
		let page: { offset: number; limit: number } | undefined;
		try {
			const hook = renderHook(
				() => useCases({ appId: APP_ID, caseType: PATIENT.name, page }),
				{ wrapper: Doc },
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
		const consoleError = vi.spyOn(console, "error");
		let blueprint: BlueprintDoc | undefined;
		let moduleUuid: string | undefined;
		let caseListConfig: CaseListConfig | undefined;
		let excludedOwnerIdsExpression: ReturnType<typeof term> | undefined;
		let caseTypes: readonly CaseType[] | undefined;
		try {
			const hook = renderHook(
				() =>
					useCases({
						appId: APP_ID,
						caseType: PATIENT.name,
						blueprint,
						moduleUuid,
						caseListConfig,
						excludedOwnerIdsExpression,
						caseTypes,
					}),
				{ wrapper: Doc },
			);
			await waitFor(() => expect(loadCasesAction).toHaveBeenCalledTimes(1));

			caseListConfig = resolveCaseListConfig({
				columns: [],
				searchInputs: [],
				filter: matchAll(),
			});
			excludedOwnerIdsExpression = term(literal("owner-a"));
			caseTypes = [PATIENT];
			blueprint = buildDoc({
				appId: APP_ID,
				caseTypes: [...caseTypes],
				modules: [
					{
						name: "Patients",
						caseType: PATIENT.name,
						caseListConfig,
						caseSearchConfig: { excludedOwnerIds: excludedOwnerIdsExpression },
					},
				],
			});
			moduleUuid = blueprint.moduleOrder[0];
			hook.rerender();

			await waitFor(() => expect(loadCasesAction).toHaveBeenCalledTimes(2));
			expect(loadCasesAction).toHaveBeenLastCalledWith(
				expect.objectContaining({
					blueprint,
					moduleUuid,
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
		const hook = renderHook(
			() =>
				useCases({
					appId: APP_ID,
					caseType: PATIENT.name,
					page: { offset: 0, limit: 50 },
				}),
			{ wrapper: Doc },
		);

		await waitFor(() => expect(hook.result.current.state.kind).toBe("empty"));
		expect(loadCasesAction).toHaveBeenCalledTimes(1);
		hook.rerender();
		expect(loadCasesAction).toHaveBeenCalledTimes(1);
	});

	it("hides rows synchronously when the app or case type changes", async () => {
		let resolveNext:
			| ((value: { kind: "empty"; constraintSource: "unconstrained" }) => void)
			| undefined;
		vi.mocked(loadCasesAction)
			.mockResolvedValueOnce({
				kind: "rows",
				rows: [CASE_ROW],
				constraintSource: "unconstrained",
			})
			.mockImplementationOnce(() =>
				ownedActionPromise((resolve) => {
					resolveNext = resolve;
				}),
			);
		let identity = { appId: APP_ID, caseType: PATIENT.name };
		const hook = renderHook(() => useCases(identity), { wrapper: Doc });

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
				rows: [CASE_ROW],
				constraintSource: "unconstrained",
			})
			.mockImplementationOnce(() =>
				ownedActionPromise((resolve) => {
					resolveNext = resolve;
				}),
			);
		let requestScopeKey = "module-a";
		const hook = renderHook(
			() =>
				useCases({
					appId: APP_ID,
					caseType: PATIENT.name,
					requestScopeKey,
				}),
			{ wrapper: Doc },
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
				rows: [CASE_ROW],
				constraintSource: "unconstrained",
			})
			.mockImplementationOnce(() =>
				ownedActionPromise((resolve) => {
					resolveNext = resolve;
				}),
			);
		const hook = renderHook(
			() =>
				useCases({
					appId: APP_ID,
					caseType: PATIENT.name,
					requestScopeKey: "module-a",
				}),
			{ wrapper: Doc },
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
		vi.mocked(loadCaseCountAction).mockImplementation(() =>
			ownedActionPromise((resolve) => {
				resolvers.push(resolve);
			}),
		);
		const wrapperFor = (projectScopeId: string) => {
			const session = createBuilderSessionStore({ appId: APP_ID });
			return ({ children }: { children: ReactNode }) => (
				<BuilderSessionContext value={session}>
					<ReconcilerContext value={scopeContext(projectScopeId)}>
						<Doc>{children}</Doc>
					</ReconcilerContext>
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
			.mockImplementationOnce(() =>
				ownedActionPromise((resolve) => {
					resolveNext = resolve;
				}),
			);
		let caseType = PATIENT.name;
		const hook = renderHook(() => useCaseCount({ appId: APP_ID, caseType }), {
			wrapper: Doc,
		});

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

	it("refetches and forwards the exact selected-parent population", async () => {
		vi.mocked(loadCaseCountAction).mockResolvedValue({
			kind: "count",
			count: 0,
		});
		let parentCase = {
			caseType: "household",
			caseIds: ["household-a", "household-b"],
		};
		const hook = renderHook(
			() => useCaseCount({ appId: APP_ID, caseType: "visit", parentCase }),
			{ wrapper: Doc },
		);

		await waitFor(() => expect(loadCaseCountAction).toHaveBeenCalledTimes(1));
		expect(loadCaseCountAction).toHaveBeenLastCalledWith({
			appId: APP_ID,
			caseType: "visit",
			includeHeld: false,
			parentCase: {
				caseType: "household",
				caseIds: ["household-a", "household-b"],
			},
		});

		parentCase = {
			caseType: "household",
			caseIds: ["household-b", "household-a"],
		};
		hook.rerender();
		await waitFor(() => expect(loadCaseCountAction).toHaveBeenCalledTimes(2));
		expect(loadCaseCountAction).toHaveBeenLastCalledWith({
			appId: APP_ID,
			caseType: "visit",
			includeHeld: false,
			parentCase: {
				caseType: "household",
				caseIds: ["household-b", "household-a"],
			},
		});
	});
});

describe("case-data invalidation", () => {
	it("masks and refetches the selected row when Preview switches persona", async () => {
		let resolvePersona: ((value: { kind: "missing" }) => void) | undefined;
		vi.mocked(loadCaseDataAction)
			.mockResolvedValueOnce({ kind: "missing" })
			.mockImplementationOnce(() =>
				ownedActionPromise((resolve) => {
					resolvePersona = resolve;
				}),
			);
		const store = createBuilderSessionStore({ appId: APP_ID });
		const wrapper = ({ children }: { children: ReactNode }) => (
			<BuilderSessionContext value={store}>
				<Doc>{children}</Doc>
			</BuilderSessionContext>
		);
		const selected = renderHook(
			() =>
				useCaseData({
					appId: APP_ID,
					caseType: PATIENT.name,
					caseId: "case-1",
					ancestorDepth: 0,
				}),
			{ wrapper },
		);
		await waitFor(() =>
			expect(selected.result.current.state).toEqual({ kind: "missing" }),
		);

		act(() => store.getState().setPreviewPersonaUuid("persona-asha"));
		expect(selected.result.current.state).toEqual({ kind: "loading" });
		await waitFor(() => expect(loadCaseDataAction).toHaveBeenCalledTimes(2));
		// By position, not `at(-1)`: the persona is the ninth argument and the
		// action keeps growing trailing optional ones, so "last" drifts onto
		// whatever was appended most recently.
		expect(vi.mocked(loadCaseDataAction).mock.calls[1]?.[8]).toBe(
			"persona-asha",
		);

		await act(async () => resolvePersona?.({ kind: "missing" }));
		await waitFor(() =>
			expect(selected.result.current.state).toEqual({ kind: "missing" }),
		);
	});

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
			.mockImplementationOnce(() =>
				ownedActionPromise((resolve) => {
					resolveReload = resolve;
				}),
			);
		const selected = renderHook(
			() =>
				useCaseData({
					appId: APP_ID,
					caseType: PATIENT.name,
					caseId: "case-1",
					ancestorDepth: 0,
				}),
			{ wrapper: Doc },
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
		vi.mocked(loadCasesAction).mockResolvedValue({
			constraintSource: "unconstrained",
			kind: "empty",
		});
		vi.mocked(loadCaseDataAction).mockResolvedValue({ kind: "missing" });

		const countHook = renderHook(
			() => useCaseCount({ appId: APP_ID, caseType: PATIENT.name }),
			{ wrapper: Doc },
		);
		const casesHook = renderHook(
			() => useCases({ appId: APP_ID, caseType: PATIENT.name }),
			{ wrapper: Doc },
		);
		const caseHook = renderHook(
			() =>
				useCaseData({
					appId: APP_ID,
					caseType: PATIENT.name,
					caseId: "case-1",
					ancestorDepth: 0,
				}),
			{ wrapper: Doc },
		);

		await waitFor(() => {
			expect(countHook.result.current.state).toEqual({
				kind: "count",
				count: 4,
			});
			expect(casesHook.result.current.state).toEqual({
				constraintSource: "unconstrained",
				kind: "empty",
			});
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
		renderHook(() => useCaseCount({ appId: APP_ID, caseType: "visit" }), {
			wrapper: Doc,
		});
		await waitFor(() => expect(loadCaseCountAction).toHaveBeenCalledTimes(1));

		act(() => invalidateCaseData(APP_ID, PATIENT.name));

		expect(loadCaseCountAction).toHaveBeenCalledTimes(1);
	});
});

// Optional identifiers keep resource hooks idle without sending a request.

describe("case resource completion and invalidation ownership", () => {
	it("shares simultaneous same-scope count reads and refetches after settlement", async () => {
		let finish: ((value: { kind: "count"; count: number }) => void) | undefined;
		vi.mocked(loadCaseCountAction)
			.mockImplementationOnce(() =>
				ownedActionPromise((resolve) => {
					finish = resolve;
				}),
			)
			.mockResolvedValueOnce({ kind: "count", count: 8 });
		const first = renderHook(
			() => useCaseCount({ appId: APP_ID, caseType: PATIENT.name }),
			{ wrapper: Doc },
		);
		const second = renderHook(
			() => useCaseCount({ appId: APP_ID, caseType: PATIENT.name }),
			{ wrapper: Doc },
		);
		expect(loadCaseCountAction).toHaveBeenCalledTimes(1);
		await act(async () => {
			finish?.({ kind: "count", count: 7 });
		});
		expect(first.result.current.state).toEqual({ kind: "count", count: 7 });
		expect(second.result.current.state).toEqual({ kind: "count", count: 7 });
		await act(async () => {
			await second.result.current.reload();
		});
		expect(loadCaseCountAction).toHaveBeenCalledTimes(2);
		expect(second.result.current.state).toEqual({ kind: "count", count: 8 });
	});
	it("keeps same-query rows until an awaited reload settles", async () => {
		let finish: ((value: LoadCasesResult) => void) | undefined;
		vi.mocked(loadCasesAction)
			.mockResolvedValueOnce({
				kind: "rows",
				rows: [CASE_ROW],
				constraintSource: "unconstrained",
			})
			.mockImplementationOnce(() =>
				ownedActionPromise((resolve) => {
					finish = resolve;
				}),
			);
		const h = renderHook(
			() => useCases({ appId: APP_ID, caseType: PATIENT.name }),
			{ wrapper: Doc },
		);
		await waitFor(() => expect(h.result.current.state.kind).toBe("rows"));
		let pending: Promise<void> | undefined;
		let settled = false;
		act(() => {
			pending = h.result.current.reload().then(() => {
				settled = true;
			});
		});
		expect(h.result.current.state).toMatchObject({
			kind: "rows",
			rows: [CASE_ROW],
		});
		expect(h.result.current.fetching).toBe(true);
		expect(settled).toBe(false);
		await act(async () => {
			finish?.({ kind: "empty", constraintSource: "unconstrained" });
			await pending;
		});
		expect(settled).toBe(true);
		expect(h.result.current.fetching).toBe(false);
		expect(h.result.current.state.kind).toBe("empty");
	});
	it("keeps settled rows on screen while a new claim re-reads the list", async () => {
		let finish: ((value: LoadCasesResult) => void) | undefined;
		vi.mocked(loadCasesAction)
			.mockResolvedValueOnce({
				kind: "rows",
				rows: [CASE_ROW],
				constraintSource: "unconstrained",
			})
			.mockImplementationOnce(() =>
				ownedActionPromise((resolve) => {
					finish = resolve;
				}),
			);
		const store = createBuilderSessionStore({ appId: APP_ID });
		const wrapper = ({ children }: { children: ReactNode }) => (
			<BuilderSessionContext value={store}>
				<Doc>{children}</Doc>
			</BuilderSessionContext>
		);
		const h = renderHook(
			() => useCases({ appId: APP_ID, caseType: PATIENT.name, search: true }),
			{ wrapper },
		);
		await waitFor(() => expect(h.result.current.state.kind).toBe("rows"));

		act(() => store.getState().addPreviewClaims(["claimed-case"]));
		expect(h.result.current.state).toMatchObject({
			kind: "rows",
			rows: [CASE_ROW],
		});
		await waitFor(() => expect(loadCasesAction).toHaveBeenCalledTimes(2));
		expect(
			vi.mocked(loadCasesAction).mock.calls[1]?.[0].claimedCaseIds,
		).toEqual(["claimed-case"]);
		expect(h.result.current.state.kind).toBe("rows");
		expect(h.result.current.fetching).toBe(true);

		await act(async () =>
			finish?.({
				kind: "rows",
				rows: [{ ...CASE_ROW, case_id: "claimed-case" }],
				constraintSource: "unconstrained",
			}),
		);
		await waitFor(() => expect(h.result.current.fetching).toBe(false));
		expect(h.result.current.state).toMatchObject({
			kind: "rows",
			rows: [{ case_id: "claimed-case" }],
		});
	});

	it("does not announce source-scope replacement after access refresh", async () => {
		const session = createBuilderSessionStore({
			appId: APP_ID,
			projectId: "source",
			role: "editor",
			canEdit: true,
		});
		const wrapper = ({ children }: { children: ReactNode }) => (
			<BuilderSessionContext value={session}>
				<Doc>{children}</Doc>
			</BuilderSessionContext>
		);
		const h = renderHook(
			() => ({
				reset: useResetSampleCases({ appId: APP_ID, caseType: PATIENT }),
				revision: useCaseDataReplacementRevision(APP_ID, PATIENT.name),
			}),
			{ wrapper },
		);
		const before = h.result.current.revision;
		const gate = Promise.withResolvers<{ kind: "ok"; inserted: number }>();
		vi.mocked(resetSampleCasesAction).mockReturnValue(gate.promise);
		let pending: ReturnType<typeof h.result.current.reset> | undefined;
		try {
			act(() => {
				pending = h.result.current.reset();
				session.getState().beginAccessRefresh();
			});
			await act(async () => {
				gate.resolve({ kind: "ok", inserted: 2 });
				await pending;
			});
			expect(h.result.current.revision).toBe(before);
		} finally {
			await act(async () => {
				gate.resolve({ kind: "ok", inserted: 2 });
				await pending;
			});
		}
	});
});
