/**
 * The canonical pattern for a Nova hashtag reference embedded in PROSE —
 * label / hint / help / validate_msg / option-label text (`#mother/age`,
 * `#form/x`, `#user/y`). ONE source so the emitter (which lowers a resolving
 * prose hashtag to `<output>`) and the deep validator (which checks the same
 * hashtag against the form's reachable case types) can never disagree on what
 * counts as a prose hashtag.
 *
 * Labels are natural-language prose, NOT XPath, so the Lezer XPath grammar
 * can't locate refs here (surrounding markdown like `**` parses as XPath
 * operators and swallows the `#`). Group 1 is the namespace; the full match is
 * the ref text. The pattern is deliberately broad — the namespace is any
 * identifier, not just `case`/`form`/`user` — so a per-type ref is matched too;
 * deciding which matches actually resolve is the emitter's / validator's job,
 * not the pattern's.
 *
 * Exported WITHOUT the `g` flag: a shared global regex carries mutable
 * `lastIndex` state, so each consumer builds its own global instance
 * (`new RegExp(BARE_HASHTAG_PATTERN, "g")`) — the same convention as
 * `lib/references/config.ts::HASHTAG_REF_PATTERN`.
 */
export const BARE_HASHTAG_PATTERN =
	/#([a-zA-Z_][a-zA-Z0-9_-]*)(?:\/[a-zA-Z_][a-zA-Z0-9_-]*)+/;
