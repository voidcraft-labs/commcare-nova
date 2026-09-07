// @vitest-environment happy-dom

import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { caseWriteCandidateMutations } from "@/lib/doc/caseWriteChoices";
import type {
	CaseWriteVerdictCandidate,
	CaseWriteVerdictWorkerRequest,
	CaseWriteVerdictWorkerResponse,
} from "@/lib/doc/caseWriteVerdictWorkerProtocol";
import { evaluateCaseWriteVerdictBatch } from "@/lib/doc/caseWriteVerdictWorkerRuntime";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { useCaseWriteChoiceVerdicts } from "@/lib/doc/hooks/useCaseWriteChoices";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { hasMutationPrevalidation } from "@/lib/doc/mutationPrevalidation";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import { proseText } from "@/lib/domain/prose";
import { assertAdmittedDoc } from "./admittedDoc";

interface FakeWorker {
	request?: CaseWriteVerdictWorkerRequest;
	onmessage:
		| ((event: MessageEvent<CaseWriteVerdictWorkerResponse>) => void)
		| null;
	onerror: ((event: ErrorEvent) => void) | null;
	postMessage: ReturnType<typeof vi.fn>;
	terminate: ReturnType<typeof vi.fn>;
}

const { workers } = vi.hoisted(() => ({ workers: [] as FakeWorker[] }));

vi.mock("@/lib/doc/browserCaseWriteVerdictWorker", () => ({
	createBrowserCaseWriteVerdictWorker: () => {
		const worker: FakeWorker = {
			onmessage: null,
			onerror: null,
			postMessage: vi.fn((request: CaseWriteVerdictWorkerRequest) => {
				worker.request = structuredClone(request);
			}),
			terminate: vi.fn(),
		};
		workers.push(worker);
		return worker;
	},
}));

const EMPTY_CANDIDATES: readonly CaseWriteVerdictCandidate[] = [];
const NEW_PROPERTY: CaseWriteVerdictCandidate = {
	key: "new-property",
	caseWrite: { caseType: "patient", property: "favorite_color" },
};

function setup() {
	const doc = buildDoc({
		appName: "Case write choices",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Registration",
						type: "registration",
						fields: [
							f({ kind: "text", id: "color", label: proseText("Color") }),
							f({
								kind: "text",
								id: "name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	const field = Object.values(doc.fields)[0];
	const store = createBlueprintDocStore();
	store.getState().load(toPersistableDoc(doc));
	store.getState().startTracking();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<BlueprintDocContext.Provider value={store}>
			{children}
		</BlueprintDocContext.Provider>
	);
	return { doc: store.getState(), field, store, wrapper };
}

const pending: Promise<unknown>[] = [];
function own<T>(task: Promise<T>): Promise<T> {
	pending.push(task);
	return task;
}
function respond(worker: FakeWorker) {
	if (!worker.request || !worker.onmessage)
		throw new Error("Worker request missing");
	const response = structuredClone(
		evaluateCaseWriteVerdictBatch(worker.request),
	);
	worker.onmessage(new MessageEvent("message", { data: response }));
}
describe("useCaseWriteChoiceVerdicts", () => {
	afterEach(async () => {
		cleanup();
		await Promise.all(pending.splice(0));
		for (const worker of workers)
			expect(worker.terminate).toHaveBeenCalledOnce();
	});
	beforeEach(() => {
		workers.length = 0;
	});

	it("finishes an authored-property proof after the chooser closes and registers it", async () => {
		const { doc, field, wrapper } = setup();
		const { result, rerender } = renderHook(
			({ enabled }: { enabled: boolean }) =>
				useCaseWriteChoiceVerdicts(field, EMPTY_CANDIDATES, enabled),
			{ wrapper, initialProps: { enabled: true } },
		);
		let verdictPromise: Promise<unknown> | undefined;
		act(() => {
			verdictPromise = own(result.current.ensureVerdict(NEW_PROPERTY));
		});

		const worker = workers[0];
		expect(worker?.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ candidates: [NEW_PROPERTY] }),
		);
		/* Base UI closes the popup during selection. The selected row's already
		 * running proof must outlive that close so commit never falls back to the
		 * expensive main-thread gate. */
		rerender({ enabled: false });
		expect(worker?.terminate).not.toHaveBeenCalled();
		await act(async () => {
			respond(worker);
			await expect(verdictPromise).resolves.toEqual({ ok: true });
		});

		expect(
			hasMutationPrevalidation(
				doc,
				LOOKUP_CONTEXT_UNAVAILABLE,
				caseWriteCandidateMutations(doc, field, NEW_PROPERTY.caseWrite),
			),
		).toBe(true);
	});

	it("retires a proof when the document snapshot changes", async () => {
		const { field, store, wrapper } = setup();
		const { result } = renderHook(
			() => useCaseWriteChoiceVerdicts(field, EMPTY_CANDIDATES, true),
			{ wrapper },
		);
		let verdictPromise: Promise<unknown> | undefined;
		act(() => {
			verdictPromise = own(result.current.ensureVerdict(NEW_PROPERTY));
		});
		const worker = workers[0];

		act(() => {
			const verdict = mutationCommitVerdict(
				store.getState(),
				[{ kind: "setAppName", name: "Changed" }],
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			if (!verdict.ok) throw new Error("Expected admitted name change");
			store.getState().commitDoc(verdict.nextDoc, verdict.mutations);
		});

		await expect(verdictPromise).resolves.toBeUndefined();
		expect(worker?.terminate).toHaveBeenCalledOnce();
	});
	it("does not certify a rejected duplicate destination", async () => {
		const { doc, field, wrapper } = setup();
		const { result } = renderHook(
			() => useCaseWriteChoiceVerdicts(field, EMPTY_CANDIDATES, true),
			{ wrapper },
		);
		const duplicate: CaseWriteVerdictCandidate = {
			key: "duplicate",
			caseWrite: { caseType: "patient", property: "case_name" },
		};
		let task!: ReturnType<typeof result.current.ensureVerdict>;
		act(() => {
			task = own(result.current.ensureVerdict(duplicate));
		});
		await act(async () => {
			respond(workers[0]);
			await expect(task).resolves.toMatchObject({ ok: false });
		});
		expect(
			hasMutationPrevalidation(
				doc,
				LOOKUP_CONTEXT_UNAVAILABLE,
				caseWriteCandidateMutations(doc, field, duplicate.caseWrite),
			),
		).toBe(false);
	});

	it("settles an abandoned choice before evaluating the next choice and owns unmount", async () => {
		const { field, wrapper } = setup();
		const { result, unmount } = renderHook(
			() => useCaseWriteChoiceVerdicts(field, EMPTY_CANDIDATES, true),
			{ wrapper },
		);
		let first!: ReturnType<typeof result.current.ensureVerdict>;
		let next!: typeof first;
		act(() => {
			first = own(result.current.ensureVerdict(NEW_PROPERTY));
		});
		act(() => {
			next = own(
				result.current.ensureVerdict({ key: "clear", caseWrite: null }),
			);
		});
		await expect(first).resolves.toBeUndefined();
		expect(workers[0].terminate).toHaveBeenCalledOnce();
		const cancelledLoad = new ErrorEvent("error", {
			cancelable: true,
			message: "importScripts request was cancelled",
		});
		workers[0].onerror?.(cancelledLoad);
		expect(cancelledLoad.defaultPrevented).toBe(true);
		unmount();
		await expect(next).resolves.toBeUndefined();
		expect(workers[1].onmessage).toBeNull();
		const unmountedLoad = new ErrorEvent("error", {
			cancelable: true,
			message: "importScripts request was cancelled",
		});
		workers[1].onerror?.(unmountedLoad);
		expect(unmountedLoad.defaultPrevented).toBe(true);
	});

	it("owns a cancelled module-load error when an unused warm worker unmounts", () => {
		const { field, wrapper } = setup();
		const { unmount } = renderHook(
			() => useCaseWriteChoiceVerdicts(field, EMPTY_CANDIDATES, true),
			{ wrapper },
		);
		const worker = workers[0];
		expect(worker.postMessage).not.toHaveBeenCalled();
		unmount();
		expect(worker.terminate).toHaveBeenCalledOnce();
		const error = new ErrorEvent("error", {
			cancelable: true,
			message: "warm module load cancelled",
		});
		worker.onerror?.(error);
		expect(error.defaultPrevented).toBe(true);
	});
});
