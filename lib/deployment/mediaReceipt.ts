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
	const absent: string[] = [];
	for (const [path, asset] of expected) {
		const entry = mapped.get("jr://file/" + path);
		const size = asset.byteSource?.size ?? asset.bytes?.length;
		if (!entry || (!entry.unreadable && entry.multimediaId === null))
			absent.push(path);
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
	return { files, missing, absent };
}

/** The import has just landed. Recheck previously recorded files against the
 * destination before deciding which paths this physical batch may send. The
 * native counter and map check runs last: the authenticated reads of recorded
 * files may have spanned another app save. */
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
	const recorded: AssetManifest = new Map(
		[...batch].filter(
			([, asset]) => settled.get(asset.wirePath)?.standing === "recorded",
		),
	);
	const prior =
		recorded.size > 0
			? await readMediaReceipt(creds, domain, appId, recorded)
			: { files: {}, missing: [], absent: [] };
	const absent = new Set(prior.absent);
	const changed = prior.missing.filter((path) => !absent.has(path));
	const files = publishedMediaFiles(batch);
	const checked =
		changed.length > 0
			? null
			: await verifyHqMediaBatch(
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
			changed:
				changed.length > 0 ? changed : files.map((file) => file.wirePath),
			needed: batch,
			settled: [],
		};
	}
	const verified: Record<string, string> = Object.assign(
		Object.create(null),
		prior.files,
	);
	for (const path of checked.paths) delete verified[path.wirePath];
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
