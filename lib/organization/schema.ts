// lib/organization/schema.ts
//
// Input legality for the locations store, and the site-code derivation.
//
// Every rule here is a rule CommCare applies to the same string, so a place
// Nova accepts is a place a push can create. Nova is stricter in exactly one
// place — a create-once site code — and that is a Nova identity decision
// rather than a platform limit; see `SITE_CODE_PATTERN`.

import { z } from "zod";
import { uuidSchema } from "@/lib/domain";
import { OrganizationError } from "./errors";
import type { OrganizationRevision } from "./types";

/**
 * How many places one app's organization holds.
 *
 * Declared Nova policy, not a platform limit. It is what makes the whole
 * tree a bounded read — every authoring surface loads the organization in
 * one snapshot, which is only honest with a ceiling — and it is generous
 * enough for the real trees this exists to serve, where leaf levels run to
 * thousands of nodes.
 *
 * The bound that actually governs a device is not this one: it is the
 * per-worker FOOTPRINT, which the address book scopes and unit 9's fixture
 * budget bounds. An app may legitimately hold far more places than any one
 * worker ever carries — that gap is the point of the address-book dials.
 */
export const MAX_LOCATIONS_PER_APP = 10_000;

/** `SQLLocation.site_code` is `models.CharField(max_length=255)`. */
export const SITE_CODE_MAX_LENGTH = 255;

/** `SQLLocation.name` is `models.CharField(max_length=255)`. */
export const LOCATION_NAME_MAX_LENGTH = 255;

/** `SQLLocation.external_id` is `models.CharField(max_length=255, null=True)`. */
export const EXTERNAL_ID_MAX_LENGTH = 255;

/**
 * `locations/util.py::validate_site_code` requires `^[-_\w\d]+$` after
 * lowercasing, rejecting spaces and punctuation with "The site code cannot
 * contain spaces or special characters."
 *
 * Nova stores the lowercased form and compares case-insensitively, which is
 * what HQ's API validator does (`site_code__iexact`) even though its database
 * constraint is case-sensitive. Matching the stricter of the two is what keeps
 * a push from failing on a collision Nova considered distinct.
 */
export const SITE_CODE_PATTERN = /^[-\w]+$/;

const siteCodeSchema = z
	.string()
	.min(1)
	.max(SITE_CODE_MAX_LENGTH)
	.regex(SITE_CODE_PATTERN);

/**
 * A coordinate, as an exact decimal string.
 *
 * Stored and carried as text rather than a number on purpose: a latitude is
 * an external datum that round-trips through the fixture verbatim
 * (`fixtures.py::_fill_in_location_element` string-coerces it), and parsing
 * it into a float would silently reshape a value Nova did not author.
 */
const coordinateSchema = z
	.string()
	.regex(/^-?\d{1,3}(\.\d{1,12})?$/, "A coordinate must be a plain decimal.");

/**
 * Custom-field values, keyed by location-property UUID.
 *
 * Text only, and empty text is legal — HQ's location metadata is a plain
 * JSON blob with no schema, and its fixture serializer emits every defined
 * field with empty text when unset. A missing key means a missing value;
 * there is no stored `null`, because absent and null would print identically
 * and only one of them can round-trip.
 */
/**
 * How many custom values one place may carry.
 *
 * The catalog is the real bound — a value can only mean something if a property
 * declares it — but the schema has to carry its own ceiling, because an
 * unbounded record is unbounded whatever the catalog says.
 */
export const MAX_LOCATION_VALUES = 250;

const locationValuesSchema = z
	.record(
		// Keyed on the property UUID, not any string. The whole design rests on
		// that, and `shedRemovedLocationPropertyValues` only ever removes keys that
		// were once declared properties — so a key that was never a uuid is
		// unreachable by the shed AND by the catalog, permanent dead weight on a row
		// every read carries.
		uuidSchema,
		z
			.string()
			.max(4096)
			// Postgres `text` cannot hold a NUL, and an unpaired surrogate is not
			// valid UTF-8 — both fail at the driver rather than as a typed rejection
			// the author can read.
			.refine((value) => !value.includes("\u0000"), {
				message: "A value cannot contain a NUL character.",
			})
			.refine((value) => !/[\uD800-\uDFFF]/u.test(value), {
				message: "A value cannot contain an unpaired surrogate.",
			}),
	)
	.refine((values) => Object.keys(values).length <= MAX_LOCATION_VALUES, {
		message: "A place carries more information than Nova stores for one place.",
	});

export const createLocationInputSchema = z
	.object({
		levelUuid: uuidSchema,
		parentId: uuidSchema.nullable().default(null),
		name: z.string().trim().min(1).max(LOCATION_NAME_MAX_LENGTH),
		/** Omitted means Nova derives one from the name, as HQ does. */
		siteCode: siteCodeSchema.optional(),
		externalId: z.string().max(EXTERNAL_ID_MAX_LENGTH).nullable().default(null),
		latitude: coordinateSchema.nullable().default(null),
		longitude: coordinateSchema.nullable().default(null),
		values: locationValuesSchema.default({}),
		/** Place it after this sibling; omitted appends. */
		/** `null` means first; omitted means append. */
		afterSiblingId: uuidSchema.nullable().optional(),
	})
	.strict();
export type CreateLocationInput = z.infer<typeof createLocationInputSchema>;

/**
 * A patch over one place. Every slot is optional, and `null` clears the
 * clearable ones — the same wire discipline blueprint patches use, and for
 * the same reason: `JSON.stringify` drops `undefined`-valued keys, so a
 * clear can only cross a Server Action boundary as an explicit `null`.
 *
 * `siteCode` is deliberately absent. It is a create-once external identity,
 * so a rename never touches it. That also closes an upstream trap: HQ's v0.6
 * `LocationResource._update` REGENERATES `site_code` on any request carrying
 * a new `name` without one, so a Nova rename that let the code drift would
 * be a rename that silently repointed the bulk-upload key on the next push.
 * Unit 12 must always send the stored code.
 */
export const updateLocationInputSchema = z
	.object({
		name: z.string().trim().min(1).max(LOCATION_NAME_MAX_LENGTH).optional(),
		externalId: z.string().max(EXTERNAL_ID_MAX_LENGTH).nullable().optional(),
		latitude: coordinateSchema.nullable().optional(),
		longitude: coordinateSchema.nullable().optional(),
		/** A whole-bag replacement; a cleared field is an omitted key. */
		values: locationValuesSchema.optional(),
		/** Retype. Legal only while the place is a leaf — see the service. */
		levelUuid: uuidSchema.optional(),
	})
	.strict();
export type UpdateLocationInput = z.infer<typeof updateLocationInputSchema>;

/**
 * The organization clock, as it crosses every application boundary.
 *
 * A canonical nonnegative decimal string within signed-int64 range. Postgres
 * returns `bigint` as a string and this keeps it one: `Number` would round
 * past 2^53, and a lexical comparison of two decimal strings of different
 * lengths is simply wrong.
 */
const CANONICAL_DECIMAL = /^(0|[1-9]\d*)$/;
const INT64_MAX = "9223372036854775807";

export const organizationRevisionSchema = z
	.string()
	.regex(CANONICAL_DECIMAL, "A revision must be a canonical decimal string.")
	.refine(
		(value) =>
			// Re-tested rather than assumed: Zod runs every check in the chain
			// even after an earlier one fails, so this receives values the regex
			// already rejected. Comparing them numerically would THROW rather
			// than add an issue, turning a malformed argument into a 500.
			!CANONICAL_DECIMAL.test(value) ||
			value.length < INT64_MAX.length ||
			(value.length === INT64_MAX.length && value <= INT64_MAX),
		{ message: "A revision must fit in a signed 64-bit integer." },
	);

export function parseOrganizationRevision(
	value: unknown,
): OrganizationRevision {
	const parsed = organizationRevisionSchema.safeParse(
		typeof value === "number" ? String(value) : value,
	);
	if (!parsed.success) {
		throw new Error("Organization revision was not a canonical decimal.");
	}
	return parsed.data;
}

/**
 * Derive a site code from a place's name, avoiding the codes already taken.
 *
 * Shaped after `commtrack/util.py::generate_code` — slugify, collapse runs of
 * non-word characters to `_`, strip leading and trailing `_`, then increment a
 * numeric suffix until unused — but deliberately NOT byte-identical to it, and
 * the difference is safe for a specific reason. HQ derives a code only when
 * one is omitted; Nova's codes are create-once and every push sends the stored
 * one explicitly, so the two derivations never have to agree on an answer.
 * Nothing downstream compares them.
 *
 * Three known divergences, recorded so nobody later "fixes" one into a
 * behaviour change: HQ's suffix starts at `1` and Nova's at `2`; HQ strips
 * digits out of the slug body and re-seeds the suffix from trailing digits in
 * the name (`Clinic 2` -> `clinic2`), while Nova keeps digits in place; and HQ
 * transliterates through `unidecode` where Nova strips combining marks, which
 * agrees on accented Latin and differs on scripts `unidecode` romanizes.
 *
 * The fallback matters more than it looks: a name made entirely of characters
 * the slug charset drops — every name in a non-Latin script, under Nova's
 * mark-stripping — would otherwise derive the empty string and fail the
 * pattern HQ validates against. `place` is what it becomes, then deduped like
 * any other.
 */
export function deriveSiteCode(
	name: string,
	taken: ReadonlySet<string>,
): string {
	const base =
		name
			.normalize("NFKD")
			// Drop combining marks, so an accented Latin name slugifies to its
			// unaccented form rather than losing the letter entirely.
			.replace(/\p{M}+/gu, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "")
			.slice(0, SITE_CODE_MAX_LENGTH - 8) || "place";
	if (!taken.has(base)) return base;
	for (let suffix = 2; ; suffix++) {
		const candidate = `${base}${suffix}`;
		if (!taken.has(candidate)) return candidate;
	}
}

/** Reject a site code a caller supplied that collides case-insensitively. */
export function assertSiteCodeFree(
	siteCode: string,
	taken: ReadonlySet<string>,
): void {
	if (taken.has(siteCode.toLowerCase())) {
		throw new OrganizationError(
			"rejected",
			`Another place already uses the code "${siteCode}". A place's code has to be unique across the app, because it is how bulk uploads and CommCare identify it.`,
		);
	}
}
