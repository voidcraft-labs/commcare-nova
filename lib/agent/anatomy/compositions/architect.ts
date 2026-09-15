import { architectToolDefinitions } from "@/lib/agent/build/authoringTools";
import {
	ARCHITECT_BUILD_SEGMENTS,
	ARCHITECT_PEER_SEGMENTS,
	buildArchitectPeerPrompt,
	buildArchitectPrompt,
} from "@/lib/agent/prompts";
import type { ContextItem, MomentSpec, RoleComposition } from "../types";
import { newestContext, recordedItemsOf } from "./recordedItems";
import {
	missingItem,
	moment,
	segmentViews,
	specById,
	systemItem,
	toolsItem,
	toolViews,
} from "./shared";

const source = {
	file: "lib/agent/build/orchestrator.ts",
	symbol: "runBuildOrchestration",
};
const prompts = "lib/agent/prompts.ts";
function composition(role: "architect" | "peer"): RoleComposition {
	const moments: readonly MomentSpec[] = (
		role === "architect"
			? ["planning", "building", "recorded"]
			: ["review", "recorded"]
	).map((id) => ({
		id,
		label:
			id === "recorded"
				? "Recorded conversation"
				: id === "building"
					? "Building"
					: id === "review"
						? "Independent review"
						: "Planning",
		why:
			id === "recorded"
				? "Actual persisted messages alongside today's prompt and tool catalog. Recorded usage belongs to the original calls."
				: "The current production prompt and complete tool catalog for this phase. Deferred definitions are counted separately from initially loaded definitions.",
		needs: id === "recorded" ? ["design-session"] : [],
		source,
	}));
	return {
		role,
		moments,
		async compose(momentId, inputs) {
			const spec = specById(moments, momentId, role);
			const building = role === "architect" && momentId !== "planning";
			const items: ContextItem[] = [
				systemItem({
					text:
						role === "architect"
							? buildArchitectPrompt()
							: buildArchitectPeerPrompt(),
					segments: segmentViews(
						role === "architect"
							? ARCHITECT_BUILD_SEGMENTS
							: ARCHITECT_PEER_SEGMENTS,
						prompts,
						role === "architect"
							? "ARCHITECT_BUILD_SEGMENTS"
							: "ARCHITECT_PEER_SEGMENTS",
					),
					source: {
						file: prompts,
						symbol:
							role === "architect"
								? "buildArchitectPrompt"
								: "buildArchitectPeerPrompt",
					},
					note: "Current code. A recorded run may have used a different prompt version.",
				}),
				toolsItem({
					tools: await toolViews(
						architectToolDefinitions({
							role,
							building,
							hasApp: building || inputs.app !== undefined,
						}),
					),
					source: {
						file: "lib/agent/build/authoringTools.ts",
						symbol: "architectToolDefinitions",
					},
					note:
						momentId === "recorded" && role === "architect"
							? "Today's full construction catalog, including deferred and post-birth tools. Original loaded definitions may differ; this catalog is not a reconstruction of the recorded request."
							: "Complete current catalog for this phase, including deferred definitions.",
				}),
			];
			const recorded =
				momentId === "recorded" && inputs.session
					? newestContext(inputs.session.contexts, role)
					: undefined;
			if (recorded) items.push(...recordedItemsOf(recorded));
			else
				items.push(
					missingItem({
						id: "conversation",
						label: "Conversation",
						needs: "design-session",
						source,
						explanation:
							"Requests, source material, plan edits, tool results and peer feedback depend on the session. Select a recorded run to inspect them.",
					}),
				);
			return moment(spec, items);
		},
	};
}
export const architectComposition = composition("architect");
export const peerComposition = composition("peer");
