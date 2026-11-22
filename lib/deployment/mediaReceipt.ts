import "server-only";
import type { MediaBundleUploadResult } from "@/lib/commcare/client";
import { readHqAppSource } from "@/lib/commcare/hq/appSource";
import type { CommCareCredentials } from "@/lib/commcare/hq/http";
import { hqMediaMatches } from "@/lib/commcare/hq/mediaDigest";
import type { AssetManifest } from "@/lib/commcare/multimedia/assetWirePath";
import type { HqMediaRecord } from "./hqMedia";

export interface MediaReceipt {
	files: HqMediaRecord;
	missing: string[];
	absent: string[];
}

/** An HQ job acknowledges matching names. The current app map proves where
 * each file landed, and the authenticated file proves its actual content. */
export async function readMediaReceipt(
	creds: CommCareCredentials,
	domain: string,
	appId: string,
	assets: AssetManifest,
	report?: MediaBundleUploadResult,
): Promise<MediaReceipt> {
	const expected = new Map(
		[...assets.values()].map((asset) => [asset.wirePath, asset]),
	);
	const unresolved = (): MediaReceipt => ({
		files: {},
		absent: [],
		missing: [...expected.keys()],
	});
	if (report?.timedOut || report?.errors.length) return unresolved();
	const ids = new Map<string, string>();
	const excluded = new Set<string>();
	if (report) {
		for (const file of report.unmatchedFiles) {
			if (!expected.has(file.path) || excluded.has(file.path))
				return unresolved();
			excluded.add(file.path);
		}
		for (const file of report.matchedFiles ?? []) {
			const path = file.path.startsWith("jr://file/")
				? file.path.slice(10)
				: "";
			if (!expected.has(path) || ids.has(path)) return unresolved();
			ids.set(path, file.multimediaId);
		}
		if (report.matchedFiles && report.matchedFiles.length !== report.matched)
			return unresolved();
	}
	const current = await readHqAppSource(creds, domain, appId);
	if (
		"success" in current ||
		current.kind !== "source" ||
		current.source.multimediaMap === null
	)
		return unresolved();
	const mapped = new Map(
		current.source.multimediaMap.map((item) => [item.path, item]),
	);
	const files: Record<string, string> = Object.create(null);
	const missing: string[] = [];
	const absent: string[] = [];
	for (const [path, asset] of expected) {
		const entry = mapped.get("jr://file/" + path);
		const size = asset.byteSource?.size ?? asset.bytes?.length;
		if (!entry || (!entry.unreadable && entry.multimediaId === null))
			absent.push(path);
		if (
			excluded.has(path) ||
			!entry ||
			entry.unreadable ||
			!entry.mediaType ||
			!entry.multimediaId ||
			(ids.has(path) && ids.get(path) !== entry.multimediaId) ||
			size === undefined ||
			!(await hqMediaMatches(creds, entry.mediaType, entry.multimediaId, {
				size,
				sha256: asset.contentHash,
			}))
		) {
			missing.push(path);
			continue;
		}
		files[path] = entry.multimediaId;
	}
	return { files, missing, absent };
}
