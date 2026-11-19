import "server-only";

/**
 * A read of an app's source that CommCare HQ's save counter proves.
 *
 * The source view serves no `version` (`models/applications.py::export_json`
 * drops `_meta_fields`, which hold it), so a read alone cannot say which save
 * it shows. `views/releases.py::current_app_version` serves the working app's
 * counter, and every save of a working app raises it by exactly one
 * (`ApplicationBase.save`, `self.version + 1`); the saves that leave it are of
 * builds and copies, the linked-app pull, and the undo of a delete. So a
 * counter read after the source that equals the counter the reader expected
 * proves the source is the app at that counter: no save fell between the
 * moment the counter stood there and the counter read, the source read
 * between them included.
 *
 * Only `HqAppSourceAtVersion` says a read is what one write left, and a
 * deployment's `push` and `create` baselines take nothing else
 * (`lib/deployment/service.ts::appBaselineFor`).
 */

import { type HqAppVersions, readAppVersions } from "../client";
import {
	type HqAppSource,
	type HqAppSourceRead,
	type ReadHqAppSourceOptions,
	readHqAppSource,
} from "./appSource";
import type { CommCareApiError, CommCareCredentials } from "./http";

declare const atVersion: unique symbol;

/** A source read the save counter proved to be the app at `version`. */
export interface HqAppSourceAtVersion {
	readonly kind: "source-at";
	readonly source: HqAppSource;
	readonly version: number;
	readonly [atVersion]: true;
}

export type HqAppSourceAtVersionRead =
	| HqAppSourceAtVersion
	/**
	 * The source was read, and the counter after it is not the one expected:
	 * a save fell between them, so the read cannot say what the write left.
	 * `version` is the counter as read after the source.
	 */
	| {
			readonly kind: "moved";
			readonly source: HqAppSource;
			readonly version: number;
	  }
	/**
	 * The source was read, and the counter after it could not be: nothing
	 * proves which save the source shows.
	 */
	| {
			readonly kind: "unbound";
			readonly source: HqAppSource;
			readonly counter: CommCareApiError;
	  }
	| Exclude<HqAppSourceRead, { readonly kind: "source" }>;

/**
 * Read the app's source, then its save counter, and answer the source as the
 * app at `version` only where the counter still stands there.
 */
export async function readHqAppSourceAtVersion(
	creds: CommCareCredentials,
	domain: string,
	appId: string,
	version: number,
	options: ReadHqAppSourceOptions = {},
): Promise<HqAppSourceAtVersionRead> {
	const read = await readHqAppSource(creds, domain, appId, options);
	if ("success" in read || read.kind !== "source") return read;
	const counter = await readAppVersions(creds, domain, appId, {
		cancel: options.cancel,
	});
	if ("success" in counter)
		return { kind: "unbound", source: read.source, counter };
	if (counter.currentVersion !== version)
		return {
			kind: "moved",
			source: read.source,
			version: counter.currentVersion,
		};
	return {
		kind: "source-at",
		source: read.source,
		version,
	} as HqAppSourceAtVersion;
}

/**
 * The counter a publish reads just before its last read of the source ahead
 * of an import. The import's acknowledged counter is this plus one exactly
 * where no save fell between this read and the import, so whatever the
 * import replaced is what that source read showed.
 */
export async function readHqAppSaveCounter(
	creds: CommCareCredentials,
	domain: string,
	appId: string,
): Promise<number | CommCareApiError> {
	const counter: HqAppVersions | CommCareApiError = await readAppVersions(
		creds,
		domain,
		appId,
	);
	return "success" in counter ? counter : counter.currentVersion;
}

/**
 * Whether an import acknowledged at `acknowledged` replaced exactly the app
 * at `before`: one save, the import's own, and none between. An
 * acknowledgement that carried no counter proves nothing.
 */
export function importReplacedReadApp(
	before: number,
	acknowledged: number | null,
): boolean {
	return acknowledged !== null && acknowledged === before + 1;
}
