// @vitest-environment happy-dom

/**
 * `useSessionEventsEmpty` — verifies the buffer-empty predicate tracks
 * the session store's events array. Replaces the inline
 * `useBuilderSession((s) => s.events.length === 0)` selector in
 * `ChatSidebar`, which gates the Completed → Ready auto-decay timer on
 * the SSE stream having actually closed.
 *
 * Two cases cover the only behavior the hook has: an empty buffer
 * returns `true`, and any pushed event flips the value to `false`.
 */

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import type { Event } from "@/lib/log/types";
import { useSessionEventsEmpty } from "../hooks";
import { BuilderSessionContext, useBuilderSessionApi } from "../provider";
import { createBuilderSessionStore } from "../store";

/** Minimal conversation event — we only need a shape the buffer accepts. */
function assistantText(seq: number, text: string): Event {
	return {
		kind: "conversation",
		runId: "run-empty-test",
		ts: seq * 1000,
		seq,
		payload: { type: "assistant-text", text },
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
			empty: useSessionEventsEmpty(),
			api: useBuilderSessionApi(),
		}),
		{ wrapper },
	);
}

describe("useSessionEventsEmpty", () => {
	it("returns true when the events buffer is empty", () => {
		const { result } = renderWithStore();
		expect(result.current.empty).toBe(true);
	});

	it("flips to false once an event is pushed", () => {
		const { result } = renderWithStore();
		act(() => {
			result.current.api.getState().pushEvent(assistantText(0, "hello"));
		});
		expect(result.current.empty).toBe(false);
	});
});
