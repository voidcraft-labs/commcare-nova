// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { caseWriteCandidateMutations } from "@/lib/doc/caseWriteChoices";
import type {
	CaseWriteVerdictCandidate,
	CaseWriteVerdictWorkerResponse,
} from "@/lib/doc/caseWriteVerdictWorkerProtocol";
import { useCaseWriteChoiceVerdicts } from "@/lib/doc/hooks/useCaseWriteChoices";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { hasMutationPrevalidation } from "@/lib/doc/mutationPrevalidation";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { Field } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

interface FakeWorker {
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
			postMessage: vi.fn(),
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
				forms: [
					{
						name: "Registration",
						type: "registration",
						fields: [
							f({ kind: "text", id: "color", label: proseText("Color") }),
						],
					},
				],
			},
		],
	});
	const field = Object.values(doc.fields)[0] as Field;
	const store = createBlueprintDocStore();
	store.getState().load(doc);
	store.getState().startTracking();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<BlueprintDocContext.Provider value={store}>
			{children}
		</BlueprintDocContext.Provider>
	);
	return { doc: store.getState(), field, store, wrapper };
}

describe("useCaseWriteChoiceVerdicts", () => {
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
			verdictPromise = result.current.ensureVerdict(NEW_PROPERTY);
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
			worker?.onmessage?.({
				data: {
					version: 1,
					requestId: 1,
					ok: true,
					verdicts: [[NEW_PROPERTY.key, { ok: true }]],
				},
			} as unknown as MessageEvent<CaseWriteVerdictWorkerResponse>);
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
			verdictPromise = result.current.ensureVerdict(NEW_PROPERTY);
		});
		const worker = workers[0];

		act(() => {
			store.getState().applyMany([{ kind: "setAppName", name: "Changed" }]);
		});

		await expect(verdictPromise).resolves.toBeUndefined();
		expect(worker?.terminate).toHaveBeenCalledOnce();
	});
});
