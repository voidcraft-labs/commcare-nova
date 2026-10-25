/**
 * The Web App setting a publish writes and the questions it asks about it.
 *
 * Every application body Nova generates carries `cloudcare_enabled` from the
 * app's declaration (`hqShells.ts::applicationShell`), and HQ's update keeps
 * the body's value with no privilege check
 * (`models/applications.py::_merge_source_into_app`). A create takes the
 * plan's own answer whatever the body says (`_create_app_from_doc`). So a
 * publish asks a person before an update changes the value HQ holds on an
 * app that holds Nova's content, stops a first publish whose new app HQ made
 * with Web Apps off for an app that runs in Web Apps, and stops a publish
 * whose setting moved while its tables or places were pushed.
 *
 * Pure: the preflight edge, the service and the proof lane's capture all call
 * these, so each decides a stop the same way.
 */

import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import type { WebAppsChange } from "@/lib/publish/webApps";
import type { AppBaseline } from "./types";

export type { WebAppsChange } from "@/lib/publish/webApps";

export interface WebAppsChangeInput {
	readonly declaresWebApps: boolean;
	/** The `target-app` read's `cloudcareEnabled`. */
	readonly held: boolean;
	/** The stored app baseline of the app that read named, or null where none is stored. */
	readonly baseline: {
		readonly origin: AppBaseline["origin"];
		readonly source?: unknown;
	} | null;
	/** What the caller sent: the value the person agreed to write. */
	readonly confirmWebApps: boolean | undefined;
}

/**
 * The question an update asks about the app's Web App setting, or null where
 * there is nothing to ask: the app holds no content of Nova's yet (its
 * baseline's origin is `create`, and its fill writes the declaration as a
 * first publish does), HQ already holds the declaration, or the person
 * agreed to write it. `changedInHq` says who moved the value, read from the
 * baseline Nova's last push stored, and is null where no read of it is
 * stored.
 */
export function webAppsChange(input: WebAppsChangeInput): WebAppsChange | null {
	if (input.baseline?.origin === "create") return null;
	if (input.held === input.declaresWebApps) return null;
	if (input.confirmWebApps === input.declaresWebApps) return null;
	const baseline = input.baseline;
	const changedInHq =
		baseline !== null &&
		(baseline.origin === "push" || baseline.origin === "cutover")
			? baselineWebApps(baseline.source) !== input.held
			: null;
	return { from: input.held, to: input.declaresWebApps, changedInHq };
}

/**
 * The Web App setting a stored app baseline's normalized source holds:
 * `source.cloudcare_enabled === true`, as HQ's `BooleanProperty(default=False)`
 * reads an absent value.
 */
export function baselineWebApps(source: unknown): boolean {
	return (
		typeof source === "object" &&
		source !== null &&
		(source as { readonly cloudcare_enabled?: unknown }).cloudcare_enabled ===
			true
	);
}

/** A first publish's stop: the app runs in Web Apps, and HQ made the new app with Web Apps off. */
export function createdWithoutWebApps(input: {
	readonly declaresWebApps: boolean;
	readonly shell: HqAppSource;
}): boolean {
	return input.declaresWebApps && !input.shell.cloudcareEnabled;
}

/** The second read's stop: the setting moved between the held read and the second. */
export function webAppsMovedDuringPush(
	held: HqAppSource,
	second: HqAppSource,
): boolean {
	return held.cloudcareEnabled !== second.cloudcareEnabled;
}
