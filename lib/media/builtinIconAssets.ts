// lib/media/builtinIconAssets.ts
//
// The server-side bridge that lets a built-in icon reference (`nova-icon:<slug>`)
// flow through the export pipeline exactly like an uploaded image — without a
// `media_assets` row or GCS object. The blueprint stores just the slug; every app
// points at ONE shared copy of the bytes shipped at `public/nova-icons/<slug>.png`.
//
// Built-in awareness is QUARANTINED here (plus the reverse-index sync + the
// browser's `mediaSrc`): the validator, the wire emitters, and the export budget
// stay built-in-agnostic and consume the entries this module synthesizes. The
// manifest (`./manifest.ts`) and the export boundary
// (`../export/boundaryValidation.ts`) each
// partition refs through `partitionAssetRefs`, run the existing asset-load path on
// the real ids only, and merge in these synthesized entries.
//
// Server-only: it reads the shipped PNG bytes from disk. (For the runtime read to
// survive `output: "standalone"`, the emit routes trace `public/nova-icons/**` in
// next.config.ts — the static handler serves the browser; this fs read needs the
// trace.)

import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

import {
	type ResolvedMediaAsset,
	wirePathFor,
} from "@/lib/commcare/multimedia/assetWirePath";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import {
	builtinIconRef,
	type IconSlug,
	iconCatalogEntry,
	isBuiltinIconRef,
	parseBuiltinIconSlug,
} from "@/lib/domain/builtinIcons";
import type { AssetId } from "@/lib/domain/multimedia";

const BUILTIN_IMAGE_MIME = "image/png";
const BUILTIN_IMAGE_EXTENSION = ".png";

/**
 * Split a doc's collected asset refs into real (Postgres-backed) ids and the
 * built-in icon slugs they reference. Built-in slugs are deduped + known-only:
 * a stale `nova-icon:<gone>` ref drops out here (parse returns `null`) so it
 * fails closed downstream exactly like a deleted upload.
 */
export function partitionAssetRefs(ids: readonly string[]): {
	realIds: string[];
	builtinSlugs: IconSlug[];
} {
	const realIds: string[] = [];
	const builtinSlugs: IconSlug[] = [];
	const seen = new Set<IconSlug>();
	for (const id of ids) {
		if (!isBuiltinIconRef(id)) {
			realIds.push(id);
			continue;
		}
		const slug = parseBuiltinIconSlug(id);
		if (slug !== null && !seen.has(slug)) {
			seen.add(slug);
			builtinSlugs.push(slug);
		}
	}
	return { realIds, builtinSlugs };
}

/** Filesystem path to a shipped built-in icon's bytes. */
function builtinIconFsPath(slug: string): string {
	return path.join(process.cwd(), "public", "nova-icons", `${slug}.png`);
}

/** Read a built-in icon's shipped bytes from `public/nova-icons/`. */
export async function readBuiltinIconBytes(slug: string): Promise<Buffer> {
	return readFile(builtinIconFsPath(slug));
}

function catalogEntryOrThrow(slug: IconSlug) {
	const entry = iconCatalogEntry(slug);
	if (!entry) {
		// Unreachable: `partitionAssetRefs` only yields catalog-known slugs. The
		// guard keeps the non-null typing honest against a future caller.
		throw new Error(`Unknown built-in icon slug "${slug}"`);
	}
	return entry;
}

/**
 * Resolve built-in icon slugs to manifest entries — the same `ResolvedMediaAsset`
 * shape an uploaded asset resolves to, with a content-hash wire path (so HQ
 * bulk-upload path-matching + cross-app dedup work) and bytes streamed from
 * `public/nova-icons/` only when `withBytes`.
 */
export async function resolveBuiltinManifestEntries(
	slugs: readonly IconSlug[],
	withBytes: boolean,
): Promise<Array<readonly [AssetId, ResolvedMediaAsset]>> {
	return Promise.all(
		slugs.map(async (slug) => {
			const entry = catalogEntryOrThrow(slug);
			const id = builtinIconRef(slug);
			const bytes = withBytes ? await readBuiltinIconBytes(slug) : undefined;
			return [
				id,
				{
					assetId: id,
					wirePath: wirePathFor(entry.contentHash, BUILTIN_IMAGE_EXTENSION),
					kind: "image",
					mimeType: BUILTIN_IMAGE_MIME,
					contentHash: entry.contentHash,
					extension: BUILTIN_IMAGE_EXTENSION,
					...(bytes !== undefined && { bytes }),
				} satisfies ResolvedMediaAsset,
			] as const;
		}),
	);
}

/**
 * Synthetic `ready`/`image` asset rows for the export boundary. The boundary's
 * only consumers — the media validator rules (`mediaAssetExists`/`mediaAssetReady`/
 * `mediaKindMatches`) and the export budget — read `status`/`kind`/`mimeType`/
 * `sizeBytes`; the remaining fields are filled for shape. `created_at` (a `Date`
 * the boundary never reads) is omitted, so the cast mirrors the test factories'
 * `as unknown as MediaAssetRecord` convention.
 */
export function builtinAssetRows(
	slugs: readonly IconSlug[],
): MediaAssetRecord[] {
	return slugs.map((slug) => {
		const entry = catalogEntryOrThrow(slug);
		return {
			id: builtinIconRef(slug),
			owner: "nova-builtin",
			contentHash: entry.contentHash,
			mimeType: BUILTIN_IMAGE_MIME,
			extension: BUILTIN_IMAGE_EXTENSION,
			sizeBytes: entry.sizeBytes,
			kind: "image",
			gcsObjectKey: "",
			originalFilename: `${slug}.png`,
			status: "ready",
		} as unknown as MediaAssetRecord;
	});
}
