/**
 * Rule: every referenced asset is in `status: "ready"` — its bytes
 * have been validated and stored.
 *
 * The upload flow has a transient `pending` window: the Firestore
 * row exists from the moment the signed PUT URL is minted, but the
 * confirm step (sniffing MIME, computing SHA-256, decoding via
 * sharp/ffprobe) doesn't run until after the browser PUTs the
 * bytes. A user who navigates away mid-upload, or whose browser
 * never reaches confirm, leaves the row at `pending`. Shipping an
 * app that references that row would render a broken icon / play a
 * 0-byte audio on the device — the wire path resolves, but the GCS
 * object behind it is the unvalidated client upload.
 *
 * The production loader (`loadAssetsByIds`) filters out `pending`
 * rows already, so a normal SA loop never reaches this rule's
 * positive case in production. The rule is the contract: a test
 * fixture, a hand-built MCP tool result, or a future loader
 * widening that surfaces a pending row will be caught here.
 */

import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import type { BlueprintDoc } from "@/lib/domain";
import { walkAssetRefs } from "@/lib/domain/mediaRefs";
import { type ValidationError, validationError } from "../../errors";
import { describeLocation, scopeFor, validationLocationFor } from "./shared";

/**
 * Walk every media reference; for any whose resolved row's `status`
 * isn't `"ready"`, emit MEDIA_ASSET_NOT_READY. References whose ids
 * don't resolve at all are silently skipped (left to
 * `mediaAssetExists`).
 */
export function mediaAssetReady(
	doc: BlueprintDoc,
	manifest: ReadonlyMap<string, MediaAssetRecord>,
	// Carried for the uniform `MediaAssetRule` shape; not consulted —
	// readiness is owner-agnostic.
	_expectedOwner: string,
): ValidationError[] {
	const errors: ValidationError[] = [];
	for (const ref of walkAssetRefs(doc)) {
		const record = manifest.get(ref.assetId);
		if (!record) continue;
		if (record.status === "ready") continue;
		errors.push(
			validationError(
				"MEDIA_ASSET_NOT_READY",
				scopeFor(ref.location),
				`The media asset at ${describeLocation(ref.location)} hasn't finished uploading yet. Wait for the upload to complete (the asset chip shows a spinner during upload), or remove the reference if the upload was abandoned.`,
				validationLocationFor(ref.location),
				{ assetId: ref.assetId, status: record.status },
			),
		);
	}
	return errors;
}
