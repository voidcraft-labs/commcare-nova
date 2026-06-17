import { describe, expect, it, vi } from "vitest";

// `vitest.setup.ts` replaces the whole `@/lib/logger` module with stubs so
// the suite stays quiet — that stub has no `sentryTagsFor`. Reach past it for
// the real pure helper; nothing here exercises the side-effecting log methods.
const { sentryTagsFor } =
	await vi.importActual<typeof import("../logger")>("../logger");

describe("sentryTagsFor", () => {
	it("promotes the [component] message prefix to a `component` tag", () => {
		expect(sentryTagsFor("[chat] credit gate read failed", undefined)).toEqual({
			component: "chat",
		});
	});

	it("keeps a slashed component prefix intact", () => {
		expect(sentryTagsFor("[commcare/upload] failed", undefined)).toEqual({
			component: "commcare/upload",
		});
	});

	it("returns undefined when nothing is promotable", () => {
		expect(sentryTagsFor("no bracket prefix here", undefined)).toBeUndefined();
		expect(sentryTagsFor("no bracket prefix here", {})).toBeUndefined();
	});

	it("promotes only the allowlisted identity keys, leaving other context out", () => {
		const tags = sentryTagsFor("[mcp] tool handler failed", {
			appId: "app-1",
			userId: "user-9",
			runId: "run-7",
			// not on the allowlist — stays in `extra`, never becomes a tag
			error_type: "internal",
			args: [1, 2, 3],
		});
		expect(tags).toEqual({
			component: "mcp",
			appId: "app-1",
			userId: "user-9",
			runId: "run-7",
		});
	});

	it("skips null / undefined identity values (call sites pass `ctx ?? null`)", () => {
		expect(
			sentryTagsFor("[mcp] cross-tenant access attempt", {
				userId: null,
				appId: undefined,
			}),
		).toEqual({ component: "mcp" });
	});

	it("coerces non-string identity values the same way Cloud Logging labels are", () => {
		// Identity keys are conventionally strings; coercion is a defensive
		// floor so a stray number/object can't crash the capture.
		expect(
			sentryTagsFor("[apps] save rejected", { appId: 42, ownerId: { a: 1 } }),
		).toEqual({
			component: "apps",
			appId: "42",
			ownerId: '{"a":1}',
		});
	});
});
