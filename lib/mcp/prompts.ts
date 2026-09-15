/** Server-owned guidance for MCP architects. Build and edit modes share Nova's
 * role guidance; edit mode adds the authorized app snapshot. The plugin owns
 * client tool access and delegates current authoring guidance to this renderer.
 */

import type { PromptSegment } from "@/lib/agent/promptSegments";
import {
	buildMcpAgentBuildPrompt,
	buildSolutionsArchitectPrompt,
	isEditableDoc,
} from "@/lib/agent/prompts";
import { summarizeBlueprint } from "@/lib/agent/summarizeBlueprint";
import type { BlueprintDoc } from "@/lib/domain";

/** Supported plugin workflows. The autonomous client cannot ask questions. */
export type PromptMode = "build" | "autonomous_build" | "edit";

/**
 * Terminal marker on every rendered prompt — the proof-of-delivery the
 * plugin's bootstrap checks before it builds anything.
 *
 * The prompt reaches its executor as an MCP *tool result*, and tool
 * results can be size-capped by rules the server can't observe. The marker
 * makes a short delivery loud: the bootstrap refuses to build without it
 * rather than silently running on a fraction of its instructions.
 *
 * Anything appended after this constant is invisible to that check, so
 * it stays last in `renderAgentPrompt` — including after the edit-mode
 * app-state block.
 */
export const PROMPT_END_MARKER = "NOVA-PROMPT-END";

/**
 * Per-mode interaction-policy text appended to the system prompt. Both
 * blocks lead with `\n\n` so the `## Interaction Mode` heading lands
 * after a blank line (markdown idiom); `buildSolutionsArchitectPrompt`'s
 * trailing section already terminates without a blank, so this composes
 * cleanly into a sequence of well-separated sections regardless of
 * which prompt body precedes it.
 *
 * The autonomous block states the contract in-prompt AND relies on the
 * plugin's `disallowedTools` frontmatter for hard enforcement: the
 * prompt-level reminder keeps the model from spending a turn
 * discovering the missing tool, while the tool-allowlist gate is what
 * Claude Code physically enforces.
 */
export const INTERACTIVITY_INSTRUCTIONS = {
	interactive: `

## Interaction Mode

You may use the AskUserQuestion tool when a design choice is genuinely
ambiguous and the answer would materially change the build. Do not ask
for permission to proceed; do not ask multiple questions at once; do not
ask things you can reasonably default on. Ask at most a handful of
questions per build. The user sees your question in their main session
and answers it, then you resume.`,
	autonomous: `

## Interaction Mode

You run without user interaction. Commit to a reasonable default for
every ambiguous design choice and report your decisions in the final
summary. Do NOT attempt to ask the user questions, the AskUserQuestion
tool is not available to you in this mode.`,
} as const;

/** Build mode uses direct shared MCP tools. Edit mode includes a fresh authorized
 * snapshot. The delivery marker follows every segment, including app state. */
export function renderAgentPrompt(
	interactive: boolean,
	editDoc?: BlueprintDoc,
): string {
	return agentPromptSegments(interactive, editDoc)
		.map((segment) => segment.text)
		.join("");
}

/**
 * The boot prompt as its ordered pieces; `renderAgentPrompt` is exactly
 * their concatenation (each piece carries its own leading blank lines, so
 * there is no separator). Named so the agent-anatomy page reads the same
 * list the tool result is rendered from.
 */
export function agentPromptSegments(
	interactive: boolean,
	editDoc?: BlueprintDoc,
): readonly PromptSegment[] {
	/* Edit mode boots the SA's edit prompt; build mode boots the MCP-only
	 * build composition — the plugin's client-side agent drives direct
	 * canonical tools (`create_app` + the shared set), which remain an
	 * immediate, unreviewed surface (the chat design pipeline never runs
	 * here). */
	const editable = isEditableDoc(editDoc);
	/* `PROMPT_END_MARKER` is last by contract — it proves the executor
	 * received the whole text, so anything after it would be outside
	 * what the check covers. The app-state block precedes it for the
	 * same reason it exists at all: it is the largest and most
	 * app-specific section, so it is the first thing a truncated
	 * delivery loses, and the marker is what turns that loss into a
	 * refusal instead of a quietly worse app. */
	return [
		editable
			? {
					id: "architect",
					title: "The architect's edit prompt",
					text: buildSolutionsArchitectPrompt(),
				}
			: {
					id: "build",
					title: "The MCP build prompt",
					text: buildMcpAgentBuildPrompt(),
				},
		{
			id: "interaction-mode",
			title: "Interaction mode",
			text: interactive
				? INTERACTIVITY_INSTRUCTIONS.interactive
				: INTERACTIVITY_INSTRUCTIONS.autonomous,
		},
		...(editable
			? [
					{
						id: "app-state",
						title: "Current app state",
						text: appStateBlockFor(editDoc),
						generated: ["summarizeBlueprint"],
					},
				]
			: []),
		{
			id: "end-marker",
			title: "Delivery marker",
			text: `\n\n${PROMPT_END_MARKER}`,
		},
	];
}

/**
 * The complete edit-mode "Current app state" block. The terminal marker
 * remains the delivery proof for the whole rendered prompt.
 */
function appStateBlockFor(doc: BlueprintDoc): string {
	const summary = summarizeBlueprint(doc);
	return `\n\n---\n\n## Current app state\n\n${summary}`;
}
