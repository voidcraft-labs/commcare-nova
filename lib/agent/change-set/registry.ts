/**
 * The change-set tool registry — which tools a private staging workspace may
 * dispatch, with what policy.
 *
 * It contains every SHARED registry entry whose reviewed private-workspace
 * classification is not `forbidden` (`lib/agent/sharedToolRegistry.ts` — the
 * policy test pins each classification), keyed by its SA name. Every shared
 * tool body reads `ctx.snapshot.doc`, so a dispatch sees the private
 * workspace's own current state.
 *
 * External-effect tools are structurally absent: they never enter this map,
 * so a change-set workspace cannot dispatch them — the policy fence is a
 * registry shape, not a runtime opinion.
 */

import {
	SHARED_TOOL_REGISTRY,
	type ToolExecutionPolicy,
} from "@/lib/agent/sharedToolRegistry";
import type { SharedToolModule } from "@/lib/mcp/adapters/sharedToolAdapter";
import { sharedHandleDeclarer } from "./handleDeclarations";
import type { StagedHandleDeclaration } from "./handles";

export interface ChangeSetToolEntry {
	readonly name: string;
	readonly tool: SharedToolModule;
	readonly policy: ToolExecutionPolicy;
	/** Which RAW creation identity slots declare new handles. */
	readonly declaredHandles?: (
		input: unknown,
	) => readonly StagedHandleDeclaration[];
}

function buildRegistry(): ReadonlyMap<string, ChangeSetToolEntry> {
	const entries = new Map<string, ChangeSetToolEntry>();
	for (const entry of SHARED_TOOL_REGISTRY) {
		if (entry.policy.staging === "forbidden") continue;
		const declaredHandles = sharedHandleDeclarer(entry.saName);
		entries.set(entry.saName, {
			name: entry.saName,
			tool: entry.tool,
			policy: entry.policy,
			...(declaredHandles !== undefined && { declaredHandles }),
		});
	}
	return entries;
}

export const CHANGE_SET_TOOL_REGISTRY: ReadonlyMap<string, ChangeSetToolEntry> =
	buildRegistry();

export function changeSetToolEntry(
	name: string,
): ChangeSetToolEntry | undefined {
	return CHANGE_SET_TOOL_REGISTRY.get(name);
}
