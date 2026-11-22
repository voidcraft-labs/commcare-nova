import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { parseHqJsonText } from "@/lib/commcare/hq/jsonText";
import { log } from "@/lib/logger";
import type { AppOwnership } from "./types";

/**
 * Gunzip, check the digest, parse the JSON and read the ownership of one
 * stored baseline row.
 *
 * A row that does not verify is no read Nova can use: it is logged and
 * answers null, which `readAppBaseline` reports as `unread` and
 * `readTargetFacts` as no facts.
 */
export function verifiedBaselineSource(row: {
	readonly deployment_id: string;
	readonly source_gzip: Buffer | null;
	readonly source_digest: string | null;
	readonly ownership: unknown;
}): { readonly source: unknown; readonly ownership: AppOwnership } | null {
	const unverified = (reason: string): null => {
		log.error("[deployment] app baseline does not verify", undefined, {
			deploymentId: row.deployment_id,
			reason,
		});
		return null;
	};
	if (row.source_gzip === null || row.source_digest === null) {
		return unverified("missing source");
	}
	let text: Buffer;
	try {
		text = gunzipSync(row.source_gzip);
	} catch {
		return unverified("gzip");
	}
	if (createHash("sha256").update(text).digest("hex") !== row.source_digest) {
		return unverified("digest");
	}
	let source: unknown;
	try {
		source = parseHqJsonText(text.toString("utf8"));
	} catch {
		return unverified("json");
	}
	const ownership = appOwnershipFromRow(row.ownership);
	if (ownership === null) return unverified("ownership");
	return { source, ownership };
}

function stringList(value: unknown): readonly string[] | null {
	return Array.isArray(value) &&
		value.every((item): item is string => typeof item === "string")
		? value
		: null;
}

export function appOwnershipFromRow(value: unknown): AppOwnership | null {
	if (typeof value !== "object" || value === null) return null;
	const stored = value as Record<string, unknown>;
	const addOns = stringList(stored.addOns);
	const profileProperties = stringList(stored.profileProperties);
	const profileCustomProperties = stringList(stored.profileCustomProperties);
	if (
		addOns === null ||
		profileProperties === null ||
		profileCustomProperties === null ||
		typeof stored.autoGpsCapture !== "boolean"
	)
		return null;
	return {
		addOns,
		profileProperties,
		profileCustomProperties,
		autoGpsCapture: stored.autoGpsCapture,
	};
}
