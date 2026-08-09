// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DesignProgressView } from "@/lib/session/designProgressStore";
import { DesignProgressStatus } from "./DesignProgressPanel";

const view: DesignProgressView = {
	active: true,
	stage: "designing",
	stageLabel: "Designing your app",
	working: true,
	pulseStep: null,
	outline: null,
	plannedSliceNames: [],
	sliceProgress: null,
	currentSliceName: null,
	committedSliceNames: [],
	materialized: false,
	failure: null,
};

describe("DesignProgressStatus", () => {
	it("uses the same composer-column gutter as other live status rows", () => {
		render(<DesignProgressStatus view={view} />);

		const status = screen.getByRole("status");
		expect(status.classList.contains("px-4")).toBe(true);
		expect(status.classList.contains("py-2")).toBe(true);
		expect(status.textContent).toContain("Designing your app");
	});
});
