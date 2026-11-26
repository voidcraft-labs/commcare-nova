import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { HQ_APP_SOURCE_MAX_BYTES } from "@/lib/commcare/hq/appSource";
import { verifiedInstallationBaseline } from "../installationProfileBaselines";
import {
	crossDestinationInstallations,
	portableInstallationDigest,
} from "../installationProfileCensus";

it("compares portable definitions across destinations and preserves unobserved siblings", () => {
	const before = {
		id: "old-key",
		name: "Team",
		langs: ["en", "fr"],
		practiceWorkerId: "worker-at-A",
	};
	const after = { ...before, id: "new-key", practiceWorkerId: "worker-at-B" };
	const same = portableInstallationDigest([before]);
	expect(portableInstallationDigest([after])).toBe(same);
	const reordered = portableInstallationDigest([
		{ ...after, langs: ["fr", "en"] },
	]);
	expect(reordered).not.toBe(same);
	expect(
		portableInstallationDigest([{ ...after, practiceWorkerId: undefined }]),
	).not.toBe(same);
	expect(portableInstallationDigest([before, after])).not.toBe(same);
	expect(
		crossDestinationInstallations([
			{ app: "agrees", portable: same },
			{ app: "agrees", portable: same },
			{ app: "different", portable: same },
			{ app: "different", portable: reordered },
			{ app: "different", portable: null },
			{ app: "partial", portable: same },
			{ app: "partial", portable: null },
			{ app: "single", portable: same },
		]),
	).toEqual([
		{ app: "agrees", targets: 2, observed: 2, unobserved: 0, state: "agrees" },
		{
			app: "different",
			targets: 3,
			observed: 2,
			unobserved: 1,
			state: "split",
		},
		{
			app: "partial",
			targets: 2,
			observed: 1,
			unobserved: 1,
			state: "unobserved",
		},
		{ app: "single", targets: 1, observed: 1, unobserved: 0, state: "single" },
	]);
});

it("verifies retained source length, bounded decompression and digest before reading a definition", () => {
	const body = Buffer.from('{"build_profiles":{}}');
	const stored = {
		source_gzip: gzipSync(body),
		source_digest: createHash("sha256").update(body).digest("hex"),
		source_bytes: body.length,
	};
	expect(verifiedInstallationBaseline(stored)).toEqual(body);
	for (const length of [0, -1, null, 1.5, HQ_APP_SOURCE_MAX_BYTES + 1])
		expect(() =>
			verifiedInstallationBaseline({ ...stored, source_bytes: length }),
		).toThrow("invalid declared length");
	expect(() =>
		verifiedInstallationBaseline({ ...stored, source_bytes: body.length + 1 }),
	).toThrow("does not match");
	expect(() =>
		verifiedInstallationBaseline({ ...stored, source_bytes: body.length - 1 }),
	).toThrow();
	expect(() =>
		verifiedInstallationBaseline({ ...stored, source_digest: "different" }),
	).toThrow("digest");
});
