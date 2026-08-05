/**
 * deriveChatAppReady — pure function unit tests.
 *
 * The chat surface's build-vs-edit read: what the cost chip shows and the
 * advisory `appReady` request field carries. It is NOT `useBuilderIsReady`
 * (phase Ready|Completed): the session store's `buildUnfinished` latch has to
 * override the phase, because an askQuestions pause closes the stream,
 * `endRun` clears the events buffer, and the app's committed genesis modules
 * make the phase read Ready mid-build. The production incident this pins: a
 * `/build/new` tab answered a paused build's questions with `appReady: true`,
 * the route resumed the answer as an EDIT against the BUILD holder, and every
 * answer bounced as superseded.
 *
 * No React, no providers — just the pure function.
 */

import { describe, expect, it } from "vitest";
import { deriveChatAppReady } from "../hooks";

/** A post-pause session: nothing loading, no completion stamp, the events
 *  buffer already cleared by `endRun` — exactly what the answer send sees. */
const pausedAnswer = {
	loading: false,
	runCompletedAt: undefined as number | undefined,
	events: [],
	runStartedWithData: false,
	buildUnfinished: true,
};

describe("deriveChatAppReady", () => {
	it("keeps a paused build's answer in build mode: the latch overrides the Ready phase the genesis modules produce", () => {
		expect(deriveChatAppReady(pausedAnswer, true)).toBe(false);
	});

	it("reads a complete app as edit mode once the latch is released", () => {
		expect(
			deriveChatAppReady({ ...pausedAnswer, buildUnfinished: false }, true),
		).toBe(true);
	});

	it("reads edit mode during the celebration window: data-done stamped completion, so the build is over even before the latch release is observed", () => {
		expect(
			deriveChatAppReady({ ...pausedAnswer, runCompletedAt: Date.now() }, true),
		).toBe(true);
	});

	it("stays build mode on a fresh /build/new session with no data and no latch", () => {
		expect(
			deriveChatAppReady({ ...pausedAnswer, buildUnfinished: false }, false),
		).toBe(false);
	});
});
