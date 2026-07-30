/**
 * Exact current control frame for `event: revoked`.
 *
 * A malformed control frame cannot be interpreted as confirmed revocation:
 * the provider disowns the stream and reauthorizes through the authoritative
 * app snapshot instead.
 */

import { z } from "zod";

export const REVOCATION_REASONS = [
	"access-revoked",
	"session-revoked",
	"account-inactive",
	"client-upgrade-required",
] as const;

export const revocationFrameSchema = z
	.object({ reason: z.enum(REVOCATION_REASONS) })
	.strict();

export type RevocationFrame = z.infer<typeof revocationFrameSchema>;
export type RevocationReason = RevocationFrame["reason"];

export function parseRevocationFrame(data: string): RevocationFrame | null {
	try {
		const parsed = revocationFrameSchema.safeParse(JSON.parse(data));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}
