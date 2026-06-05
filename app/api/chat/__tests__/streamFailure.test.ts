// app/api/chat/__tests__/streamFailure.test.ts
//
// Pins the chat route's fatal-vs-recoverable failure classification — the exact
// distinction a code review caught the route getting wrong. The route's forward
// loop calls `failRun` (refund + flip the app to `error`) when it sees a fatal
// stream error, but the SDK's `toUIMessageStream({onError})` ALSO fires for
// `tool-input-error` / `tool-output-error` chunks that the Solutions Architect
// recovers from and the run completes past. Keying failure on those would flip a
// successful build to `error` and refund a legitimate charge, so the route keys
// on the terminal `"error"` chunk type via `isFatalStreamErrorChunk`. This pins
// the PREDICATE's classification (a pure unit, no stream/mount); the route's
// wiring that calls it on `chunk.type` is verified by a Playwright/state-model
// path, not here.

import { describe, expect, it } from "vitest";
import { isFatalStreamErrorChunk } from "../streamFailure";

describe("isFatalStreamErrorChunk", () => {
	it("treats the terminal `error` chunk as fatal", () => {
		expect(isFatalStreamErrorChunk("error")).toBe(true);
	});

	it("does NOT treat tool-level error chunks as fatal (the SA recovers from them)", () => {
		// A model-emitted invalid tool call and a tool execute() throw surface as
		// these chunk types; the run continues and can still complete successfully,
		// so they must not trip finalize-as-failed.
		expect(isFatalStreamErrorChunk("tool-input-error")).toBe(false);
		expect(isFatalStreamErrorChunk("tool-output-error")).toBe(false);
	});

	it("does NOT treat ordinary content chunks as fatal", () => {
		for (const t of [
			"text-delta",
			"text-start",
			"text-end",
			"tool-input-start",
			"tool-output-available",
			"reasoning-delta",
			"finish",
		]) {
			expect(isFatalStreamErrorChunk(t)).toBe(false);
		}
	});
});
