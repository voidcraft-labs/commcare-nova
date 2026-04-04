/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keyboardManager } from "../keyboardManager";

describe("keyboardManager", () => {
	beforeEach(() => {
		// Reset by unregistering any previous test registrations
		keyboardManager.unregister("test-1");
		keyboardManager.unregister("test-2");
	});

	afterEach(() => {
		keyboardManager.unregister("test-1");
		keyboardManager.unregister("test-2");
	});

	it("calls handler for matching shortcut", () => {
		const handler = vi.fn();
		keyboardManager.register("test-1", [{ key: "a", handler }]);

		const event = new KeyboardEvent("keydown", { key: "a" });
		document.dispatchEvent(event);

		expect(handler).toHaveBeenCalledOnce();
	});

	it("does not call handler for non-matching key", () => {
		const handler = vi.fn();
		keyboardManager.register("test-1", [{ key: "a", handler }]);

		document.dispatchEvent(new KeyboardEvent("keydown", { key: "b" }));
		expect(handler).not.toHaveBeenCalled();
	});

	it("respects meta modifier", () => {
		const handler = vi.fn();
		keyboardManager.register("test-1", [{ key: "z", meta: true, handler }]);

		// Without meta — should not fire
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "z" }));
		expect(handler).not.toHaveBeenCalled();

		// With ctrlKey (non-Mac) — should fire
		document.dispatchEvent(
			new KeyboardEvent("keydown", { key: "z", ctrlKey: true }),
		);
		expect(handler).toHaveBeenCalledOnce();
	});

	it("respects shift modifier", () => {
		const handler = vi.fn();
		keyboardManager.register("test-1", [{ key: "z", shift: true, handler }]);

		document.dispatchEvent(new KeyboardEvent("keydown", { key: "z" }));
		expect(handler).not.toHaveBeenCalled();

		document.dispatchEvent(
			new KeyboardEvent("keydown", { key: "z", shiftKey: true }),
		);
		expect(handler).toHaveBeenCalledOnce();
	});

	it("unregister removes shortcuts", () => {
		const handler = vi.fn();
		keyboardManager.register("test-1", [{ key: "x", handler }]);
		keyboardManager.unregister("test-1");

		document.dispatchEvent(new KeyboardEvent("keydown", { key: "x" }));
		expect(handler).not.toHaveBeenCalled();
	});

	it("later registrations take priority", () => {
		const handler1 = vi.fn();
		const handler2 = vi.fn();
		keyboardManager.register("test-1", [{ key: "a", handler: handler1 }]);
		keyboardManager.register("test-2", [{ key: "a", handler: handler2 }]);

		document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
		// Later registration should fire, earlier should not (it returns after first match)
		expect(handler2).toHaveBeenCalledOnce();
		expect(handler1).not.toHaveBeenCalled();
	});

	it("suppresses non-global shortcuts when input is focused", () => {
		const handler = vi.fn();
		keyboardManager.register("test-1", [{ key: "a", handler }]);

		const input = document.createElement("input");
		document.body.appendChild(input);
		input.focus();

		document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
		expect(handler).not.toHaveBeenCalled();

		document.body.removeChild(input);
	});

	it("fires global shortcuts even when input is focused", () => {
		const handler = vi.fn();
		keyboardManager.register("test-1", [
			{ key: "z", meta: true, global: true, handler },
		]);

		const input = document.createElement("input");
		document.body.appendChild(input);
		input.focus();

		document.dispatchEvent(
			new KeyboardEvent("keydown", { key: "z", ctrlKey: true }),
		);
		expect(handler).toHaveBeenCalledOnce();

		document.body.removeChild(input);
	});
});
