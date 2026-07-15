// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GenerationStage } from "@/lib/session/types";
import {
	GenerationProgressCard,
	generationProgressPercent,
} from "../GenerationProgress";

describe("GenerationProgressCard", () => {
	it("aligns progress with phase anchors spanning the full-width track", () => {
		expect(generationProgressPercent(GenerationStage.Foundation, 3)).toBe(0);
		expect(generationProgressPercent(GenerationStage.Build, 3)).toBe(50);
		expect(generationProgressPercent(GenerationStage.Fix, 4)).toBeCloseTo(
			200 / 3,
		);
	});

	it("renders the current two milestones plus Done", () => {
		const { container } = render(
			<GenerationProgressCard
				stage={GenerationStage.Foundation}
				generationError={null}
				statusMessage=""
			/>,
		);

		expect(screen.getByText("Set Up")).toBeTruthy();
		expect(screen.getByText("Build")).toBeTruthy();
		expect(screen.getByText("Done")).toBeTruthy();
		expect(screen.queryByText("Fix")).toBeNull();
		expect(
			container.querySelectorAll("[data-progress-connector]"),
		).toHaveLength(2);
		expect(
			Number(
				screen
					.getByRole("progressbar", { name: "App generation progress" })
					.getAttribute("aria-valuenow"),
			),
		).toBe(0);
		expect(
			screen
				.getByText("Set Up")
				.closest("[data-stage]")
				?.getAttribute("data-status"),
		).toBe("active");
		expect(
			screen
				.getByText("Build")
				.closest("[data-stage]")
				?.getAttribute("data-status"),
		).toBe("pending");
	});

	it("marks completed and active milestone indicators independently", () => {
		render(
			<GenerationProgressCard
				stage={GenerationStage.Build}
				generationError={null}
				statusMessage=""
			/>,
		);

		expect(
			screen
				.getByText("Set Up")
				.closest("[data-stage]")
				?.getAttribute("data-status"),
		).toBe("done");
		expect(
			screen
				.getByText("Build")
				.closest("[data-stage]")
				?.getAttribute("data-status"),
		).toBe("active");
	});

	it("renders a historical Fix error as a fourth visible position", () => {
		const { container } = render(
			<GenerationProgressCard
				stage={GenerationStage.Fix}
				generationError={{
					message: "Could not repair app",
					severity: "failed",
				}}
				statusMessage="Could not repair app"
			/>,
		);

		expect(screen.getByText("Fix")).toBeTruthy();
		expect(
			screen
				.getByText("Fix")
				.closest("[data-stage]")
				?.getAttribute("data-status"),
		).toBe("error");
		expect(
			container.querySelectorAll("[data-progress-connector]"),
		).toHaveLength(3);
		expect(
			Number(
				screen
					.getByRole("progressbar", { name: "App generation progress" })
					.getAttribute("aria-valuenow"),
			),
		).toBeCloseTo(200 / 3);
		expect(screen.getByText("Could not repair app")).toBeTruthy();
	});

	it("keeps the error height region mounted while it collapses after recovery", () => {
		const { container, rerender } = render(
			<GenerationProgressCard
				stage={GenerationStage.Build}
				generationError={{ message: "Build failed", severity: "failed" }}
				statusMessage="Build failed"
			/>,
		);
		const errorRegion = container.querySelector(
			"[data-generation-error-region]",
		);
		expect(errorRegion?.getAttribute("aria-hidden")).toBe("false");

		rerender(
			<GenerationProgressCard
				stage={GenerationStage.Fix}
				generationError={null}
				statusMessage=""
			/>,
		);

		expect(container.querySelector("[data-generation-error-region]")).toBe(
			errorRegion,
		);
		expect(errorRegion?.getAttribute("aria-hidden")).toBe("true");
	});
});
