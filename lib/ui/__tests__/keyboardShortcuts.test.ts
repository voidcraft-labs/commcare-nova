import { describe, expect, it, vi } from "vitest";
import { type ShortcutContext, ShortcutRegistry } from "../keyboardShortcuts";

const plain: ShortcutContext = {
	key: "a",
	modifier: false,
	shift: false,
	editing: false,
};

describe("shortcut routing", () => {
	it("routes the original event only to a matching registration", () => {
		const registry = new ShortcutRegistry<{ command: string }>();
		const handler = vi.fn();
		registry.register("canvas", [{ key: "a", handler }]);
		const event = { command: "add" };
		expect(registry.dispatch(event, { ...plain, key: "b" })).toBe(false);
		expect(handler).not.toHaveBeenCalled();
		expect(registry.dispatch(event, plain)).toBe(true);
		expect(handler).toHaveBeenCalledExactlyOnceWith(event);
	});

	it.each([
		{ meta: true, shift: false },
		{ meta: false, shift: true },
		{ meta: true, shift: true },
	])("requires each declared modifier: %j", (rule) => {
		const registry = new ShortcutRegistry<undefined>();
		const handler = vi.fn();
		registry.register("canvas", [{ key: "a", ...rule, handler }]);
		for (const modifier of [false, true])
			for (const shift of [false, true]) {
				handler.mockClear();
				const matches = modifier === rule.meta && shift === rule.shift;
				expect(
					registry.dispatch(undefined, { ...plain, modifier, shift }),
				).toBe(matches);
				expect(handler).toHaveBeenCalledTimes(matches ? 1 : 0);
			}
	});

	it("offers the latest registration first and lets a declined key reach an earlier handler", () => {
		const registry = new ShortcutRegistry<undefined>();
		const calls: string[] = [];
		let decline = false;
		registry.register("canvas", [
			{
				key: "a",
				handler: () => {
					calls.push("canvas");
				},
			},
		]);
		registry.register("dialog", [
			{
				key: "a",
				handler: () => {
					calls.push("dialog");
					return !decline;
				},
			},
		]);
		expect(registry.dispatch(undefined, plain)).toBe(true);
		expect(calls).toEqual(["dialog"]);
		calls.length = 0;
		decline = true;
		expect(registry.dispatch(undefined, plain)).toBe(true);
		expect(calls).toEqual(["dialog", "canvas"]);
		registry.unregister("canvas");
		expect(registry.dispatch(undefined, plain)).toBe(false);
	});

	it("re-registering replaces the previous rules and takes priority", () => {
		const registry = new ShortcutRegistry<undefined>();
		const stale = vi.fn();
		const latest = vi.fn();
		const other = vi.fn();
		registry.register("canvas", [{ key: "x", handler: stale }]);
		registry.register("dialog", [{ key: "a", handler: other }]);
		registry.register("canvas", [{ key: "a", handler: latest }]);
		expect(registry.dispatch(undefined, { ...plain, key: "x" })).toBe(false);
		expect(registry.dispatch(undefined, plain)).toBe(true);
		expect(latest).toHaveBeenCalledOnce();
		expect(other).not.toHaveBeenCalled();
		expect(stale).not.toHaveBeenCalled();
		registry.unregister("canvas");
		expect(registry.empty).toBe(false);
		expect(registry.dispatch(undefined, plain)).toBe(true);
		expect(other).toHaveBeenCalledOnce();
		registry.unregister("dialog");
		expect(registry.empty).toBe(true);
		expect(registry.dispatch(undefined, plain)).toBe(false);
	});

	it("editing suppresses local commands while allowing global commands", () => {
		const registry = new ShortcutRegistry<undefined>();
		const global = vi.fn();
		const local = vi.fn();
		registry.register("global", [{ key: "a", global: true, handler: global }]);
		registry.register("canvas", [{ key: "a", handler: local }]);
		expect(registry.dispatch(undefined, { ...plain, editing: true })).toBe(
			true,
		);
		expect(global).toHaveBeenCalledOnce();
		expect(local).not.toHaveBeenCalled();
		registry.unregister("global");
		expect(registry.dispatch(undefined, { ...plain, editing: true })).toBe(
			false,
		);
		expect(registry.dispatch(undefined, plain)).toBe(true);
		expect(local).toHaveBeenCalledOnce();
	});
});
