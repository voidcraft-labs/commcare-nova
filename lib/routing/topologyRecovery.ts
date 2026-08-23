import type { Module, Uuid } from "@/lib/domain";
import { serializePath } from "@/lib/routing/location";
import type { Location } from "@/lib/routing/types";

export interface PreviousLocationTopology {
	readonly location: Location;
	readonly modules: Readonly<Record<Uuid, Module>>;
}

function moduleUuidAt(location: Location): Uuid | undefined {
	return "moduleUuid" in location ? location.moduleUuid : undefined;
}

/** A parser cannot derive ancestry after the selected child disappears. This
 * bounded previous-snapshot fallback runs only when the browser path is still
 * the exact path for the prior valid location, so intentional navigation never
 * gets mistaken for remote deletion. */
export function formerParentRecovery(
	segments: readonly string[],
	previous: PreviousLocationTopology | undefined,
	currentModules: Readonly<Record<Uuid, Module>>,
): Location | undefined {
	if (previous === undefined) return undefined;
	const previousModuleUuid = moduleUuidAt(previous.location);
	if (previousModuleUuid === undefined) return undefined;
	if (currentModules[previousModuleUuid] !== undefined) return undefined;

	const priorSegments = serializePath(previous.location);
	if (
		segments.length !== priorSegments.length ||
		segments.some((segment, index) => segment !== priorSegments[index])
	) {
		return undefined;
	}

	const formerParentUuid =
		previous.modules[previousModuleUuid]?.parentModuleUuid;
	if (formerParentUuid === undefined) return { kind: "home" };
	const formerParent = currentModules[formerParentUuid];
	if (formerParent === undefined) return { kind: "home" };
	return formerParent.caseListOnly
		? { kind: "cases", moduleUuid: formerParentUuid }
		: { kind: "module", moduleUuid: formerParentUuid };
}
