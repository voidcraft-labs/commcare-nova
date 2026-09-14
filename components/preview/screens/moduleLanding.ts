import type { ModuleLanding, Uuid } from "@/lib/domain";
import type { NavigateActions } from "@/lib/routing/hooks";

/** Push the module's landing screen. */
export function openModuleLanding(
	navigate: Pick<NavigateActions, "openCaseList" | "openModule">,
	moduleUuid: Uuid,
	landing: ModuleLanding,
): void {
	if (landing === "case-list") navigate.openCaseList(moduleUuid);
	else navigate.openModule(moduleUuid);
}
