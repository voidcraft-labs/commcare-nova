/**
 * The change-set tool registry — which tools a private staging workspace may
 * dispatch, with what policy.
 *
 * Two sources, one closed map:
 *
 *   - every SHARED registry entry whose reviewed staging classification is
 *     not `forbidden` (`lib/agent/sharedToolRegistry.ts` — the policy test
 *     pins each classification), keyed by its SA name;
 *   - the executor-only granular staging tools (`stageTools.ts`), which no
 *     canonical surface can reach — the ones that create deliberately
 *     INCOMPLETE private structure, and nothing else. Every shared tool's
 *     body reads `ctx.snapshot.doc`, so an overlay's own staged state is
 *     what a change-set dispatch of it sees.
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
import { CHANGE_SET_STAGE_TOOLS } from "./stageTools";

export interface ChangeSetToolEntry {
	readonly name: string;
	readonly tool: SharedToolModule;
	readonly policy: ToolExecutionPolicy;
	/** Which RAW creation identity slots declare new handles. */
	readonly declaredHandles?: (
		input: unknown,
	) => readonly StagedHandleDeclaration[];
}

const STAGE_TOOL_POLICY: ToolExecutionPolicy = {
	effect: "mutate-blueprint",
	staging: "allowed",
	readSets: [],
	capabilities: ["change-set-stage"],
};

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
	for (const stage of CHANGE_SET_STAGE_TOOLS) {
		if (entries.has(stage.name)) {
			throw new Error(
				`Change-set stage tool ${stage.name} collides with a shared tool name.`,
			);
		}
		entries.set(stage.name, {
			name: stage.name,
			tool: stage.tool as unknown as SharedToolModule,
			policy: STAGE_TOOL_POLICY,
			declaredHandles: (input) => stage.tool.declaredHandles(input),
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
