/**
 * The ids of a lookup table brought in from CommCare HQ and of its columns,
 * derived from the app's id, the reading's id and CommCare HQ's own names,
 * so the read and the create name the same ones with nothing stored between
 * them.
 *
 * Each is a UUIDv7, because every lookup id must match
 * `lib/domain/lookupIds.ts::LOOKUP_UUID_V7_PATTERN`: `v7` of the `uuid`
 * package given both `msecs` and `random`, which reads no state of its own
 * (`uuid/dist/v7.js::v7` touches its shared state only where no options are
 * given). The time bits are the reading id's own; columns and rows order by
 * their order keys first and tables by name, so the time bits decide no
 * order a person relies on. The random bits are the first 16 bytes of the
 * SHA-256 of a canonical JSON tuple.
 *
 * Pure.
 */

import { createHash } from "node:crypto";
import { v7 } from "uuid";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import { canonicalJsonText } from "@/lib/utils/canonicalJsonText";

const TUPLE_TAG = "nova-hq-lookup-v1";

/** A UUIDv7: its first 48 bits are its time in milliseconds. */
const UUID_V7 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readingTime(readingId: string): number {
	if (!UUID_V7.test(readingId)) {
		throw new Error(
			`A reading's id must be a UUIDv7 for its lookup ids to derive from it; "${readingId}" is not one.`,
		);
	}
	return Number.parseInt(readingId.replaceAll("-", "").slice(0, 12), 16);
}

function derivedId(readingId: string, tuple: readonly string[]): string {
	const digest = createHash("sha256")
		.update(canonicalJsonText(tuple), "utf8")
		.digest();
	return v7({
		msecs: readingTime(readingId),
		random: new Uint8Array(digest.subarray(0, 16)),
	});
}

/** The id of the table a reading brings in under `tag`. */
export function broughtInLookupTableId(
	appId: string,
	readingId: string,
	tag: string,
): LookupTableId {
	return derivedId(readingId, [
		TUPLE_TAG,
		appId,
		"table",
		tag,
	]) as LookupTableId;
}

/** The id of the column a reading brings in for the field `fieldName` of `tag`. */
export function broughtInLookupColumnId(
	appId: string,
	readingId: string,
	tag: string,
	fieldName: string,
): LookupColumnId {
	return derivedId(readingId, [
		TUPLE_TAG,
		appId,
		"column",
		tag,
		fieldName,
	]) as LookupColumnId;
}
