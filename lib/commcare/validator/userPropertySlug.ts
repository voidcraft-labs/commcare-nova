/**
 * Whether a user-data property's slug is one CommCare will accept.
 *
 * Lives with the validator because it is a CommCare rule end to end;
 * `lib/doc/identifierVerdicts.ts` re-exports it so every authoring surface
 * keeps one import home for identifier verdicts.
 */

import { RESERVED_CASE_PROPERTIES } from "@/lib/commcare/constants";
import {
	USER_DATA_RESERVED_PREFIXES,
	USER_DATA_SYSTEM_FIELDS,
	USER_PROPERTY_SLUG_MAX_LENGTH,
	USER_PROPERTY_SLUG_PATTERN,
} from "@/lib/domain";

// ── User-data property slugs ────────────────────────────────────────
//
// A user property's slug is the key CommCare stores it under and the name
// expressions read at `session/user/data/<slug>`. HQ adjudicates the same
// string in three places, and all three run when a domain admin saves the
// user-data schema — so a slug that fails any of them makes the eventual
// push fail on identity grounds, long after the author wrote it. Nova
// applies the same acceptability boundary at construction instead, with the
// reserved-name checks deliberately lowercased (marginally stricter than HQ
// for mixed-case spellings; stricter cannot cost a push):
//
//   - `custom_data_fields/edit_model.py::XmlSlugField` lists
//     `validate_slug` (Django's `[-a-zA-Z0-9_]+` charset),
//     `validate_reserved_words`, and `RegexValidator(r'\D', '')` — the
//     last of which demands at least one non-digit, because an all-digit
//     key breaks XML;
//   - Nova emits the slug as an XML element name on both the session and
//     usercase paths, so the first character must be a letter or underscore.
//     This is stricter than Django's slug validator and prevents a schema HQ
//     can save but its generated worker XML cannot represent;
//   - `::validate_reserved_words` refuses `SYSTEM_FIELDS` outright and
//     anything prefixed `commcare` or `xml`;
//   - `::CustomDataFieldsForm.verify_no_reserved_words` additionally
//     refuses any CommCare case-reserved word, and
//     `::verify_no_duplicates` compares slugs LOWERCASED, so uniqueness
//     is case-insensitive even though the stored value is not.
//
// `RESERVED_CASE_PROPERTIES` is HQ's `case-reserved-words.json` plus
// `name` and `owner_id`; both extras are already in `SYSTEM_FIELDS`, so
// reading the superset gives the identical answer with one list.

/** Why a proposed user-property slug can't be used. */
export type UserPropertySlugRejectionCode =
	| "empty"
	| "illegal_format"
	| "all_digits"
	| "reserved"
	| "too_long"
	| "duplicate";

export type UserPropertySlugVerdict =
	| { ok: true }
	| { ok: false; code: UserPropertySlugRejectionCode; userMessage: string };

const USER_PROPERTY_SLUG_OK: UserPropertySlugVerdict = { ok: true };

/**
 * Adjudicate a user-property slug against CommCare's rules plus the app's
 * existing slugs. `existing` holds the slugs already claimed, compared
 * case-insensitively because HQ's duplicate check lowercases both sides —
 * so "Region" and "region" collide there and must collide here.
 *
 * Pass the property's own current slug as `existing` minus itself when
 * re-checking a rename; this verdict has no notion of which property is
 * asking.
 */
export function userPropertySlugVerdict(
	slug: string,
	existing: ReadonlySet<string>,
): UserPropertySlugVerdict {
	const trimmed = slug.trim();
	if (trimmed.length === 0) {
		return {
			ok: false,
			code: "empty",
			userMessage: "Enter a name for this piece of worker information.",
		};
	}
	if (!/\D/.test(trimmed)) {
		return {
			ok: false,
			code: "all_digits",
			userMessage:
				"Include at least one non-digit character — digits alone won't work.",
		};
	}
	if (!USER_PROPERTY_SLUG_PATTERN.test(trimmed)) {
		return {
			ok: false,
			code: "illegal_format",
			userMessage:
				"Start with a letter or underscore, then use only letters, digits, underscores, and hyphens.",
		};
	}
	if (trimmed.length > USER_PROPERTY_SLUG_MAX_LENGTH) {
		return {
			ok: false,
			code: "too_long",
			userMessage: `Keep it to ${USER_PROPERTY_SLUG_MAX_LENGTH} characters or fewer.`,
		};
	}
	const lowered = trimmed.toLowerCase();
	const reservedPrefix = USER_DATA_RESERVED_PREFIXES.find((prefix) =>
		lowered.startsWith(prefix),
	);
	if (reservedPrefix !== undefined) {
		return {
			ok: false,
			code: "reserved",
			userMessage: `Names starting with "${reservedPrefix}" are reserved by CommCare. Try something like "team_${trimmed}".`,
		};
	}
	if (
		USER_DATA_SYSTEM_FIELDS.includes(lowered) ||
		RESERVED_CASE_PROPERTIES.has(lowered)
	) {
		return {
			ok: false,
			code: "reserved",
			userMessage: `"${trimmed}" is reserved by CommCare. Try something like "worker_${trimmed}".`,
		};
	}
	for (const claimed of existing) {
		if (claimed.toLowerCase() === lowered) {
			return {
				ok: false,
				code: "duplicate",
				userMessage: `"${trimmed}" is already in use. CommCare treats names as the same whatever their capitalization, so pick a different one.`,
			};
		}
	}
	return USER_PROPERTY_SLUG_OK;
}
