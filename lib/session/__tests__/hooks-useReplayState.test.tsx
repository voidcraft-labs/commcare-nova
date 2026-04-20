// @vitest-environment happy-dom

/**
 * `useReplayState` — verifies the hook returns `undefined` when no
 * replay has been loaded and the full `ReplayData` object once
 * `loadReplay` seeds the store. Replaces the inline
 * `useBuilderSession((s) => s.replay)` selector in `ReplayController`.
 */

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { Event } from "@/lib/log/types";
import { useReplayState } from "../hooks";
import { BuilderSessionContext, useBuilderSessionApi } from "../provider";
import { createBuilderSessionStore } from "../store";

/** Smallest possible user-message event — enough to populate a replay
 *  log without pulling in the full conversation-payload union. */
function userMsg(seq: number, text: string): Event {
	return {
		kind: "conversation",
		runId: "run-replay-state-test",
		ts: seq * 1000,
		seq,
		payload: { type: "user-message", text },
	};
}

function renderWithStore() {
	const store = createBuilderSessionStore();
	function wrapper({ children }: { children: ReactNode }) {
		return (
			<BuilderSessionContext.Provider value={store}>
				{children}
			</BuilderSessionContext.Provider>
		);
	}
	return renderHook(
		() => ({
			replay: useReplayState(),
			api: useBuilderSessionApi(),
		}),
		{ wrapper },
	);
}

describe("useReplayState", () => {
	it("returns undefined when no replay has been loaded", () => {
		const { result } = renderWithStore();
		expect(result.current.replay).toBeUndefined();
	});

	it("returns the ReplayData object once loadReplay seeds the store", () => {
		const { result } = renderWithStore();
		const events: Event[] = [userMsg(0, "build me an app")];
		act(() => {
			result.current.api.getState().loadReplay({
				events,
				chapters: [],
				initialCursor: 0,
				exitPath: "/exit",
			});
		});
		/* Identity check plus field spot-checks — `loadReplay` does not
		 * clone the input arrays, so the stored `events` reference should
		 * be the same object we passed in. */
		expect(result.current.replay).toBeDefined();
		expect(result.current.replay?.events).toBe(events);
		expect(result.current.replay?.cursor).toBe(0);
		expect(result.current.replay?.exitPath).toBe("/exit");
		expect(result.current.replay?.chapters).toEqual([]);
	});
});
