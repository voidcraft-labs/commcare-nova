/**
 * Zero-width adjacency guards for hashtag references.
 *
 * A hashtag reference is one CONTIGUOUS span — the same extent the regex
 * matchers built from `lib/domain/hashtagSegments.ts` locate — but the
 * grammar skips whitespace between any two tokens, and an open-ended
 * skipless rule is inexpressible in LR (the generator rejects it with
 * "inconsistent skip sets"). So the `HashtagRef` rule requires a
 * zero-width guard token before each token inside the ref, emitted only
 * when:
 *
 *   1. nothing was skipped — the character immediately before the current
 *      position is not whitespace (with a gap the guard is absent, the
 *      rule can't continue, and "# form/x" is no reference), AND
 *   2. the lookahead genuinely continues the ref — `noGapIdent` needs an
 *      identifier-start next (it sits before `HashtagType` and each
 *      `HashtagSegment`), `noGapSlash` needs `/` followed by an
 *      identifier-start (it sits before each segment's `/`, so
 *      `#form/age + 1` reduces cleanly instead of shifting a guard the
 *      following `/` would then fail).
 *
 * The identifier-start set here is the start charset of the grammar's
 * dedicated `hashtagName` token — the regex matchers' `[A-Za-z_]`. The
 * token's body pins the REST of each segment to the same ASCII charset
 * (`[A-Za-z0-9_-]*`), so a segment's full extent means the same thing on
 * every matcher even though XPath element names (`NameTest`) keep the
 * grammar's full Unicode range. The guard alone can't deliver that — it
 * fires once at the token boundary; the extent agreement lives in the
 * token definition, held in lockstep by the divergence-corpus test.
 */
import { ExternalTokenizer } from "@lezer/lr";
import { noGapIdent, noGapSlash } from "./parser.terms";

/** The grammar's skip set: tab, newline, carriage return, space. */
const SKIP_CHARS = new Set([9, 10, 13, 32]);

/** ASCII identifier start: `[A-Za-z_]` — the shared segment charset. */
function isIdentStart(ch: number): boolean {
	return (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95;
}

export const hashtagGuard = new ExternalTokenizer((input) => {
	const prev = input.peek(-1);
	if (prev < 0 || SKIP_CHARS.has(prev)) return;
	const next = input.next;
	if (isIdentStart(next)) {
		input.acceptToken(noGapIdent);
	} else if (next === 47 /* "/" */ && isIdentStart(input.peek(1))) {
		input.acceptToken(noGapSlash);
	}
});
