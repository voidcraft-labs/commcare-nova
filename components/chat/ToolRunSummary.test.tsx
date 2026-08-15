// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import type { ToolUIPart } from "ai";
import { describe, expect, it } from "vitest";
import { ToolRunSummary } from "./ToolRunSummary";

const pendingPart = {
	type: "tool-addFields",
	toolCallId: "call-1",
	state: "input-available",
	input: {},
} as ToolUIPart;

describe("ToolRunSummary", () => {
	it("keeps in-flight call glyphs still while the activity row owns motion", () => {
		const { container } = render(<ToolRunSummary parts={[pendingPart]} />);

		expect(screen.getByText("Adding fields")).toBeDefined();
		expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
		expect(container.querySelector("svg")?.getAttribute("class")).not.toContain(
			"animate-spin",
		);
	});
});
