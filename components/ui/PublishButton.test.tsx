// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { PublishButton } from "./PublishButton";

it("names the action and opens the publish flow", () => {
	const onClick = vi.fn();
	render(<PublishButton onClick={onClick} />);
	const button = screen.getByRole("button", { name: "Publish" });
	expect(button.textContent).toContain("Publish");
	fireEvent.click(button);
	expect(onClick).toHaveBeenCalledOnce();
});
