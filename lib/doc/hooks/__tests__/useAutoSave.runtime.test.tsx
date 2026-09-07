// @vitest-environment happy-dom

import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	ReconcilerContext,
	type ReconcilerContextValue,
} from "@/lib/collab/context";
import { createReconciler, type PutOutcome } from "@/lib/collab/reconciler";
import { assertAdmittedDoc } from "@/lib/doc/__tests__/admittedDoc";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type AdmittedMutationBatch,
	admitMutationBatch,
} from "@/lib/doc/mutationAdmission";
import { BlueprintDocContext } from "@/lib/doc/provider";
import { createBlueprintDocStore } from "@/lib/doc/store";
import type { Mutation } from "@/lib/doc/types";
import { BuilderSessionContext } from "@/lib/session/provider";
import { createBuilderSessionStore } from "@/lib/session/store";
import { useAutoSave } from "../useAutoSave";

const disposals: Array<() => Promise<void>> = [];

function setup() {
	const doc = buildDoc({
		appId: "save-app",
		appName: "Interview",
		modules: [
			{
				name: "Survey",
				forms: [
					{
						name: "Profile",
						type: "survey",
						fields: [{ id: "name", kind: "text", label: "Name" }],
					},
				],
			},
		],
	});
	assertAdmittedDoc(doc);
	const store = createBlueprintDocStore();
	store.getState().load(toPersistableDoc(doc));
	store.getState().startTracking();
	const session = createBuilderSessionStore({
		appId: doc.appId,
		canEdit: true,
		role: "editor",
		projectId: "project",
	});
	const puts: Array<{
		batchId: string;
		mutations: AdmittedMutationBatch;
		resolve: (outcome: PutOutcome) => void;
		promise: Promise<PutOutcome>;
	}> = [];
	let retry: (() => void) | undefined;
	const reconciler = createReconciler(
		store,
		{
			appId: doc.appId,
			baseSeq: 0,
			baseDoc: store.getState(),
			userId: "author",
		},
		{
			put(batchId, mutations) {
				const { promise, resolve } = Promise.withResolvers<PutOutcome>();
				puts.push({ batchId, mutations, promise, resolve });
				return promise;
			},
			reload: () => Promise.reject(new Error("Unexpected reload")),
			canEdit: () => session.getState().canEdit,
			resubscribe: () => {},
			scheduleRetry: (_attempt, run) => {
				retry = run;
				return () => {
					retry = undefined;
				};
			},
		},
	);
	const context: ReconcilerContextValue = {
		reconciler,
		projectScopeId: "save-scope",
		activate: () => {},
		subscribePresence: () => () => {},
		subscribeAppOrganization: () => () => {},
		subscribePreviewProjectSpace: () => () => {},
		subscribeLookupManifest: () => () => {},
		subscribeProjectScopeReset: () => () => {},
		isProjectScopeCurrent: () => true,
	};
	const wrapper = ({ children }: { children: ReactNode }) => (
		<BuilderSessionContext value={session}>
			<BlueprintDocContext value={store}>
				<ReconcilerContext value={context}>{children}</ReconcilerContext>
			</BlueprintDocContext>
		</BuilderSessionContext>
	);
	const hook = renderHook(useAutoSave, { wrapper });
	function commit(mutations: Mutation[]) {
		const verdict = mutationCommitVerdict(
			store.getState(),
			mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		if (!verdict.ok) throw new Error(JSON.stringify(verdict.findings));
		store.getState().commitDoc(verdict.nextDoc, verdict.mutations);
	}
	async function respond(index: number, outcome: PutOutcome) {
		await act(async () => {
			puts[index].resolve(outcome);
			await puts[index].promise;
		});
	}
	disposals.push(async () => {
		reconciler.dispose();
		for (const put of puts) put.resolve({ ok: false, kind: "network" });
		await Promise.all(puts.map((put) => put.promise));
		expect(retry).toBeUndefined();
		expect(
			reconciler.getSnapshot().sentPending.every((batch) => !batch.putInFlight),
		).toBe(true);
	});
	return {
		...hook,
		store,
		session,
		reconciler,
		puts,
		commit,
		respond,
		retry: () => {
			const run = retry;
			retry = undefined;
			if (!run) throw new Error("No retry scheduled");
			run();
		},
	};
}

describe("autosave with the actual document queue and reconciler", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(async () => {
		try {
			cleanup();
			for (const dispose of disposals.splice(0)) await dispose();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("sends the leading command immediately and preserves later batch boundaries through cooldown", async () => {
		const h = setup();
		expect(h.result.current).toEqual({ status: "idle", savedAt: null });
		act(() => h.commit([{ kind: "setAppName", name: "First" }]));
		expect(h.puts.map((put) => put.mutations)).toEqual([
			[{ kind: "setAppName", name: "First" }],
		]);
		expect(h.result.current.status).toBe("saving");
		act(() => h.commit([{ kind: "setAppName", name: "Second" }]));
		expect(h.puts).toHaveLength(1);
		await h.respond(0, { ok: true, seq: 1 });
		expect(h.result.current).toEqual({ status: "saved", savedAt: Date.now() });
		act(() => h.commit([{ kind: "setAppName", name: "Third" }]));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(999);
		});
		expect(h.puts).toHaveLength(1);
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
		expect(h.puts[1].mutations).toEqual([
			{ kind: "setAppName", name: "Second" },
		]);
		await h.respond(1, { ok: true, seq: 2 });
		expect(h.puts[2].mutations).toEqual([
			{ kind: "setAppName", name: "Third" },
		]);
		await h.respond(2, { ok: true, seq: 3 });
		expect(h.result.current.status).toBe("saved");
		h.unmount();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("never echoes remote writes and dispatches an unchanged semantic command", async () => {
		const h = setup();
		act(() =>
			h.reconciler.onFrame({
				seq: 1,
				batchId: "remote",
				actorId: "peer",
				kind: "autosave",
				mutations: admitMutationBatch([{ kind: "setAppName", name: "Remote" }]),
			}),
		);
		expect(h.puts).toHaveLength(0);
		expect(h.store.getState().peekCommandBatches()).toEqual([]);
		// No document bytes change, but a semantic author command still owes a row.
		act(() => h.commit([{ kind: "setAppName", name: "Remote" }]));
		expect(h.puts).toHaveLength(1);
		await h.respond(0, { ok: true, seq: 2 });
	});

	it("blocks viewer writes and cancels a queued trailing dispatch on unmount", async () => {
		const h = setup();
		act(() => h.session.setState({ canEdit: false }));
		act(() => h.commit([{ kind: "setAppName", name: "Held" }]));
		expect(h.puts).toHaveLength(0);
		act(() => h.session.setState({ canEdit: true }));
		act(() => h.commit([{ kind: "setAppName", name: "Editable" }]));
		await h.respond(0, { ok: true, seq: 1 });
		await h.respond(1, { ok: true, seq: 2 });
		act(() => h.commit([{ kind: "setAppName", name: "Trailing" }]));
		expect(h.puts).toHaveLength(2);
		h.unmount();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
		expect(h.puts).toHaveLength(2);
		expect(h.store.getState().peekCommandBatches()).toEqual([
			[{ kind: "setAppName", name: "Trailing" }],
		]);
	});

	it("keeps a sustained network error visible while the real reconciler retries", async () => {
		const h = setup();
		act(() => h.commit([{ kind: "setAppName", name: "Unsaved" }]));
		await h.respond(0, { ok: false, kind: "network" });
		expect(h.result.current.status).toBe("error");
		act(() => h.retry());
		expect(h.result.current.status).toBe("error");
		expect(h.puts[1].batchId).toBe(h.puts[0].batchId);
		await h.respond(1, { ok: true, seq: 1 });
		expect(h.result.current.status).toBe("saved");
	});
});
