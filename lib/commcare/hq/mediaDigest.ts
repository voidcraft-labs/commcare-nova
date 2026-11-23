import "server-only";
import type { HqMediaType } from "./appSource";
import type { CommCareCredentials } from "./http";
import { readHqMediaDigest } from "./media";

export async function hqMediaMatches(
	creds: CommCareCredentials,
	type: HqMediaType,
	id: string,
	expected: { size: number; sha256: string },
) {
	const result = await readHqMediaDigest(creds, type, id, expected.size);
	return (
		!("success" in result) &&
		result.kind === "hash" &&
		result.size === expected.size &&
		result.sha256 === expected.sha256
	);
}
