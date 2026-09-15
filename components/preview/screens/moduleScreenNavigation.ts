import type { Uuid } from "@/lib/domain";
import type { Location } from "@/lib/routing/types";

/** A configuration URL runs its owning Form/Results surface in Preview, so
 * it is as resumable as the canonical running URL. Module and module-condition
 * locations are already menu checkpoints and need no leaf restoration. */
export function previewParentCaseResumeLocation(
	loc: Location,
	moduleUuid: Uuid,
): Location | undefined {
	if (
		loc.kind === "home" ||
		loc.kind === "app-setup" ||
		loc.kind === "project-data" ||
		loc.kind === "module" ||
		loc.kind === "module-condition" ||
		loc.moduleUuid !== moduleUuid
	) {
		return undefined;
	}
	return loc;
}
