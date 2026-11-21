/**
 * Which project space a CCZ from the publish dialog is made for, as a pure
 * state model over the dialog's read (`readDownloadTargetsAction`).
 *
 * The read says, for each project space the app is published to, whether a
 * CCZ can be made there (`DownloadTargetOption.unavailable`), from the same
 * standing the download reads (`lib/deployment/downloadTarget.ts::cczStandingOf`).
 * This model is the one place the dialog turns that into rows, a pick, and
 * whether the option has anything to choose, so a space with no CCZ is shown
 * with its reason and is never the one a download is sent for.
 */
import type {
	DownloadTargetOption,
	DownloadTargetsView,
} from "@/lib/deployment/actions";
import {
	cczUnavailableLine,
	projectSpaceLabel,
} from "@/lib/deployment/runtimeTarget";
import type { CommCareServer } from "@/lib/deployment/types";

/** The project spaces a CCZ can be made for, loaded when the dialog opens. */
export type DownloadTargets =
	| { readonly type: "loading" }
	| { readonly type: "ready"; readonly view: DownloadTargetsView }
	| { readonly type: "error"; readonly message: string };

/** A choice's value for one project space: the server and the name together. */
export function downloadTargetKey(target: {
	readonly server: CommCareServer;
	readonly domain: string;
}): string {
	return `${target.server}:${target.domain}`;
}

/** One project space as the dialog lists it. */
export interface CczTargetRow {
	readonly key: string;
	/** `<domain> on <server label>`. */
	readonly label: string;
	/** Why there is no CCZ for it, in the dialog's words; null where there is one. */
	readonly unavailableLine: string | null;
}

/** Every project space the app is published to, in the read's order. */
export function cczTargetRows(view: DownloadTargetsView): CczTargetRow[] {
	return view.targets.map((target) => ({
		key: downloadTargetKey(target),
		label: projectSpaceLabel(target),
		unavailableLine:
			target.unavailable === null
				? null
				: cczUnavailableLine(target.unavailable),
	}));
}

function available(view: DownloadTargetsView): DownloadTargetOption[] {
	return view.targets.filter((target) => target.unavailable === null);
}

/**
 * The pick after a read: a pick a CCZ can still be made for stays; else the
 * one space a CCZ can be made for is chosen for the person; else none, and
 * several wait for their pick. A space with no CCZ is never picked.
 */
export function cczPickAfterRead(
	view: DownloadTargetsView,
	current: string,
): string {
	const keys = available(view).map(downloadTargetKey);
	if (keys.includes(current)) return current;
	return keys.length === 1 ? (keys[0] ?? "") : "";
}

/**
 * The project space a CCZ is sent for: the pick, where the read offers it and
 * a CCZ can be made there; null otherwise.
 */
export function chosenCczTarget(
	state: DownloadTargets,
	key: string,
): DownloadTargetOption | null {
	if (state.type !== "ready") return null;
	return (
		available(state.view).find((target) => downloadTargetKey(target) === key) ??
		null
	);
}

/**
 * Whether the mobile option has nothing to choose, so the dialog offers to
 * close rather than to continue: the read failed, the app runs in Web Apps
 * only, it is published nowhere, or no project space it is published to can
 * have a CCZ. False while the read is still loading.
 */
export function cczHasNoChoice(state: DownloadTargets): boolean {
	if (state.type === "loading") return false;
	if (state.type === "error") return true;
	return available(state.view).length === 0;
}
