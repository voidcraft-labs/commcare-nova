// lib/organization/schema.ts
//
// Input legality for the locations store, and the site-code derivation.
//
// Every rule here is a rule CommCare applies to the same string, so a place
// Nova accepts is a place a push can create. Nova is stricter in exactly one
// place — a create-once site code — and that is a Nova identity decision
// rather than a platform limit; see `SITE_CODE_PATTERN`.

import { z } from "zod";
import {
	locationValueTextSchema,
	MAX_ATOMIC_LOCATION_DESCENDANTS,
	MAX_LOCATION_VALUES,
	uuidSchema,
} from "@/lib/domain";
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

export { MAX_ATOMIC_LOCATION_DESCENDANTS } from "@/lib/domain";

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

export const siteCodeSchema = z
	.string()
	.min(1)
	.max(SITE_CODE_MAX_LENGTH)
	.regex(SITE_CODE_PATTERN);

/**
 * A coordinate, as one canonical decimal string.
 *
 * HQ stores both coordinates as `DecimalField(max_digits=20,
 * decimal_places=10)`. Nova never parses through a JavaScript number, but it
 * does canonicalize the spelling: no redundant leading/trailing zeroes and no
 * negative zero. Postgres uses the matching numeric typmod; reads pass through
 * the same normalizer because the driver preserves the column scale.
 */
const COORDINATE_PATTERN = /^-?(?:0|[1-9]\d{0,2})(?:\.\d{1,10})?$/;

export function canonicalCoordinate(value: string): string {
	const negative = value.startsWith("-");
	const unsigned = negative ? value.slice(1) : value;
	const [whole, fraction] = unsigned.split(".");
	const trimmedFraction = fraction?.replace(/0+$/, "") ?? "";
	const magnitude =
		trimmedFraction === "" ? whole : `${whole}.${trimmedFraction}`;
	return negative && magnitude !== "0" ? `-${magnitude}` : magnitude;
}

const coordinateSchema = z
	.string()
	.regex(
		COORDINATE_PATTERN,
		"A coordinate must be a canonical decimal with at most 10 decimal places.",
	)
	.transform(canonicalCoordinate);

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
export { MAX_LOCATION_VALUES } from "@/lib/domain";

export const locationValuesSchema = z
	.record(
		// Keyed on the property UUID, not any string. The whole design rests on
		// that, and `shedRemovedLocationPropertyValues` only ever removes keys that
		// were once declared properties — so a key that was never a uuid is
		// unreachable by the shed AND by the catalog, permanent dead weight on a row
		// every read carries.
		uuidSchema,
		locationValueTextSchema,
	)
	.refine((values) => Object.keys(values).length <= MAX_LOCATION_VALUES, {
		message: "A place carries more information than Nova stores for one place.",
	});

const locationValuePatchSchema = z
	.record(uuidSchema, locationValueTextSchema.nullable())
	.refine((values) => Object.keys(values).length === 1, {
		message: "Change exactly one place-information value at a time.",
	});

const locationNameSchema = z
	.string()
	.trim()
	.min(1)
	.max(LOCATION_NAME_MAX_LENGTH)
	.refine((value) => !value.includes("\u0000"), {
		message: "A place name cannot contain a NUL character.",
	})
	.refine((value) => !/[\uD800-\uDFFF]/u.test(value), {
		message: "A place name cannot contain an unpaired surrogate.",
	});

const externalIdSchema = z
	.string()
	.max(EXTERNAL_ID_MAX_LENGTH)
	.refine((value) => !value.includes("\u0000"), {
		message: "An external ID cannot contain a NUL character.",
	})
	.refine((value) => !/[\uD800-\uDFFF]/u.test(value), {
		message: "An external ID cannot contain an unpaired surrogate.",
	});

const createLocationValueFields = {
	levelUuid: uuidSchema,
	name: locationNameSchema,
	/** Omitted means Nova derives one from the name, as HQ does. */
	siteCode: z.preprocess(
		(value) => (value === null ? undefined : value),
		siteCodeSchema.optional(),
	),
	externalId: externalIdSchema.nullable().default(null),
	latitude: coordinateSchema.nullable().default(null),
	longitude: coordinateSchema.nullable().default(null),
	values: locationValuesSchema
		.nullable()
		.optional()
		.transform((value) => value ?? {}),
} as const;

const createLocationValuesSchema = z.object(createLocationValueFields).strict();
type CreateLocationValues = z.output<typeof createLocationValuesSchema>;

export type CreateLocationDescendantInput = CreateLocationValues & {
	readonly descendants?: readonly CreateLocationDescendantInput[];
};

export const createLocationDescendantInputSchema: z.ZodType<CreateLocationDescendantInput> =
	z.lazy(() =>
		z
			.object({
				...createLocationValueFields,
				/** Structure is parentage; no second identity vocabulary is needed. */
				descendants: z
					.array(createLocationDescendantInputSchema)
					.max(MAX_ATOMIC_LOCATION_DESCENDANTS)
					.optional(),
			})
			.strict(),
	);

function preflightAtomicLocationDescendants(
	value: unknown,
	ctx: z.RefinementCtx,
): unknown {
	if (!Array.isArray(value)) return value;
	let count = 0;
	const pending: unknown[] = [...value];
	while (pending.length > 0) {
		const descendant = pending.pop();
		count += 1;
		if (count > MAX_ATOMIC_LOCATION_DESCENDANTS) {
			ctx.addIssue({
				code: "custom",
				message: `One create may add at most ${MAX_ATOMIC_LOCATION_DESCENDANTS} descendants. Split a larger import into bounded branches.`,
			});
			return value;
		}
		if (
			typeof descendant !== "object" ||
			descendant === null ||
			!("descendants" in descendant)
		) {
			continue;
		}
		const nested = (descendant as { readonly descendants?: unknown })
			.descendants;
		if (Array.isArray(nested)) pending.push(...nested);
	}
	return value;
}

export const createLocationInputSchema = z
	.object({
		...createLocationValueFields,
		parentId: uuidSchema.nullable().default(null),
		/** Place it after this sibling; omitted appends. */
		/** `null` means first; omitted means append. */
		afterSiblingId: uuidSchema.nullable().optional(),
		/**
		 * New descendants committed with this root. This is the born-valid path
		 * for growing an organization while a reverse-hop owner rule requires a
		 * destination below every new source place.
		 */
		descendants: z
			.preprocess(
				preflightAtomicLocationDescendants,
				z
					.array(createLocationDescendantInputSchema)
					.max(MAX_ATOMIC_LOCATION_DESCENDANTS),
			)
			.optional(),
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
		name: locationNameSchema.optional(),
		externalId: externalIdSchema.nullable().optional(),
		latitude: coordinateSchema.nullable().optional(),
		longitude: coordinateSchema.nullable().optional(),
		/** A whole-bag replacement; every omitted catalog value is cleared. */
		values: locationValuesSchema.optional(),
		/** A UUID-addressed partial edit. `null` clears just that saved value. */
		valuePatch: locationValuePatchSchema.optional(),
		/** Retype. Legal only while the place is a leaf — see the service. */
		levelUuid: uuidSchema.optional(),
		/** Atomic re-parent/reorder, so a legal retype is not forced through an
		 * impossible intermediate topology. Omitted keeps the current parent. */
		parentId: uuidSchema.nullable().optional(),
		/** null means first; omitted keeps the current order unless parent moves. */
		afterSiblingId: uuidSchema.nullable().optional(),
	})
	.strict()
	.refine(
		(input) => input.values === undefined || input.valuePatch === undefined,
		{ message: "Use either values or valuePatch, not both." },
	)
	.refine((input) => Object.keys(input).length > 0, {
		message: "Change at least one place field.",
	});
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

/** Stable payload an archive confirmation binds to. The writer recomputes it
 * under its own locks and refuses if any consequence changed. */
export const ARCHIVE_IMPACT_PREVIEW_TEXT_MAX_LENGTH = 255;

export const archiveImpactSchema = z
	.object({
		revision: organizationRevisionSchema,
		confirmationToken: z.string().regex(/^[a-f0-9]{64}$/),
		affectedLocationCount: z.number().int().nonnegative(),
		unassignedPersonaCount: z.number().int().nonnegative(),
		unassignedPersonaPreview: z
			.array(z.string().max(ARCHIVE_IMPACT_PREVIEW_TEXT_MAX_LENGTH))
			.max(10),
		ownedCases: z.number().int().nonnegative(),
		blockingOwnerRuleFormCount: z.number().int().nonnegative(),
		blockingOwnerRuleFormPreview: z
			.array(z.string().max(ARCHIVE_IMPACT_PREVIEW_TEXT_MAX_LENGTH))
			.max(10),
	})
	.strict();

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
