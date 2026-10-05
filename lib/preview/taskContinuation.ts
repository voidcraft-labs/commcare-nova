import type { Location } from "@/lib/routing/types";
import type { PreviewTaskContinuation } from "@/lib/session/types";

export function continuesPreviewTask(
	task: PreviewTaskContinuation | undefined,
	location: Location,
): boolean {
	return (
		continuesPreviewCommand(task, location) ||
		(task?.returnModuleUuid !== undefined &&
			location.kind === "module" &&
			location.moduleUuid === task.returnModuleUuid)
	);
}

/** Only the command's active selectors or exact form bypass fresh offering
 * checks. Keeping its world for Back does not grant a different command. */
export function continuesPreviewCommand(
	task: PreviewTaskContinuation | undefined,
	location: Location,
): boolean {
	if (!task) return false;
	if (location.kind === "cases")
		return task.selectingModuleUuids.includes(location.moduleUuid);
	if (location.kind === "form")
		return (
			location.moduleUuid === task.moduleUuid &&
			location.formUuid === task.formUuid
		);
	return (
		location.kind === "module" &&
		task.formUuid === undefined &&
		location.moduleUuid === task.moduleUuid
	);
}
