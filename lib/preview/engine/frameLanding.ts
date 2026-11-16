/**
 * Where a stack frame leaves a worker in the running app, read from the
 * frame's own children as the wire owner builds them
 * (`lib/commcare/formLinkProjection.ts`): the screen of its last menu
 * command, the form its form command names, and the menus whose selection it
 * carries. After-submit routing, the preceding task and App Tests land by it.
 */

import type {
	FormLinkProjectionContext,
	FrameChild,
} from "@/lib/commcare/formLinkProjection";
import type { MenuScreen, Uuid } from "@/lib/domain";
import { previewLandingScreenOf } from "../menuProjection";

/** Where a frame leaves a worker, read from the frame's own children. */
export interface FrameLanding {
	/** The screen of the frame's last menu command; the first menu where the frame holds none. */
	readonly screen: MenuScreen;
	/** The form the frame's form command names, where it has one. */
	readonly formUuid?: Uuid;
	/** The menus whose selection the frame carries, in frame order. */
	readonly selectingModuleUuids: readonly Uuid[];
}

/**
 * Turn a frame's children, before matching, into where it leaves a worker.
 * Each command resolves through `ctx.commandTargets`, as
 * `previousTaskProjection.ts::projectPreviousTask` resolves one: the last
 * command naming no form gives the screen, read through `menuScreenOf` so a
 * command naming a menu that shows its forms above lands on the screen that
 * lists them; a command naming a form gives the form. Each datum that a
 * worker selects and that holds no query names the menu whose selection
 * supplies it (`FrameDatum.selectionSourceModuleUuid`). A frame with no menu
 * command lands on the first menu. `children` are built under `ctx`.
 */
export function screenOfFrame(
	ctx: FormLinkProjectionContext,
	children: readonly FrameChild[],
): FrameLanding {
	const doc = ctx.expressionDoc;
	let screen: MenuScreen = { kind: "first-menu" };
	let formUuid: Uuid | undefined;
	const selectingModuleUuids: Uuid[] = [];
	for (const child of children) {
		if (child.type === "datum") {
			const { datum } = child;
			if (
				datum.requiresSelection &&
				datum.query === undefined &&
				datum.selectionSourceModuleUuid !== undefined
			)
				selectingModuleUuids.push(datum.selectionSourceModuleUuid);
			continue;
		}
		const target = ctx.commandTargets.get(child);
		if (target === undefined)
			throw new Error("The frame names a command no menu or form holds.");
		if (target.formUuid !== undefined) formUuid = target.formUuid;
		else screen = previewLandingScreenOf(doc, target.moduleUuid);
	}
	return {
		screen,
		...(formUuid !== undefined && { formUuid }),
		selectingModuleUuids,
	};
}
