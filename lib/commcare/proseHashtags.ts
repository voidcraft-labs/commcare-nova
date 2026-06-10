import { buildHashtagRefRegex } from "@/lib/domain";

/**
 * The canonical pattern for a Nova hashtag reference embedded in PROSE —
 * label / hint / help / validate_msg / option-label text (`#mother/age`,
 * `#form/x`, `#user/y`). Built from the shared segment definition in
 * `lib/domain/hashtagSegments.ts` so the emitter (which lowers a resolving
 * prose hashtag to `<output>`), the deep validator (which checks the same
 * hashtag against the form's reachable case types), and the editor surfaces
 * (`lib/references/config.ts::HASHTAG_REF_PATTERN`) can never disagree on
 * what counts as a hashtag.
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
export const BARE_HASHTAG_PATTERN = buildHashtagRefRegex();
