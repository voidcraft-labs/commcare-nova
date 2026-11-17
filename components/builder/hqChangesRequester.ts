/**
 * The requests one changes made in CommCare HQ panel sends, and where their
 * answers go: to the panel while it is mounted, and, for a bring-in that
 * answers once the panel is gone, to the surface that outlives it.
 *
 * It is built once per panel and lives across React's start and stop of the
 * panel's effects, as the reconciler's runtime does: `start` and `stop` are a
 * pair that can run more than once (Strict Mode replays a mount as start,
 * stop, start). A review is aborted when the panel stops and sent again if
 * the panel starts again, so a replayed mount still reads CommCare HQ. A
 * bring-in is never stopped: it may already be writing the app, so its
 * answer is always delivered somewhere.
 */

import type {
	HqChangesBringInBody,
	HqChangesProgress,
	HqChangesRequestEnd,
} from "@/components/builder/hqChangesClient";
import type {
	HqChangesPanelEvent,
	HqChangesRequest,
	RequestEnd,
} from "@/components/builder/hqChangesPanelModel";
import type {
	HqChangesKey,
	HqChangesOutcome,
	HqChangesReview,
} from "@/lib/deployment/hqChanges/types";

export interface HqChangesRequesterDeps {
	readonly postReview: (
		key: HqChangesKey,
		onProgress: (event: HqChangesProgress) => void,
		signal: AbortSignal,
	) => Promise<HqChangesRequestEnd<HqChangesReview>>;
	readonly postBringIn: (
		body: HqChangesBringInBody,
		onProgress: (event: HqChangesProgress) => void,
	) => Promise<HqChangesRequestEnd<HqChangesOutcome>>;
	/** Hands the panel an event; called only while the panel is started. */
	readonly dispatch: (event: HqChangesPanelEvent) => void;
	/** Just before a bring-in is sent. */
	readonly beforeBringIn: (
		request: Extract<HqChangesRequest, { kind: "bring-in" }>,
	) => void;
	/** A bring-in answered once the panel had stopped. */
	readonly answeredAfterStop: (outcome: HqChangesOutcome) => void;
}

export interface HqChangesRequester {
	/** The panel is mounted: answers reach it, and a review its stop aborted is sent again. */
	start(): void;
	/** The panel is gone, or React replays its mount: a review in flight is aborted. */
	stop(): void;
	/** Sends the request the model names, once per id. */
	send(request: HqChangesRequest, key: HqChangesKey): void;
}

function requestEnd(
	end: Exclude<HqChangesRequestEnd<unknown>, { kind: "done" }>,
): RequestEnd {
	return end.kind === "refused"
		? { message: end.message, checkAgain: end.checkAgain }
		: end.kind;
}

export function createHqChangesRequester(
	deps: HqChangesRequesterDeps,
): HqChangesRequester {
	let started = false;
	let lastSent = 0;
	type InFlightReview = {
		readonly key: HqChangesKey;
		readonly controller: AbortController;
	};
	let review: InFlightReview | null = null;
	/* A review the panel's stop aborted, to send again on its next start. */
	let stoppedReview: HqChangesKey | null = null;

	const progress = (event: HqChangesProgress) => {
		if (started) deps.dispatch(event);
	};

	function sendReview(key: HqChangesKey): void {
		review?.controller.abort();
		const current: InFlightReview = { key, controller: new AbortController() };
		review = current;
		void deps
			.postReview(key, progress, current.controller.signal)
			.then((end) => {
				if (current.controller.signal.aborted) return;
				if (review === current) review = null;
				if (!started) return;
				deps.dispatch(
					end.kind === "done"
						? { type: "review-answered", review: end.answer }
						: { type: "review-ended", end: requestEnd(end) },
				);
			});
	}

	return {
		start() {
			started = true;
			const resend = stoppedReview;
			stoppedReview = null;
			if (resend !== null) sendReview(resend);
		},
		stop() {
			started = false;
			if (review === null) return;
			stoppedReview = review.key;
			review.controller.abort();
			review = null;
		},
		send(request, key) {
			if (request.id <= lastSent) return;
			lastSent = request.id;
			deps.dispatch({ type: "sent", id: request.id });
			if (request.kind === "review") {
				stoppedReview = null;
				sendReview(key);
				return;
			}
			deps.beforeBringIn(request);
			void deps
				.postBringIn(
					{
						...key,
						readingId: request.readingId,
						reviewDigest: request.reviewDigest,
						tableChoices: request.tableChoices,
					},
					progress,
				)
				.then((end) => {
					if (started) {
						deps.dispatch(
							end.kind === "done"
								? { type: "bring-in-answered", outcome: end.answer }
								: { type: "bring-in-ended", end: requestEnd(end) },
						);
						return;
					}
					if (end.kind === "done") deps.answeredAfterStop(end.answer);
				});
		},
	};
}
