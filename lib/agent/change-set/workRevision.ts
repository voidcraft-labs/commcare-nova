import { uuidSchema } from "@/lib/domain";
import { AuthoringInputError } from "../authoring/errors";

/** Candidate identity prevents a token from matching a later checkpoint whose
 * local revision happens to have the same number. Clients echo this value. */
export function workRevision(candidateId: string, revision: number): string {
	return `${candidateId}:${revision}`;
}

export function parseWorkRevision(token: string): {
	candidateId: string;
	revision: number;
} {
	const [candidateId, rawRevision, extra] = token.split(":");
	const revision = Number(rawRevision);
	if (
		extra !== undefined ||
		!uuidSchema.safeParse(candidateId).success ||
		!rawRevision ||
		String(revision) !== rawRevision ||
		!Number.isSafeInteger(revision) ||
		revision < 0
	)
		throw new AuthoringInputError(
			"Read the work and use its current revision to save or discard it.",
		);
	return { candidateId, revision };
}
