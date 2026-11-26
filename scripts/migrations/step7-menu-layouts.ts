import type { BlueprintDoc, Uuid } from "@/lib/domain";

export interface MenuLayoutDecision {
	readonly appId: string;
	readonly projectId: string;
	readonly settings: {
		readonly firstMenuLayout?: "grid";
		readonly formMenuLayout?: "grid" | "individual";
	};
	readonly gridMenus: readonly Uuid[];
}

type Snapshot = Pick<BlueprintDoc, "appId" | "appSettings" | "modules">;

/**
 * Apply verified layout choices to each version of the same app at the fold.
 * A menu may be absent from a historical version. Later versions of the
 * snapshot may already hold a choice. The released parser keeps evidence
 * about each target separately from these app-wide defaults.
 */
export function convertMenuLayouts<T extends Snapshot>(
	snapshot: T,
	decisions: readonly MenuLayoutDecision[],
	coordinate: { appId: string; projectId: string; purpose?: string },
): T {
	if (snapshot.appId !== coordinate.appId || !coordinate.projectId)
		throw new Error(
			"Menu layout conversion requires the owning app and Project.",
		);
	if (coordinate.purpose === "private-genesis") return snapshot;

	const matching = decisions.filter(({ appId }) => appId === coordinate.appId);
	if (matching.length > 1)
		throw new Error(
			"The frozen menu layout has more than one decision for this app.",
		);
	const [decision] = matching;
	if (!decision) return snapshot;
	if (decision.projectId !== coordinate.projectId)
		throw new Error("The retained menu layout belongs to a different Project.");
	const settings = { ...decision.settings, ...snapshot.appSettings };
	let modules = snapshot.modules;
	for (const uuid of decision.gridMenus) {
		if (!Object.hasOwn(modules, uuid)) continue;
		const module = modules[uuid];
		if (module.menuLayout !== undefined) continue;
		if (modules === snapshot.modules) modules = { ...modules };
		modules[uuid] = { ...module, menuLayout: "grid" };
	}
	return { ...snapshot, appSettings: settings, modules };
}
