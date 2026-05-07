/**
 * Sanity tests for `STRIP_TARGET_TOOL_NAMES` — the union of
 * `BUILD_ONLY_TOOL_NAMES` + `RETIRED_TOOL_NAMES` that the chat route
 * applies to edit-mode message history.
 *
 * The strip set's correctness is structurally important but easy to
 * silently regress: a refactor that removes a tool from the registered
 * set without adding to `RETIRED_TOOL_NAMES` re-introduces the
 * "tool not found" rejection on every persisted chat that used the
 * tool. These tests fail at the constant-shape level so the regression
 * surfaces in CI, not in production after a user mid-thread edit
 * lands on Anthropic's 4xx.
 */

import { describe, expect, it } from "vitest";
import {
	BUILD_ONLY_TOOL_NAMES,
	RETIRED_TOOL_NAMES,
	STRIP_TARGET_TOOL_NAMES,
} from "../solutionsArchitect";

describe("STRIP_TARGET_TOOL_NAMES", () => {
	it("contains every BUILD_ONLY_TOOL_NAMES entry", () => {
		// Build-only tools are excluded from edit-mode tool sets, so any
		// `tool-${name}` part in historical assistant turns must be
		// stripped before the request reaches Anthropic.
		for (const name of BUILD_ONLY_TOOL_NAMES) {
			expect(STRIP_TARGET_TOOL_NAMES).toContain(name);
		}
	});

	it("contains every RETIRED_TOOL_NAMES entry", () => {
		// Retired tools no longer appear in any tool set (build or edit).
		// Persisted chat threads that called these tools predate the
		// removal and must not surface their references on the wire —
		// any survivor produces a 4xx mid-thread until the cache expires.
		for (const name of RETIRED_TOOL_NAMES) {
			expect(STRIP_TARGET_TOOL_NAMES).toContain(name);
		}
	});

	it("contains the addModule retirement explicitly", () => {
		// Concrete check on the historical retirement: `addModule` was
		// the SA tool deleted in the case-list-config migration. Locking
		// it by name guards against a refactor that drops the entry from
		// `RETIRED_TOOL_NAMES` (which would re-expose the "tool not found"
		// rejection on every prior build's chat history).
		expect(RETIRED_TOOL_NAMES).toContain("addModule");
		expect(STRIP_TARGET_TOOL_NAMES).toContain("addModule");
	});
});
