/**
 * Deterministic, cumulative claim seeding from answered question rounds.
 *
 * An answered `askQuestions` round is REAL source material: the user's
 * answers ground the design the same way their messages do, so each
 * answered round becomes one explicit source claim citing the message part
 * that carries it. Two properties are load-bearing:
 *
 *  - CUMULATIVE: every answered round in the thread seeds a claim, not just
 *    the trailing one: earlier rounds' answers stay citable in every later
 *    package, and a package rebuilt over an unchanged thread carries the
 *    same claims.
 *  - DETERMINISTIC: the claim id is a name-based UUID over the answering
 *    part's thread coordinates, and the statement renders from the stored
 *    parts by a pure function: so the WHOLE claim, not just its id, is a
 *    function of the thread. That is what makes package rebuilds
 *    byte-identical, which the artifact digest bindings, the reviewer's
 *    package re-render, and the stable cached prefix all rely on.
 */

import { createHash } from "node:crypto";
import type { UIMessage } from "ai";
import { sourceClaimSchema } from "@/lib/agent/design/evidence";
import type { SourceClaimSeed } from "@/lib/agent/design/sourcePackage";

/** The fixed namespace every seeded-claim id derives under. Changing it
 *  changes every derived id, which breaks package-rebuild byte identity for
 *  in-flight sessions: never rotate it. */
const CLAIM_ID_NAMESPACE = "b7e43c1a-5a2e-4f5e-9d3a-0c9a4d8f2e61";

/** RFC 4122 name-based (version 5, SHA-1) UUID: canonical lowercase
 *  hyphenated form, the exact shape `designIdSchema` admits. */
export function deterministicDesignId(name: string): string {
	const namespaceBytes = Buffer.from(
		CLAIM_ID_NAMESPACE.replace(/-/g, ""),
		"hex",
	);
	const hash = createHash("sha1")
		.update(namespaceBytes)
		.update(name, "utf8")
		.digest();
	const bytes = Buffer.from(hash.subarray(0, 16));
	bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50;
	bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * One explicit claim per answered `askQuestions` part, over EVERY assistant
 * message in the thread, in thread order. Parts are read defensively (they
 * arrive from the client); a malformed part simply seeds nothing.
 */
export function seedClaimsFromAnsweredRounds(
	threadId: string,
	messages: readonly UIMessage[],
): SourceClaimSeed[] {
	const claims: SourceClaimSeed[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const [partIndex, part] of message.parts.entries()) {
			if (
				typeof part !== "object" ||
				part === null ||
				(part as { type?: unknown }).type !== "tool-askQuestions" ||
				(part as { state?: unknown }).state !== "output-available"
			) {
				continue;
			}
			const input = (part as { input?: unknown }).input as
				| { questions?: Array<{ question?: string }> }
				| undefined;
			const output = (part as { output?: unknown }).output as
				| { answers?: unknown }
				| unknown;
			const statement = `The user answered the design questions ${JSON.stringify(
				input?.questions?.map((question) => question.question) ?? [],
			)} with ${JSON.stringify(output ?? null)}.`;
			claims.push(
				sourceClaimSchema.parse({
					id: deterministicDesignId(
						`design-claim:${threadId}:${message.id}:${partIndex}`,
					),
					statement,
					sourceRefs: [
						{
							kind: "message",
							threadId,
							messageId: message.id,
							partIndex,
						},
					],
					status: "explicit",
					confidence: 1,
				}),
			);
		}
	}
	return claims;
}
