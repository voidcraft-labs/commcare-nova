// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	ChatActivityStatus,
	deriveChatActivity,
} from "@/components/chat/ChatActivityStatus";
import { BuilderPhase } from "@/lib/session/builderTypes";
import { GenerationStage } from "@/lib/session/types";

const resting = {
	agentError: null,
	agentStage: null,
	attachmentReading: false,
	isGenerating: false,
	phase: BuilderPhase.Ready,
	postBuildEdit: false,
	streamOpen: false,
	submittedLocally: false,
} as const;

describe("deriveChatActivity", () => {
	it("removes status chrome while the builder is resting", () => {
		expect(deriveChatActivity(resting)).toEqual({ state: "idle", label: "" });
	});

	it.each([
		[GenerationStage.Foundation, "Setting up your app"],
		[GenerationStage.Build, "Building your app"],
		[GenerationStage.Fix, "Finishing your app"],
		[null, "Building your app"],
	] as const)("describes the %s build stage in plain language", (stage, label) => {
		expect(
			deriveChatActivity({
				...resting,
				agentStage: stage,
				isGenerating: true,
				phase: BuilderPhase.Generating,
			}),
		).toEqual({ state: "progress", label });
	});

	it("prioritizes recovery and fatal errors over build progress", () => {
		expect(
			deriveChatActivity({
				...resting,
				agentError: { message: "Retrying", severity: "recovering" },
				agentStage: GenerationStage.Build,
				isGenerating: true,
				phase: BuilderPhase.Generating,
			}),
		).toEqual({ state: "recovering", label: "Trying again" });

		expect(
			deriveChatActivity({
				...resting,
				agentError: { message: "Stopped", severity: "failed" },
				postBuildEdit: true,
			}),
		).toEqual({ state: "error", label: "Couldn't update your app" });
	});

	it("keeps completion ahead of a still-closing response stream", () => {
		expect(
			deriveChatActivity({
				...resting,
				phase: BuilderPhase.Completed,
				postBuildEdit: true,
				streamOpen: true,
			}),
		).toEqual({ state: "complete", label: "Your app is updated" });
	});

	it("distinguishes a local send from a resumed stream", () => {
		expect(
			deriveChatActivity({
				...resting,
				streamOpen: true,
				submittedLocally: true,
			}),
		).toEqual({ state: "progress", label: "Sending message" });

		expect(
			deriveChatActivity({
				...resting,
				postBuildEdit: true,
				streamOpen: true,
			}),
		).toEqual({ state: "progress", label: "Updating your app" });
	});

	it("names document reading before generic transport activity", () => {
		expect(
			deriveChatActivity({
				...resting,
				attachmentReading: true,
				streamOpen: true,
			}),
		).toEqual({ state: "progress", label: "Reading your documents" });
	});
});

describe("ChatActivityStatus", () => {
	it("renders nothing for an idle state", () => {
		const { container } = render(<ChatActivityStatus state="idle" label="" />);
		expect(container.childElementCount).toBe(0);
	});

	it("announces progress politely in one compact row", () => {
		render(<ChatActivityStatus state="progress" label="Building your app" />);
		const status = screen.getByRole("status");
		expect(status.getAttribute("aria-live")).toBe("polite");
		expect(status.getAttribute("data-chat-activity-status")).toBe("progress");
		expect(status.className).toContain("min-h-10");
		expect(status.textContent).toContain("Building your app");
	});

	it("announces a fatal outcome immediately", () => {
		render(
			<ChatActivityStatus state="error" label="Couldn't build your app" />,
		);
		const alert = screen.getByRole("alert");
		expect(alert.getAttribute("aria-live")).toBe("assertive");
		expect(alert.textContent).toContain("Couldn't build your app");
	});
});
