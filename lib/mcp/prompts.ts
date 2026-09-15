/** Stable MCP role guidance. App state is read separately through get_app. */
import type { PromptSegment } from "@/lib/agent/promptSegments";
import {
	buildMcpAgentBuildPrompt,
	buildSolutionsArchitectPrompt,
} from "@/lib/agent/prompts";

export const PROMPT_MODES = ["build", "autonomous_build", "edit"] as const;
export type PromptMode = (typeof PROMPT_MODES)[number];
export const PROMPT_END_MARKER = "NOVA-PROMPT-END";

export const INTERACTIVITY_INSTRUCTIONS = {
	interactive:
		"AskUserQuestion is available when an answer would materially change the app.",
	autonomous:
		"The user is away. Make reasonable choices within their request and report consequential assumptions when you finish. AskUserQuestion is unavailable.",
} as const;

export function agentPromptSegments(
	mode: PromptMode,
): readonly PromptSegment[] {
	const edit = mode === "edit";
	return [
		{
			id: edit ? "architect" : "build",
			title: edit ? "Editing an app" : "Building an app",
			text: edit ? buildSolutionsArchitectPrompt() : buildMcpAgentBuildPrompt(),
		},
		{
			id: "interaction-mode",
			title: "Working with the user",
			text: INTERACTIVITY_INSTRUCTIONS[
				mode === "autonomous_build" ? "autonomous" : "interactive"
			],
		},
		{
			id: "reference",
			title: "Current guidance and app state",
			text: "Discover tools for the work at hand. Read get_app for an overview of an existing app, then inspect the forms or modules you need. get_authoring_guide provides focused reference material when a feature or expression is unfamiliar.",
		},
		{ id: "end-marker", title: "Delivery marker", text: PROMPT_END_MARKER },
	];
}

export function renderAgentPrompt(mode: PromptMode): string {
	return agentPromptSegments(mode)
		.map((segment) => segment.text)
		.join("\n\n");
}
