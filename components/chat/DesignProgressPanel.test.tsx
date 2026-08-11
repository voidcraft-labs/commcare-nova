// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
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
};

describe("DesignProgressStatus", () => {
	it("uses the same composer-column gutter as other live status rows", () => {
		render(<DesignProgressStatus view={view} />);

		const status = screen.getByRole("status");
		expect(status.classList.contains("px-4")).toBe(true);
		expect(status.classList.contains("py-2")).toBe(true);
		expect(status.textContent).toContain("Designing your app");
	});

	it("does not turn a deterministic build stop into a user retry", () => {
		render(
			<DesignProgressStatus
				view={{
					...view,
					stage: "incomplete",
					stageLabel: "Stopped before it finished",
					working: false,
					failure: "Nothing invalid was saved.",
				}}
				canRecover
			/>,
		);

		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
	});

	it("offers one explicit continuation for a saved pre-app candidate", () => {
		const onContinue = vi.fn();
		render(
			<DesignProgressStatus
				view={{
					...view,
					stage: "incomplete",
					stageLabel: "Stopped before it finished",
					working: false,
					failure: "Your saved design can continue.",
				}}
				canRecover
				onContinue={onContinue}
			/>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Continue build" }));
		expect(onContinue).toHaveBeenCalledOnce();
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
				}}
			/>,
		);

		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Use what’s built" }),
		).toBeNull();
	});
});
