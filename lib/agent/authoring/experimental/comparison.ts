import type { OpenAIProvider, OpenAIToolOptions } from "@ai-sdk/openai";
import type { ToolSet } from "ai";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import { solutionsArchitectToolDefinitions } from "@/lib/agent/solutionsArchitect";
import type { CanonicalMutationWorkspace } from "@/lib/agent/workspace/canonicalWorkspace";
import { canonicalJsonText } from "@/lib/utils/canonicalJsonText";
import { nativePilotTools } from "./native";

/** The baseline sends the current production grammar unchanged. Only operations
 * on the disposable app may execute; Project resources are outside this trial.
 * This measures an edit task, not the separate design/build orchestration. */
export function currentPilotTools(
	workspace: CanonicalMutationWorkspace,
): ToolSet {
	return Object.fromEntries(
		Object.entries(solutionsArchitectToolDefinitions()).map(
			([name, definition]) => [
				name,
				{
					...definition,
					execute: async (input: unknown, options: { toolCallId: string }) => {
						const entry = SHARED_TOOL_REGISTRY.find(
							(entry) => entry.saName === name,
						);
						if (
							!entry ||
							entry.policy.readSets.length ||
							entry.policy.capabilities.some(
								(capability) =>
									![
										"canonical-blueprint-write",
										"case-store-migration",
									].includes(capability),
							)
						)
							return {
								error:
									"This local comparison can only read or edit its disposable app.",
							};
						return workspace.invoke({
							toolName: name,
							requestId: options.toolCallId,
							execute: async (ctx) => {
								const outcome = await entry.tool.execute(
									entry.tool.inputSchema.parse(input) as never,
									ctx,
								);
								return outcome.kind === "read" ? outcome.data : outcome.result;
							},
						});
					},
				},
			],
		),
	);
}

/** The provider owns the JavaScript sandbox. Nova still owns validation,
 * authorization, ordering and commit. This trial has no restart/resume path. */
export function programmaticPilotTools(
	workspace: CanonicalMutationWorkspace,
	provider: OpenAIProvider,
): ToolSet {
	return {
		program: provider.tools.programmaticToolCalling(),
		...Object.fromEntries(
			Object.entries(nativePilotTools(workspace)).map(([name, definition]) => [
				name,
				{
					...definition,
					providerOptions: {
						openai: {
							allowedCallers: ["programmatic"],
						} satisfies OpenAIToolOptions,
					},
				},
			]),
		),
	};
}

/** Repeated delivery of one call reuses its outcome in this process. Retain
 * failures too: an unknown commit outcome must never trigger a blind retry.
 * Production recovery needs the existing durable call ledger, not this map. */
export function deduplicatePilotCalls<TOOLS extends ToolSet>(
	tools: TOOLS,
): TOOLS {
	const calls = new Map<string, { signature: string; result: unknown }>();
	return Object.fromEntries(
		Object.entries(tools).map(([name, definition]) => {
			const execute = definition.execute;
			if (!execute) return [name, definition];
			return [
				name,
				{
					...definition,
					execute: (input, options) => {
						const signature = canonicalJsonText({ name, input });
						const previous = calls.get(options.toolCallId);
						if (previous) {
							if (previous.signature !== signature)
								throw new Error("A repeated tool call changed its input.");
							return previous.result;
						}
						const result = Promise.resolve().then(() =>
							execute(input, options),
						);
						calls.set(options.toolCallId, { signature, result });
						return result;
					},
				} satisfies ToolSet[string],
			];
		}),
	) as TOOLS;
}
