/**
 * A data refusal with the surface whose read met it, and the refusal as it
 * crosses a worker thread.
 *
 * Preview shows a refusal on the surface that stopped (a menu, a case list,
 * a Search screen, a form or its links), and its copy says which
 * (`runtimeMessages.ts::dataRefusalCopy`). A server read that composes
 * several surfaces' reads in one call (a records screen reads the Search
 * action's condition, the Search screen and the Results) names each read's
 * surface where it is made, so its caller words the refusal as Preview does.
 *
 * A worker thread hands an error back by structured clone, which keeps its
 * message and drops its class, so a refusal met in a worker travels as its
 * reason, stage and surface (`DataRefusalTransfer`) and is rebuilt on the
 * host; without that it would arrive as a plain error and abort the call.
 */

import type { DataRefusalSurface } from "../runtimeMessages";
import {
	PreviewDataRefusal,
	type PreviewDataRefusalReason,
	type PreviewDataRefusalStage,
	previewDataRefusalOf,
} from "./dataRefusal";

/** A refusal with the surface whose read met it. */
export class SurfacedDataRefusal extends Error {
	readonly name = "SurfacedDataRefusal";
	constructor(
		readonly refusal: PreviewDataRefusal,
		readonly surface: DataRefusalSurface,
	) {
		super(refusal.message);
	}
}

/**
 * The error a read of `surface` throws for `error`: a refusal named with
 * `surface`, unless an inner read already named one or it refused the links
 * after a form, which keep theirs; any other error as it is. `refusalOf`
 * reads a refusal from an error (a server read also maps the case store's
 * refusal, `serverDataRefusal.ts`).
 */
export function surfacedRefusal(
	error: unknown,
	surface: DataRefusalSurface,
	refusalOf: (
		error: unknown,
	) => PreviewDataRefusal | undefined = previewDataRefusalOf,
): unknown {
	if (error instanceof SurfacedDataRefusal) return error;
	const refusal = refusalOf(error);
	if (refusal === undefined) return error;
	return new SurfacedDataRefusal(
		refusal,
		refusal.stage === "links" ? "links" : surface,
	);
}

/** Run a synchronous read of `surface`, naming the surface on any refusal it
 *  meets (`surfacedRefusal`). */
export function readingSurfaceNow<T>(
	surface: DataRefusalSurface,
	read: () => T,
): T {
	try {
		return read();
	} catch (error) {
		throw surfacedRefusal(error, surface);
	}
}

/** A refusal as it crosses a worker thread. */
export interface DataRefusalTransfer {
	readonly reason: PreviewDataRefusalReason;
	readonly stage: PreviewDataRefusalStage;
	readonly surface?: DataRefusalSurface;
}

/**
 * The refusal `error` stands for, ready to cross a worker thread, or
 * `undefined` for every other error. `stage` is where the worker's whole
 * evaluation stands: an evaluation of the links after a form refuses the
 * links.
 */
export function dataRefusalTransfer(
	error: unknown,
	stage?: PreviewDataRefusalStage,
): DataRefusalTransfer | undefined {
	const surfaced = error instanceof SurfacedDataRefusal ? error : undefined;
	const refusal = surfaced?.refusal ?? previewDataRefusalOf(error);
	if (refusal === undefined) return undefined;
	return {
		reason: refusal.reason,
		stage: stage ?? refusal.stage,
		...(surfaced === undefined ? {} : { surface: surfaced.surface }),
	};
}

/** The refusal a worker sent, as the host throws it. */
export function dataRefusalFromTransfer(
	transfer: DataRefusalTransfer,
): PreviewDataRefusal | SurfacedDataRefusal {
	const refusal = new PreviewDataRefusal(transfer.reason, transfer.stage);
	return transfer.surface === undefined
		? refusal
		: new SurfacedDataRefusal(refusal, transfer.surface);
}
