import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HQ_MEDIA_TYPES, type HqMediaType } from "@/lib/commcare/hq/appSource";
import { CANONICAL_UUID_PATTERN } from "@/lib/domain/uuid";
import {
	provisionalReadingMediaId,
	READING_MEDIA_NAMESPACE,
	reviewMediaId,
} from "../mediaIds";

/**
 * RFC 9562's name-based UUID, version 5, computed from its definition with
 * `node:crypto` rather than the `uuid` package: SHA-1 over the namespace's 16
 * bytes and the name's UTF-8, the first 16 bytes of the digest, version 5 in
 * the high nibble of byte 6 and the variant `10` in the top bits of byte 8.
 */
function rfcUuidV5(name: string, namespace: string): string {
	const digest = createHash("sha1")
		.update(Buffer.from(namespace.replaceAll("-", ""), "hex"))
		.update(name, "utf8")
		.digest()
		.subarray(0, 16);
	digest[6] = (digest[6] & 0x0f) | 0x50;
	digest[8] = (digest[8] & 0x3f) | 0x80;
	const hex = digest.toString("hex");
	return [
		hex.slice(0, 8),
		hex.slice(8, 12),
		hex.slice(12, 16),
		hex.slice(16, 20),
		hex.slice(20),
	].join("-");
}

const APP = "01937c5e-7d1a-7c3b-8a4f-2b6c9d0e1f23";
const MULTIMEDIA = "2b0b0e0f6a2c4b1e9d7f5a3c1e8b6d4f";
const HASH = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

describe("provisionalReadingMediaId", () => {
	it("is the RFC 9562 version 5 UUID of the canonical JSON of its three inputs", () => {
		expect(provisionalReadingMediaId(APP, "CommCareImage", MULTIMEDIA)).toBe(
			rfcUuidV5(
				`["${APP}","CommCareImage","${MULTIMEDIA}"]`,
				READING_MEDIA_NAMESPACE,
			),
		);
	});

	it("gives equal inputs one id, and a change of any input another", () => {
		const id = provisionalReadingMediaId(APP, "CommCareAudio", MULTIMEDIA);
		expect(provisionalReadingMediaId(APP, "CommCareAudio", MULTIMEDIA)).toBe(
			id,
		);
		const changed = [
			provisionalReadingMediaId(
				"01937c5e-7d1a-7c3b-8a4f-2b6c9d0e1f24",
				"CommCareAudio",
				MULTIMEDIA,
			),
			provisionalReadingMediaId(APP, "CommCareVideo", MULTIMEDIA),
			provisionalReadingMediaId(APP, "CommCareAudio", `${MULTIMEDIA}0`),
		];
		for (const other of changed) expect(other).not.toBe(id);
		expect(new Set(changed).size).toBe(changed.length);
	});

	it("keeps its inputs apart where plain concatenation would join them", () => {
		expect(provisionalReadingMediaId("a,b", "CommCareImage", "c")).not.toBe(
			provisionalReadingMediaId("a", "CommCareImage", "b,c"),
		);
	});
});

describe("reviewMediaId", () => {
	it("is the RFC 9562 version 5 UUID of the canonical JSON of the content hash", () => {
		expect(reviewMediaId(HASH)).toBe(
			rfcUuidV5(`["content","${HASH}"]`, READING_MEDIA_NAMESPACE),
		);
	});

	it("gives one content one id, and another content another", () => {
		expect(reviewMediaId(HASH)).toBe(reviewMediaId(HASH));
		expect(reviewMediaId(`${HASH.slice(0, -1)}9`)).not.toBe(
			reviewMediaId(HASH),
		);
	});
});

describe("the two ids", () => {
	it("are canonical lowercase version 5 UUIDs", () => {
		for (const id of [
			provisionalReadingMediaId(APP, "CommCareImage", MULTIMEDIA),
			reviewMediaId(HASH),
		]) {
			expect(id).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			);
			expect(id).toMatch(CANONICAL_UUID_PATTERN);
		}
	});

	it("never collide: a provisional id names three values, a review id two", () => {
		const provisional = new Set(
			HQ_MEDIA_TYPES.flatMap((mediaType: HqMediaType) => [
				provisionalReadingMediaId(APP, mediaType, MULTIMEDIA),
				provisionalReadingMediaId("content", mediaType, HASH),
				provisionalReadingMediaId(APP, mediaType, HASH),
			]),
		);
		const review = [reviewMediaId(HASH), reviewMediaId(MULTIMEDIA)];
		expect(provisional.size).toBe(HQ_MEDIA_TYPES.length * 3);
		for (const id of review) expect(provisional.has(id)).toBe(false);
	});
});
