// After a form is submitted, a link whose target's menu reads lookup data
// still loading waits for it. The route reads the session of the entry it
// routes, so if the worker running Preview changes while it waits, the route
// is stale: pushing it would land one worker's next screen on another's
// session. Each wait below is scripted as what changed while the screen
// waited, which is exactly the window a browser cannot hold on demand.

import { describe, expect, it } from "vitest";
import {
	type AfterSubmitRoute,
	settleAfterSubmitRoute,
} from "@/lib/preview/afterSubmitRouting";
import { previewAsMe } from "@/lib/preview/engine/identity";
import { previewLookupData } from "@/lib/preview/engine/lookupEvaluation";
import type { PreviewLookupStatus } from "@/lib/preview/engine/useLookupPreviewData";

function worker(id: string, email: string) {
	const identity = previewAsMe({ id, email });
	if (identity === null) throw new Error("The worker has no identity.");
	return identity;
}

const LOADED: PreviewLookupStatus = {
	kind: "data",
	data: previewLookupData({
		projectRevision: "1",
		definitions: [],
		rowsByTable: new Map(),
	}),
};

const MENU: AfterSubmitRoute = {
	kind: "post-submit",
	destination: "module",
};

/**
 * The screen's inputs while a submitted entry routes: the live lookup status
 * and the running worker, and the changes each wait sees. The target is
 * pending until the lookup data is in.
 */
function screen(changes: readonly ((state: ScreenState) => void)[]) {
	const entryIdentity = worker("worker-1", "amina@example.org");
	const state: ScreenState = {
		lookup: { kind: "loading" },
		running: entryIdentity,
		current: true,
	};
	let waits = 0;
	let routeReads = 0;
	const settle = () =>
		settleAfterSubmitRoute({
			route: () => {
				routeReads++;
				return state.lookup.kind === "data" ? MENU : { kind: "pending" };
			},
			lookup: () => state.lookup,
			nextInputs: async () => {
				const change = changes[waits++];
				if (change === undefined) throw new Error("Nothing more changes.");
				change(state);
			},
			isCurrent: () => state.current,
			runningIdentity: () => state.running,
			entryIdentity,
		});
	return {
		settle,
		state,
		waits: () => waits,
		routeReads: () => routeReads,
	};
}

interface ScreenState {
	lookup: PreviewLookupStatus;
	running: ReturnType<typeof worker> | null;
	current: boolean;
}

describe("an after-submit route waiting on lookup data", () => {
	it("routes at once when the target's data is already in", async () => {
		const subject = screen([]);
		subject.state.lookup = LOADED;
		await expect(subject.settle()).resolves.toEqual({
			kind: "route",
			route: MENU,
		});
		expect(subject.waits()).toBe(0);
	});

	it("routes once the lookup data arrives for the same worker, re-derived", async () => {
		const subject = screen([
			(state) => {
				/* A session refetch mints a new identity object for the same
				 * worker, and the lookup data is still loading. */
				state.running = worker("worker-1", "amina@example.org");
			},
			(state) => {
				state.lookup = LOADED;
			},
		]);
		await expect(subject.settle()).resolves.toEqual({
			kind: "route",
			route: MENU,
		});
		expect(subject.waits()).toBe(2);
	});

	it("is stale when another worker runs Preview by the time the data arrives", async () => {
		const subject = screen([
			(state) => {
				state.running = worker("worker-2", "kofi@example.org");
				state.lookup = LOADED;
			},
		]);
		await expect(subject.settle()).resolves.toEqual({ kind: "stale" });
		/* The route is never read for the new worker's session. */
		expect(subject.routeReads()).toBe(1);
	});

	it("is stale when the worker's session ends while it waits", async () => {
		const subject = screen([
			(state) => {
				state.running = null;
			},
		]);
		await expect(subject.settle()).resolves.toEqual({ kind: "stale" });
		expect(subject.routeReads()).toBe(1);
	});

	it("is stale when the attempt is no longer current, the screen having let go", async () => {
		const subject = screen([
			(state) => {
				state.current = false;
				state.lookup = LOADED;
			},
		]);
		await expect(subject.settle()).resolves.toEqual({ kind: "stale" });
		expect(subject.routeReads()).toBe(1);
	});

	it("stops waiting when the lookup data failed to load, since nothing later wakes it", async () => {
		const subject = screen([
			(state) => {
				state.lookup = { kind: "error" };
			},
		]);
		await expect(subject.settle()).resolves.toEqual({
			kind: "lookup-unavailable",
		});
		expect(subject.waits()).toBe(1);
	});
});
