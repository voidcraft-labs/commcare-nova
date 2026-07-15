// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GenerationStage } from "@/lib/session/types";
import {
	GenerationProgressCard,
	generationProgressPercent,
} from "../GenerationProgress";

describe("GenerationProgressCard", () => {
	it("uses every visible position, including Done, as its denominator", () => {
		expect(
			generationProgressPercent(GenerationStage.Foundation, 3),
		).toBeCloseTo(100 / 3);
		expect(generationProgressPercent(GenerationStage.Build, 3)).toBeCloseTo(
			200 / 3,
		);
		expect(generationProgressPercent(GenerationStage.Fix, 4)).toBe(75);
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
		).toBeCloseTo(100 / 3);
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
			screen
				.getByRole("progressbar", { name: "App generation progress" })
				.getAttribute("aria-valuenow"),
		).toBe("75");
		expect(screen.getByText("Could not repair app")).toBeTruthy();
	});
});
