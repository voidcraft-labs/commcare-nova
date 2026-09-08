import "server-only";

import {
	type AnatomyRoleId,
	COMPOSITIONS,
	ROLE_FACTS,
	type RoleFacts,
	weigh,
} from "@/lib/agent/anatomy";

export interface RoleSummary {
	readonly facts: RoleFacts;
	/** Estimated static tokens: system prompt, tools, output schema, at the
	 * role's first moment with no inputs. */
	readonly staticTokens: number | null;
	readonly systemTokens: number | null;
	readonly toolCount: number;
	readonly toolTokens: number | null;
	readonly momentCount: number;
}

/** The map's per-role numbers, composed from each role's first moment. */
export async function summarizeRole(role: AnatomyRoleId): Promise<RoleSummary> {
	const composition = COMPOSITIONS[role];
	const first = composition.moments[0];
	if (first === undefined) {
		throw new Error(`The ${role} composition declares no moments.`);
	}
	const weighed = await weigh(await composition.compose(first.id, {}));
	const system = weighed.items.find((item) => item.kind === "system");
	const tools = weighed.items.find((item) => item.kind === "tools");
	return {
		facts: ROLE_FACTS[role],
		staticTokens: weighed.bands.static.tokens,
		systemTokens: system?.weight.tokens ?? null,
		toolCount: tools?.kind === "tools" ? tools.tools.length : 0,
		toolTokens: tools?.weight.tokens ?? null,
		momentCount: composition.moments.length,
	};
}
