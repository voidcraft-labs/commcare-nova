import { beforeEach, describe, expect, it, vi } from "vitest";
import { showProjectToast, showToast, toastStore } from "@/lib/ui/toastStore";

let testScope = 0;

beforeEach(() => {
	toastStore.clear();
	testScope += 1;
	toastStore.activateProjectScope({
		scopeId: `test-scope-${testScope}`,
		epoch: 0,
	});
});

describe("Project-scoped toasts", () => {
	it("drops source notices synchronously while preserving unrelated global notices", () => {
		const scopeId = `test-scope-${testScope}`;
		showToast("info", "Signed in");
		showProjectToast({ scopeId, epoch: 0 }, "info", "Source case updated");
		expect(toastStore.toasts.map((toast) => toast.title)).toEqual([
			"Signed in",
			"Source case updated",
		]);

		toastStore.activateProjectScope({ scopeId, epoch: 1 });
		expect(toastStore.toasts.map((toast) => toast.title)).toEqual([
			"Signed in",
		]);
	});

	it("rejects late source completions and refuses their stale actions", () => {
		const scopeId = `test-scope-${testScope}`;
		const action = vi.fn();
		const sourceToastId = showProjectToast(
			{ scopeId, epoch: 0 },
			"warning",
			"Value dismissed",
			undefined,
			{ action: { label: "Undo", onPress: action } },
		);

		toastStore.activateProjectScope({ scopeId, epoch: 1 });
		toastStore.invokeAction(sourceToastId);
		expect(action).not.toHaveBeenCalled();

		showProjectToast({ scopeId, epoch: 0 }, "info", "Late source filename.pdf");
		expect(toastStore.toasts).toHaveLength(0);
	});

	it("runs an action only in its current Project generation", () => {
		const scopeId = `test-scope-${testScope}`;
		const action = vi.fn();
		const toastId = showProjectToast(
			{ scopeId, epoch: 0 },
			"info",
			"Current notice",
			undefined,
			{ action: { label: "Open", onPress: action } },
		);

		toastStore.invokeAction(toastId);
		expect(action).toHaveBeenCalledOnce();
		expect(toastStore.toasts).toHaveLength(0);
	});
});
