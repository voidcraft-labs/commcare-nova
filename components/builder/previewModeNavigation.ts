import type { Location } from "@/lib/routing/types";

/** URL change committed before the session flips its preview flag. */
export function previewModeNavigation(
	on: boolean,
	location: Location,
): { method: "push" | "replace"; location: Location } | undefined {
	if (!on && location.kind === "cases" && location.caseId !== undefined) {
		return {
			method: "replace",
			location: { kind: "detail-config", moduleUuid: location.moduleUuid },
		};
	}
	if (
		on &&
		(location.kind === "app-setup" || location.kind === "project-data")
	) {
		return { method: "push", location: { kind: "home" } };
	}
	return undefined;
}
