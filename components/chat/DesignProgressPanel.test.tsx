// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DesignProgressView } from "@/lib/session/designProgressStore";
import { DesignProgressStatus, planWorkflowRows } from "./DesignProgressPanel";

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
				}}
			/>,
		);

		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Use what’s built" }),
		).toBeNull();
	});
});

describe("planWorkflowRows", () => {
	const names = (n: number) =>
		Array.from({ length: n }, (_, i) => `Workflow ${i + 1}`);

	it("shows five or fewer workflows in full, no byline", () => {
		const { rows, byline } = planWorkflowRows({
			plannedSliceNames: names(5),
			currentSliceName: "Workflow 2",
			committedSliceNames: ["Workflow 1"],
		});
		expect(rows.map((r) => r.status)).toEqual([
			"built",
			"building",
			"waiting",
			"waiting",
			"waiting",
		]);
		expect(byline).toBeNull();
	});

	it("compacts past five: the one being built leads, waiting fills to five, the rest are counted", () => {
		const { rows, byline } = planWorkflowRows({
			plannedSliceNames: names(9),
			currentSliceName: "Workflow 5",
			committedSliceNames: names(4),
		});
		expect(rows.map((r) => r.name)).toEqual([
			"Workflow 5",
			"Workflow 6",
			"Workflow 7",
			"Workflow 8",
			"Workflow 9",
		]);
		expect(rows[0]?.status).toBe("building");
		expect(byline).toBe("4 completed");
	});

	it("counts hidden pending workflows in the byline", () => {
		const { rows, byline } = planWorkflowRows({
			plannedSliceNames: names(12),
			currentSliceName: "Workflow 2",
			committedSliceNames: ["Workflow 1"],
		});
		expect(rows).toHaveLength(5);
		expect(rows[0]).toEqual({ name: "Workflow 2", status: "building" });
		expect(byline).toBe("6 pending · 1 completed");
	});

	it("shows the next five waiting when nothing is mid-build", () => {
		const { rows, byline } = planWorkflowRows({
			plannedSliceNames: names(8),
			currentSliceName: null,
			committedSliceNames: names(2),
		});
		expect(rows.map((r) => r.name)).toEqual([
			"Workflow 3",
			"Workflow 4",
			"Workflow 5",
			"Workflow 6",
			"Workflow 7",
		]);
		expect(byline).toBe("1 pending · 2 completed");
	});

	it("keeps only the current row once everything else is built", () => {
		const { rows, byline } = planWorkflowRows({
			plannedSliceNames: names(7),
			currentSliceName: "Workflow 7",
			committedSliceNames: names(6),
		});
		expect(rows).toEqual([{ name: "Workflow 7", status: "building" }]);
		expect(byline).toBe("6 completed");
	});
});
