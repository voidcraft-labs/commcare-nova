// @vitest-environment happy-dom

import { act, render, screen } from "@testing-library/react";
import type { HTMLAttributes, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastContainer } from "@/components/ui/ToastContainer";
import { showProjectToast, toastStore } from "@/lib/ui/toastStore";

vi.mock("motion/react", () => ({
	AnimatePresence: ({ children }: { children: ReactNode }) => children,
	motion: {
		div: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) => (
			<div {...props}>{children}</div>
		),
	},
}));

afterEach(() => {
	toastStore.clear();
	toastStore.deactivateProjectScope("toast-dom-test");
});

describe("ToastContainer Project retirement", () => {
	it("hides scoped source text synchronously before React removes it", () => {
		const source = { scopeId: "toast-dom-test", epoch: 0 };
		toastStore.activateProjectScope(source);
		render(<ToastContainer />);
		act(() => {
			showProjectToast(
				source,
				"warning",
				"Source project warning",
				"Source-only detail",
			);
		});
		const sourceText = screen.getByText("Source project warning");
		const scopedNode = sourceText.closest<HTMLElement>(
			"[data-nova-project-toast-scope]",
		);
		expect(scopedNode).not.toBeNull();

		let hiddenInsideBoundary = false;
		act(() => {
			toastStore.activateProjectScope({
				scopeId: "toast-dom-test",
				epoch: 1,
			});
			hiddenInsideBoundary =
				scopedNode?.hidden === true &&
				scopedNode.style.getPropertyValue("display") === "none" &&
				scopedNode.style.getPropertyPriority("display") === "important";
		});

		expect(hiddenInsideBoundary).toBe(true);
		expect(sourceText.closest("[aria-hidden='true']")).not.toBeNull();
	});
});
