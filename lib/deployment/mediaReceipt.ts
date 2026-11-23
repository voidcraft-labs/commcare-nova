import "server-only";
import type { MediaBundleUploadResult } from "@/lib/commcare/client";
import { type HqAppSource, readHqAppSource } from "@/lib/commcare/hq/appSource";
import type { HqAppSourceAtVersionRead } from "@/lib/commcare/hq/appSourceAtVersion";
import type { CommCareCredentials } from "@/lib/commcare/hq/http";
import { hqMediaMatches } from "@/lib/commcare/hq/mediaDigest";
import { matchesHqMediaKind } from "@/lib/commcare/hq/mediaType";
import type { AssetManifest } from "@/lib/commcare/multimedia/assetWirePath";
import { log } from "@/lib/logger";
import {
	type HqMediaPath,
	type HqMediaRecord,
	publishedMediaFiles,
} from "./hqMedia";
import { verifyHqMediaBatch } from "./hqMediaSettle";

export interface MediaReceipt {
	files: HqMediaRecord;
	missing: string[];
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
			if (!expected.has(path) || excluded.has(path) || ids.has(path))
				return unresolved();
			ids.set(path, file.multimediaId);
		}
		if (
			report.unmatchedFiles.length !== report.unmatched ||
			(report.matchedFiles && report.matchedFiles.length !== report.matched)
		)
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
	for (const [path, asset] of expected) {
		const entry = mapped.get(`jr://file/${path}`);
		const size = asset.byteSource?.size ?? asset.bytes?.length;
		if (
			excluded.has(path) ||
			(report?.matchedFiles != null && !ids.has(path)) ||
			!entry ||
			entry.unreadable ||
			!entry.mediaType ||
			!matchesHqMediaKind(entry.mediaType, asset.kind) ||
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
	return { files, missing };
}

/** The import has just landed. Decide which paths this physical batch still
 * sends. The batch's destinations are checked against the source compared for
 * the import, at HQ's save counter now (`verifyHqMediaBatch`): a path that
 * moved since is settled by its bytes, and anything Nova cannot account for
 * leaves the whole batch unsent. A path that still names the file Nova
 * recorded is reused without a read, since CommCare HQ binds a file id to one
 * content (`hqmedia/models.py::CommCareMultimedia.get_by_data`). */
export async function prepareMediaBatch(
	creds: CommCareCredentials,
	domain: string,
	appId: string,
	batch: AssetManifest,
	settled: ReadonlyMap<string, HqMediaPath>,
	compared: HqAppSource,
	readBack: HqAppSourceAtVersionRead | null,
): Promise<{
	readonly verified: HqMediaRecord;
	readonly changed: readonly string[];
	readonly needed: AssetManifest;
	readonly settled: readonly HqMediaPath[];
}> {
	const files = publishedMediaFiles(batch);
	const checked = await verifyHqMediaBatch(
		creds,
		domain,
		appId,
		compared,
		readBack,
		files,
	).catch((error: unknown) => {
		log.error(
			"[deployment] could not verify the media destinations before dispatch",
			error,
			{ domain, hqAppId: appId },
		);
		return null;
	});
	if (checked === null) {
		return {
			verified: {},
			changed: files.map((file) => file.wirePath),
			needed: batch,
			settled: [],
		};
	}
	const now = new Map(settled);
	for (const path of checked.paths) now.set(path.wirePath, path);
	const verified: Record<string, string> = Object.create(null);
	for (const file of files) {
		const path = now.get(file.wirePath);
		if (path?.standing === "recorded" && path.hq !== null)
			verified[file.wirePath] = path.hq.multimediaId;
	}
	Object.assign(verified, checked.learned);
	return {
		verified,
		changed: [],
		needed: new Map(
			[...batch].filter(
				([, asset]) => !Object.hasOwn(verified, asset.wirePath),
			),
		),
		settled: checked.paths,
	};
}
