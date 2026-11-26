/**
 * Where a stack frame leaves a worker in the running app, read from the
 * frame's own children as the wire owner builds them
 * (`lib/commcare/formLinkProjection.ts`): the screen of its last menu
 * command, the form its form command names, and the menus whose selection it
 * carries. After-submit routing, the preceding task and App Tests land by it.
 */

import { homeSelectionConsumers } from "@/lib/commcare";
import {
	type FormLinkProjectionContext,
	type FrameChild,
	formLinkProjectionContext,
	moduleFrameChildren,
} from "@/lib/commcare/formLinkProjection";
import type { BlueprintDoc, MenuScreen, Uuid } from "@/lib/domain";
import type { PreviewMenuCaseSelection } from "@/lib/session/types";
import { previewLandingScreenOf } from "../menuProjection";
import type { PreviewPlatformRules } from "../platform";

export interface FirstMenuCase {
	readonly datumId: string;
	readonly moduleUuid: Uuid;
	readonly caseType: string;
	readonly consumers: readonly Uuid[];
	readonly destinationConsumers: readonly Uuid[];
}

/** The case bindings installed on the first menu before its first command. */
export function firstMenuCases(
	ctx: FormLinkProjectionContext,
	children: readonly FrameChild[],
): FirstMenuCase[] {
	return [...homeSelectionConsumers(ctx.expressionDoc, ctx, children)].flatMap(
		([datum, owners]) =>
			datum.selectionSourceModuleUuid && datum.caseType
				? [
						{
							datumId: datum.id,
							moduleUuid: datum.selectionSourceModuleUuid,
							caseType: datum.caseType,
							consumers: [...owners.modules],
							destinationConsumers: [...owners.destinationModules],
						},
					]
				: [],
	);
}

export function linkedFirstMenuCases(
	selections: readonly {
		datumId: string;
		moduleUuid: Uuid;
		caseType: string;
		firstMenuConsumers?: readonly Uuid[];
		destinationConsumers?: readonly Uuid[];
	}[],
): FirstMenuCase[] {
	return selections.flatMap((row) =>
		row.firstMenuConsumers
			? [
					{
						datumId: row.datumId,
						moduleUuid: row.moduleUuid,
						caseType: row.caseType,
						consumers: row.firstMenuConsumers,
						destinationConsumers: row.destinationConsumers ?? [],
					},
				]
			: [],
	);
}

/** The root prefix of a module's static after-submit destination. Only menus
 * whose parent shows its forms above can contribute a datum before a command. */
export function moduleFirstMenuCases(
	doc: BlueprintDoc,
	moduleUuid: Uuid,
): FirstMenuCase[] {
	const parent = doc.modules[moduleUuid]?.parentModuleUuid;
	if (!parent || doc.modules[parent]?.formsInMenuAbove !== true) return [];
	const ctx = formLinkProjectionContext(doc, { entryMetadataOnly: true });
	return firstMenuCases(ctx, moduleFrameChildren(doc, ctx, moduleUuid));
}

/** The Home entry behind a framed destination. Web Apps replays its empty
 * first address. Android keeps just these physical datums across Back. */
export function firstMenuSelections(
	bindings: readonly FirstMenuCase[] | undefined,
	selections: Readonly<Record<string, PreviewMenuCaseSelection>>,
	rules: Pick<PreviewPlatformRules, "poppedEntrySelections">,
): Readonly<Record<string, PreviewMenuCaseSelection>> | undefined {
	if (!bindings?.length) return undefined;
	const held: Record<string, PreviewMenuCaseSelection> = {};
	if (rules.poppedEntrySelections === "session")
		for (const binding of bindings) {
			const selection = selections[binding.moduleUuid];
			if (!selection || selection.caseType !== binding.caseType) continue;
			held[binding.moduleUuid] = selection;
			for (const owner of binding.consumers) held[owner] = selection;
		}
	return held;
}

/** Where a frame leaves a worker, read from the frame's own children. */
export interface FrameLanding {
	/** The screen of the frame's last menu command; the first menu where the frame holds none. */
	readonly screen: MenuScreen;
	/** The form the frame's form command names, where it has one. */
	readonly formUuid?: Uuid;
	/** The menus whose selection the frame carries, in frame order. */
	readonly selectingModuleUuids: readonly Uuid[];
	readonly firstMenuCases?: readonly FirstMenuCase[];
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
	const home = firstMenuCases(ctx, children);
	return {
		screen,
		...(home.length > 0 && { firstMenuCases: home }),
		...(formUuid !== undefined && { formUuid }),
		selectingModuleUuids,
	};
}
