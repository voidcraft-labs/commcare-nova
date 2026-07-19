// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScreenNavButtons } from "@/components/preview/ScreenNavButtons";

describe("ScreenNavButtons", () => {
	it("uses one shadcn back control while breadcrumbs own hierarchy", () => {
		const onBack = vi.fn();
		render(<ScreenNavButtons canGoBack onBack={onBack} />);

		const back = screen.getByRole("button", { name: "Go back" });
		expect(back.getAttribute("data-slot")).toBe("button");
		expect(back.hasAttribute("disabled")).toBe(false);
		expect(back.className).toContain("size-11");
		expect(back.className).toContain("focus-visible:ring-3");
		expect(back.className).toContain("not-disabled:hover:bg-white/5");
		expect(screen.getAllByRole("button")).toHaveLength(1);

		fireEvent.click(back);
		expect(onBack).toHaveBeenCalledTimes(1);
	});
});
