/**
 * The account a read answers, and the account a create that stopped at one
 * of Nova's own checks shows: the page's model and MCP's projection both read
 * them.
 *
 * Client-safe: it imports types alone.
 */

import type { CircumstanceFinding } from "@/lib/publish/hqFindings";
import type { ReadingAnswer } from "./types";

/** A read's answer that is an account. */
export type AccountAnswer = Extract<
	ReadingAnswer,
	{ readonly kind: "account" }
>;

/**
 * The account a `check-failed` create shows: its one finding, `more` 0, `mediaChecked` true, and
 * `counts` holding 1 under the finding's standing.
 */
export function accountOfOne(
	finding: CircumstanceFinding,
	appName: string | null,
): AccountAnswer {
	if (finding.standing === "stop") {
		throw new Error(
			`Nova was asked to show the circumstance ${finding.code} as an account, and it is one that ends a read, which an account never holds. ` +
				"A create that stops at a circumstance answers it as held or changed. Look at the caller of accountOfOne.",
		);
	}
	return {
		kind: "account",
		appName,
		findings: [finding],
		more: 0,
		counts: {
			notYet: finding.standing === "not-yet" ? 1 : 0,
			never: finding.standing === "never" ? 1 : 0,
			fixInHq: finding.standing === "fix-in-hq" ? 1 : 0,
		},
		mediaChecked: true,
	};
}
