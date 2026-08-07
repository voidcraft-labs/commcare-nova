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
 *     canonical surface can reach.
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
import {
	CHANGE_SET_STAGE_TOOLS,
	type StagedHandleDeclaration,
} from "./stageTools";

export interface ChangeSetToolEntry {
	readonly name: string;
	readonly tool: SharedToolModule;
	readonly policy: ToolExecutionPolicy;
	/** Which RAW input slots declare new handles — executor-only staging
	 * tools; shared tools only reference. */
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

/**
 * Staging-classified tools whose BODIES are not yet overlay-native: they
 * read the authoritative persisted app/organization snapshot from Postgres
 * (`readOrganizationAuthoringSnapshot` → `loadAppInTransaction`) instead of
 * `ctx.snapshot.doc`, and `updateAutomation`'s zero-diff arm additionally
 * proves its no-op through `adoptAuthoritativeSnapshot` — meaningless over a
 * private overlay. Admitting them would make staged private state invisible
 * to an executor's own read-backs (a re-stage loop, or duplicate rows at
 * commit). They stay canonical-only until the executor unit makes their
 * bodies overlay-native; their REVIEWED staging classification in
 * `sharedToolRegistry.ts` is unchanged — this is a runtime-readiness fence,
 * not a policy reversal.
 */
const NOT_YET_OVERLAY_NATIVE = new Set([
	"getAutomations",
	"getOrganization",
	"updateAutomation",
]);

function buildRegistry(): ReadonlyMap<string, ChangeSetToolEntry> {
	const entries = new Map<string, ChangeSetToolEntry>();
	for (const entry of SHARED_TOOL_REGISTRY) {
		if (entry.policy.staging === "forbidden") continue;
		if (NOT_YET_OVERLAY_NATIVE.has(entry.saName)) continue;
		entries.set(entry.saName, {
			name: entry.saName,
			tool: entry.tool,
			policy: entry.policy,
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
