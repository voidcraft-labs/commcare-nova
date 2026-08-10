// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DesignProgressView } from "@/lib/session/designProgressStore";
import { DesignProgressStatus } from "./DesignProgressPanel";

vi.mock("@/app/(app)/build/actions", () => ({
	acceptPartialBuild: vi.fn(),
}));

const view: DesignProgressView = {
	active: true,
	designSessionId: "11111111-1111-4111-8111-111111111111",
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
	canRetryPlan: false,
};

describe("DesignProgressStatus", () => {
	it("uses the same composer-column gutter as other live status rows", () => {
		render(<DesignProgressStatus view={view} />);

		const status = screen.getByRole("status");
		expect(status.classList.contains("px-4")).toBe(true);
		expect(status.classList.contains("py-2")).toBe(true);
		expect(status.textContent).toContain("Designing your app");
	});

	it("offers an explicit re-drive for a recoverable stop", () => {
		const onRetry = vi.fn();
		render(
			<DesignProgressStatus
				view={{
					...view,
					stage: "incomplete",
					stageLabel: "Stopped before it finished",
					working: false,
					failure: "Nothing invalid was saved.",
					canRetryPlan: true,
				}}
				canRecover
				onRetry={onRetry}
			/>,
		);

		screen.getByRole("button", { name: "Try again" }).click();
		expect(onRetry).toHaveBeenCalledOnce();
	});

	it("does not offer exact-plan retry for a design failure", () => {
		render(
			<DesignProgressStatus
				view={{
					...view,
					stage: "incomplete",
					stageLabel: "Stopped before it finished",
					working: false,
					failure: "The design needs another decision.",
				}}
				canRecover
				onRetry={vi.fn()}
			/>,
		);

		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
	});

	it("hides all recovery actions from viewers", () => {
		render(
			<DesignProgressStatus
				view={{
					...view,
					stage: "incomplete",
					stageLabel: "Stopped before it finished",
					working: false,
					materialized: true,
					committedSliceNames: ["Register a household"],
					failure: "The build stopped.",
					canRetryPlan: true,
				}}
				onRetry={vi.fn()}
			/>,
		);

		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Use what’s built" }),
		).toBeNull();
	});
});
