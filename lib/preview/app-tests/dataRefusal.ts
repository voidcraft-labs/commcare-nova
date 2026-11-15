/**
 * Where an App Test met data the worker's device lacks.
 *
 * Preview shows a refusal on the surface that stopped (a menu, a case list,
 * a Search screen, a form or its links), and its copy says which
 * (`runtimeMessages.ts::dataRefusalCopy`). A journey reads those surfaces
 * from one action, so each read that can refuse names its surface here, an
 * inner read's name winning (`engine/surfacedDataRefusal.ts`: the Search
 * evaluation names the Search action's condition the case list's), and the
 * action's refusal (`appTestDataRefusal`) is worded for the surface
 * that stopped and the worker the session runs as.
 */

import {
	type PreviewDataRefusalReason,
	previewDataRefusalSubject,
} from "../engine/dataRefusal";
import { serverPreviewDataRefusalOf } from "../engine/serverDataRefusal";
import {
	SurfacedDataRefusal,
	surfacedRefusal,
} from "../engine/surfacedDataRefusal";
import { type DataRefusalSurface, dataRefusalCopy } from "../runtimeMessages";
import type { AppTestContext } from "./context";
import { AppTestActionError } from "./errors";

/** Run a read of `surface`, naming the surface on any refusal it meets. A
 *  refusal a nested read already named keeps its surface; a refusal of the
 *  links after a form keeps the links. */
export async function readingSurface<T>(
	surface: DataRefusalSurface,
	read: () => Promise<T>,
): Promise<T> {
	try {
		return await read();
	} catch (error) {
		throw surfacedRefusal(error, surface, serverPreviewDataRefusalOf);
	}
}

/** Core's refusal of data the device lacks while a screen lists its menus
 *  or its cases, while a Search screen opens, or while a form opens or goes
 *  on (`engine/serverDataRefusal.ts`), as the action's refusal, worded for
 *  the surface that stopped (`readingSurface`; a read no surface names is a
 *  menu's display condition, or the links when it met them) and for the
 *  worker the session runs as, as Preview words it; any other error as it
 *  is. */
export function appTestDataRefusal(
	context: AppTestContext,
	error: unknown,
): unknown {
	const surfaced = error instanceof SurfacedDataRefusal ? error : undefined;
	const refusal = surfaced?.refusal ?? serverPreviewDataRefusalOf(error);
	if (refusal === undefined) return error;
	return new AppTestActionError(
		appTestRefusalSentence(
			context,
			surfaced?.surface ?? (refusal.stage === "links" ? "links" : "menu"),
			refusal.reason,
		),
	);
}

/** A refusal's sentence on `surface`, for the worker the session runs as,
 *  as Preview's refusal panel words it. */
export function appTestRefusalSentence(
	context: AppTestContext,
	surface: DataRefusalSurface,
	reason: PreviewDataRefusalReason,
): string {
	const personaUuid = context.identity.personaUuid;
	const worker =
		personaUuid === undefined
			? undefined
			: context.doc.personas?.[personaUuid]?.name;
	const copy = dataRefusalCopy(
		context.language,
		surface,
		previewDataRefusalSubject(reason, context.lookup),
		worker === undefined ? {} : { worker },
	);
	return `${copy.title}. ${copy.body}`;
}
