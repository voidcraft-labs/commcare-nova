import { describe, expect, it } from "vitest";
import type {
	HqChangesBringInBody,
	HqChangesProgress,
	HqChangesRequestEnd,
} from "@/components/builder/hqChangesClient";
import type {
	HqChangesPanelEvent,
	HqChangesRequest,
} from "@/components/builder/hqChangesPanelModel";
import { createHqChangesRequester } from "@/components/builder/hqChangesRequester";
import type { DeploymentView } from "@/lib/deployment/actions";
import type {
	HqChangesKey,
	HqChangesOutcome,
	HqChangesReview,
} from "@/lib/deployment/hqChanges/types";

const KEY: HqChangesKey = {
	appId: "app-1",
	server: "production",
	domain: "clinic",
};
const REVIEW: HqChangesRequest = { id: 1, kind: "review" };
const BRING_IN: HqChangesRequest = {
	id: 2,
	kind: "bring-in",
	readingId: "reading-1",
	reviewDigest: "d".repeat(64),
	tableChoices: {},
	ownerRuleChoices: {},
};
const NOTHING: HqChangesReview = {
	kind: "nothing",
	reason: "unchanged",
	since: { kind: "published" },
	hqChanges: [],
	publishChanges: [],
	readingId: null,
	reviewDigest: null,
};
const BROUGHT_IN: HqChangesOutcome = {
	kind: "brought-in",
	seq: 7,
	discarded: false,
	deployment: { marker: "record" } as unknown as DeploymentView,
};

/** A request the test answers when it chooses, and whether its signal was aborted. */
interface Pending<T> {
	readonly signal: AbortSignal | undefined;
	readonly progress: (event: HqChangesProgress) => void;
	readonly answer: (end: HqChangesRequestEnd<T>) => Promise<void>;
}

function harness() {
	const reviews: Pending<HqChangesReview>[] = [];
	const bringIns: (Pending<HqChangesOutcome> & {
		readonly body: HqChangesBringInBody;
	})[] = [];
	const events: HqChangesPanelEvent[] = [];
	const afterStop: HqChangesOutcome[] = [];
	const beforeBringIn: string[] = [];
	function pending<T>(
		signal: AbortSignal | undefined,
		progress: (event: HqChangesProgress) => void,
	) {
		const { promise, resolve } =
			Promise.withResolvers<HqChangesRequestEnd<T>>();
		return {
			promise,
			entry: {
				signal,
				progress,
				/* Resolves the request, then lets its continuation run. */
				answer: async (end: HqChangesRequestEnd<T>) => {
					resolve(end);
					await promise;
					await Promise.resolve();
				},
			},
		};
	}
	const requester = createHqChangesRequester({
		postReview: (_key, progress, signal) => {
			const { promise, entry } = pending<HqChangesReview>(signal, progress);
			reviews.push(entry);
			return promise;
		},
		postBringIn: (body, progress) => {
			const { promise, entry } = pending<HqChangesOutcome>(undefined, progress);
			bringIns.push({ ...entry, body });
			return promise;
		},
		dispatch: (event) => events.push(event),
		beforeBringIn: (request) => beforeBringIn.push(request.reviewDigest),
		answeredAfterStop: (outcome) => afterStop.push(outcome),
	});
	return { requester, reviews, bringIns, events, afterStop, beforeBringIn };
}

describe("the panel's requests", () => {
	it("sends each request once, and hands the panel its stages and its answer", async () => {
		const { requester, reviews, events } = harness();
		requester.start();
		requester.send(REVIEW, KEY);
		requester.send(REVIEW, KEY);
		expect(reviews).toHaveLength(1);
		reviews[0].progress({ type: "stage", stage: "reading-app" });
		await reviews[0].answer({ kind: "done", answer: NOTHING });
		expect(events).toEqual([
			{ type: "sent", id: 1 },
			{ type: "stage", stage: "reading-app" },
			{ type: "review-answered", review: NOTHING },
		]);
	});

	it("sends the review again when a replayed mount stops and starts the panel, and answers only the second", async () => {
		/* Strict Mode runs a mount's effects, their cleanups, then the effects
		 * again, over the same render: start, send, stop, start, send. */
		const { requester, reviews, events } = harness();
		requester.start();
		requester.send(REVIEW, KEY);
		requester.stop();
		requester.start();
		requester.send(REVIEW, KEY);
		expect(reviews).toHaveLength(2);
		expect(reviews[0].signal?.aborted).toBe(true);
		expect(reviews[1].signal?.aborted).toBe(false);
		await reviews[0].answer({ kind: "lost" });
		await reviews[1].answer({ kind: "done", answer: NOTHING });
		expect(events).toEqual([
			{ type: "sent", id: 1 },
			{ type: "review-answered", review: NOTHING },
		]);
	});

	it("aborts the review for good when the panel goes, and says nothing after", async () => {
		const { requester, reviews, events } = harness();
		requester.start();
		requester.send(REVIEW, KEY);
		requester.stop();
		await reviews[0].answer({ kind: "done", answer: NOTHING });
		expect(reviews).toHaveLength(1);
		expect(reviews[0].signal?.aborted).toBe(true);
		expect(events).toEqual([{ type: "sent", id: 1 }]);
	});

	it("never stops a bring-in, and hands its answer to the panel through a replayed mount", async () => {
		const { requester, bringIns, events, afterStop, beforeBringIn } = harness();
		requester.start();
		requester.send(BRING_IN, KEY);
		requester.stop();
		requester.start();
		requester.send(BRING_IN, KEY);
		expect(bringIns).toHaveLength(1);
		expect(bringIns[0].body).toEqual({
			...KEY,
			readingId: "reading-1",
			reviewDigest: "d".repeat(64),
			tableChoices: {},
			ownerRuleChoices: {},
		});
		expect(beforeBringIn).toEqual(["d".repeat(64)]);
		await bringIns[0].answer({ kind: "done", answer: BROUGHT_IN });
		expect(events).toEqual([
			{ type: "sent", id: 2 },
			{ type: "bring-in-answered", outcome: BROUGHT_IN },
		]);
		expect(afterStop).toEqual([]);
	});

	it("hands a bring-in that answers once the panel is gone to the surface that outlives it", async () => {
		const { requester, bringIns, events, afterStop } = harness();
		requester.start();
		requester.send(BRING_IN, KEY);
		requester.stop();
		bringIns[0].progress({ type: "stage", stage: "bringing-in" });
		await bringIns[0].answer({ kind: "done", answer: BROUGHT_IN });
		expect(afterStop).toEqual([BROUGHT_IN]);
		expect(events).toEqual([{ type: "sent", id: 2 }]);
	});

	it("tells the panel a request its route refused, with the route's sentence", async () => {
		const { requester, reviews, bringIns, events } = harness();
		requester.start();
		requester.send(REVIEW, KEY);
		await reviews[0].answer({
			kind: "refused",
			message: "No edit access.",
			checkAgain: false,
		});
		requester.send(BRING_IN, KEY);
		await bringIns[0].answer({ kind: "failed" });
		expect(events).toEqual([
			{ type: "sent", id: 1 },
			{
				type: "review-ended",
				end: { message: "No edit access.", checkAgain: false },
			},
			{ type: "sent", id: 2 },
			{ type: "bring-in-ended", end: "failed" },
		]);
	});
});
