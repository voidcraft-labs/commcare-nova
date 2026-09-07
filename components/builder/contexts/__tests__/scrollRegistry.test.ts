import { describe, expect, it, vi } from "vitest";
import { createScrollRegistry } from "../scrollRegistry";

describe("the production pending-scroll owner", () => {
	it("a stale registration cleanup cannot remove its successor, while live cleanup releases it", () => {
		const registry = createScrollRegistry();
		const first = vi.fn(),
			second = vi.fn();
		const releaseFirst = registry.registerCallback(first);
		const releaseSecond = registry.registerCallback(second);
		releaseFirst();
		registry.scrollTo("field", undefined, "instant", true);
		expect(first).not.toHaveBeenCalled();
		expect(second.mock.calls).toEqual([["field", undefined, "instant", true]]);
		releaseSecond();
		registry.scrollTo("later");
		expect(second).toHaveBeenCalledOnce();
	});

	it("only the current pending identity is consumed and it is consumed once", () => {
		const registry = createScrollRegistry();
		const scroll = vi.fn();
		registry.registerCallback(scroll);
		registry.setPending("old", "smooth", false);
		registry.setPending("current", "instant", true);
		expect(registry.fulfillPending("old")).toBe(false);
		expect(scroll).not.toHaveBeenCalled();
		expect(registry.fulfillPending("current")).toBe(true);
		expect(registry.fulfillPending("current")).toBe(false);
		expect(scroll.mock.calls).toEqual([
			["current", undefined, "instant", true],
		]);
	});

	it("immediate scrolling leaves an unrelated pending request intact", () => {
		const registry = createScrollRegistry();
		const scroll = vi.fn();
		registry.registerCallback(scroll);
		registry.setPending("selected", "smooth", false);
		registry.scrollTo("undo", undefined, "instant", true);
		expect(registry.fulfillPending("selected")).toBe(true);
		expect(scroll.mock.calls).toEqual([
			["undo", undefined, "instant", true],
			["selected", undefined, "smooth", false],
		]);
	});

	it("consumes before dispatch so a callback can install the next pending request", () => {
		const registry = createScrollRegistry();
		const seen: string[] = [];
		registry.registerCallback((uuid) => {
			seen.push(uuid);
			if (uuid === "first") registry.setPending("second", "instant", false);
		});
		registry.setPending("first", "smooth", false);
		expect(registry.fulfillPending("first")).toBe(true);
		expect(registry.fulfillPending("second")).toBe(true);
		expect(seen).toEqual(["first", "second"]);
	});
});
