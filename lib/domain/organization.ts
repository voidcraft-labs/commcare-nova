// lib/domain/organization.ts
//
// Where people work: the organization levels an app defines, and the
// custom-field catalog the places at those levels carry.
//
// A LEVEL is a rung in the organization — District, Facility, Ward. A
// LOCATION is a place at one of those rungs, and locations do not live
// here: they are app-scoped Postgres rows (`lib/organization`), because a
// tree can run to thousands of nodes and is often fed from outside Nova
// entirely. The blueprint owns the SHAPE of the organization; the store
// owns its CONTENTS. That split is why removing a level has to consult
// the store transactionally rather than reading the document alone.
//
// ── What CommCare actually does with all this ────────────────────────
//
// HQ's `locations/models.py::LocationType` is the level, and
// `::SQLLocation` the place. A location does three unrelated-looking jobs
// at once, and the whole design of this file follows from two of them
// being scoped INDEPENDENTLY:
//
//   - it OWNS cases — a location id is a legal `owner_id`, and which
//     locations a worker owns through decides what lands on their device;
//   - it is an ADDRESS BOOK ENTRY — the tree ships to every device as a
//     fixture that expressions query by level code and lineage.
//
// A place a worker can address is not a place whose cases they receive.
// Serious apps live in that gap: a level that owns without holding
// workers is a queue nothing syncs into anyone's restore, and a level
// that holds workers with thin ownership is what keeps their devices
// fast. So `caseFlow` and `addressBook` below are two separate
// authoring questions, and no field of one appears in the other.
//
// The third job — org-scoped web permissions
// (`locations/permissions.py::location_safe` and the restrict-access-by-
// location framework) — is an HQ console authorization axis with no wire
// representation at all. Nothing here models it.

import { z } from "zod";
import { CUSTOM_DATA_FIELD_LABEL_MAX_LENGTH } from "./customDataFieldLimits";
import { recordFromEntries } from "./records";
import { type Uuid, uuidSchema } from "./uuid";

// ── Level codes ──────────────────────────────────────────────────────

/**
 * `LocationType.code` is `models.SlugField(db_index=False, null=True)`,
 * so Django's slug charset applies — the same class
 * `custom_data_fields/edit_model.py::XmlSlugField` uses for property
 * slugs. It reaches the wire as the fixture element's `@type` and as the
 * `{code}_id` lineage attribute name
 * (`locations/fixtures.py::_fill_in_location_element`), so it must also
 * be a legal XML name part: a leading digit would produce the attribute
 * `2_id`, which no XPath can address.
 */
export const LEVEL_CODE_PATTERN = /^[a-zA-Z_][-a-zA-Z0-9_]*$/;

/** `LocationType.code` is a `SlugField`, whose default `max_length` is 50. */
export const LEVEL_CODE_MAX_LENGTH = 50;

/** `LocationType.name` is `models.CharField(max_length=255)`. */
export const LEVEL_NAME_MAX_LENGTH = 255;

// ── Case flow — which cases a worker receives ────────────────────────

/**
 * How far below their own place a worker's cases reach.
 *
 * `all` is HQ's `LocationType.view_descendants`. `down-to` additionally
 * sets `expand_view_child_data_to`, and that half is **toggle-gated on
 * the target domain**: the default owner-set path
 * (`users/models.py::CouchUser._get_case_owning_locations`) walks
 * `get_queryset_descendants(...)` with no depth bound at all, and only
 * the `USH_RESTORE_FILE_LOCATION_CASE_SYNC_RESTRICTION` arm runs the SQL
 * function that honours the bound. So a depth cap is a deployment
 * prerequisite rather than something a stock domain respects, and the
 * authoring surface says so rather than offering a dial that silently
 * does nothing.
 */
export const descendantCaseScopeSchema = z.discriminatedUnion("kind", [
	/** Only the worker's own places own cases for them. */
	z.object({ kind: z.literal("none") }).strict(),
	/** Every place below theirs, however deep. */
	z.object({ kind: z.literal("all") }).strict(),
	/** Every place below theirs, stopping at this level. */
	z.object({ kind: z.literal("down-to"), levelUuid: uuidSchema }).strict(),
]);
export type DescendantCaseScope = z.infer<typeof descendantCaseScopeSchema>;

/**
 * Whether places at this level hold workers and own cases.
 *
 * A discriminated union rather than three flags, because how far a
 * worker's cases reach is only a question where workers actually are:
 * HQ reads `view_descendants` off the type of a location a user is
 * ASSIGNED to, so on a level nobody can be assigned to it is inert. The
 * union makes that state unexpressible instead of validating against it.
 *
 * All four remaining combinations are real and named in the field:
 *
 *   - `none` + owns — a QUEUE. Cases live here and reach nobody's device
 *     by assignment, which is exactly how workflow records are kept off
 *     every worker's restore while staying addressable and searchable.
 *   - `assigned` + owns — an ordinary place people work out of.
 *   - `none` + owns nothing — pure structure, a rung that exists to be an
 *     ancestor.
 *   - `assigned` + owns nothing — an oversight rung: people sit here, the
 *     rung itself owns nothing, and everything they receive comes through
 *     `descendantCases`.
 *
 * HQ's `administrative` column is deliberately absent. It reads like the
 * inverse of "owns cases" and is not one: `LocationType.save` runs
 * `if not self.commtrack_enabled: self.administrative = True`, so on
 * every non-CommTrack domain — which is every domain Nova targets — it is
 * forced true regardless of what anyone authored. `has_user` (singular,
 * `default=False`) is dead; `has_users` (plural, `default=True`) is the
 * live one and is what `workers` compiles to.
 */
export const levelCaseFlowSchema = z.discriminatedUnion("workers", [
	z
		.object({
			workers: z.literal("none"),
			ownsCases: z.boolean(),
		})
		.strict(),
	z
		.object({
			workers: z.literal("assigned"),
			ownsCases: z.boolean(),
			descendantCases: descendantCaseScopeSchema,
		})
		.strict(),
]);
export type LevelCaseFlow = z.infer<typeof levelCaseFlowSchema>;

// ── Address book — which places a worker can see and name ────────────

/**
 * How much of the organization a worker at this level carries on their
 * device.
 *
 * This is the fixture's contents, and it is scoped entirely separately
 * from case flow above: widening it lets expressions NAME more places
 * without moving a single case.
 *
 * **Why this is a closed union of four rather than HQ's five dials.**
 * The scope is not computed in Python — it is one Postgres function,
 * `locations/sql_templates/get_location_fixture_ids.sql`, reached from
 * `locations/fixtures.py::_location_queryset_helper`. Its own header
 * comment enumerates configurations it calls "undefined outcomes", three
 * of which it asks for check constraints to prevent: `expand_from_root`
 * with `expand_from`, `include_without_expanding` with `expand_from`, and
 * `expand_from_root` being redundant with `include_without_expanding`.
 * Reading the query itself adds three more silent-precedence traps:
 * `include_only` makes it skip `expand_from` entirely, `expand_to` wins
 * over `include_only` in the depth `CASE` so setting both drops the
 * allowlist, and `expand_from_root` with `include_only` produces a
 * `loc_id IS NULL` row against an arm that requires a concrete location —
 * an empty fixture.
 *
 * So the five flags are not five independent dials. They are four
 * coherent configurations surrounded by states the platform does not
 * define. Nova admits the four and makes the rest unexpressible, which is
 * a stronger guarantee than validating against them: there is no
 * authoring state here whose fixture HQ could not name.
 *
 * All five are read from the type of the location the worker is ASSIGNED
 * to, never from each candidate location's own type — the query joins
 * `loc.id = ANY(user_location_ids_array)` to `loc_type` and reads them
 * all off that row.
 */
export const levelAddressBookSchema = z.discriminatedUnion("reach", [
	/**
	 * Their own place, everything under it, and the chain above it. HQ's
	 * default — no expand flags at all, which the query treats as
	 * unlimited expansion from the assigned location plus its un-expanded
	 * ancestors.
	 */
	z
		.object({
			reach: z.literal("own-branch"),
			/** Stop descending at this level (`expand_to`). */
			downToLevelUuid: uuidSchema.optional(),
			/** Also carry the top of the organization down to this level
			 *  (`include_without_expanding`). This composes with the deep own
			 *  branch above rather than replacing it, which is what makes it
			 *  irreplaceable by `whole-organization` — it is how a worker
			 *  carries a registry they will never own at while keeping their
			 *  own subtree in full. */
			alsoIncludeTopDownToLevelUuid: uuidSchema.optional(),
		})
		.strict(),
	/**
	 * Their own place, but only the named CONTIGUOUS levels below it. HQ's
	 * `include_only` is applied at every recursive step: a skipped type prevents
	 * traversal to every selected type beneath it, and omitting this level's own
	 * type omits the assigned place itself. Validation therefore requires this
	 * level plus every intermediate type leading to a selected descendant. The
	 * query honours `include_only` only when `expand_to` is unset — hence no
	 * `downToLevelUuid` on this arm.
	 */
	z
		.object({
			reach: z.literal("own-branch-limited"),
			levelUuids: z.array(uuidSchema).min(1),
			alsoIncludeTopDownToLevelUuid: uuidSchema.optional(),
		})
		.strict(),
	/**
	 * Everything under a level further up, so a worker can address sibling
	 * places — the other clinics in their district, say. HQ's
	 * `expand_from`, which the query ignores whenever `include_only` is
	 * set, hence the two are separate arms.
	 */
	z
		.object({
			reach: z.literal("shared-branch"),
			fromLevelUuid: uuidSchema,
			downToLevelUuid: uuidSchema.optional(),
		})
		.strict(),
	/**
	 * The whole organization. HQ's `expand_from_root`, whose setter
	 * (`LocationType.expand_from_root`) clears `expand_from` on the way in
	 * — the platform itself treats them as exclusive.
	 */
	z
		.object({
			reach: z.literal("whole-organization"),
			downToLevelUuid: uuidSchema.optional(),
		})
		.strict(),
]);
export type LevelAddressBook = z.infer<typeof levelAddressBookSchema>;

// ── The authored collections ─────────────────────────────────────────

/**
 * One rung of the organization.
 *
 * `code` is a create-once external identity and `name` is a display
 * projection that changes freely — the identity/projection split the
 * program applies everywhere. Both are app-unique, because
 * `LocationType.Meta.unique_together` is
 * `(('domain', 'code'), ('domain', 'name'))` and one Nova app compiles to
 * one domain's level set.
 *
 * `code` is create-once for a reason a rename cannot work around: it is
 * the fixture's `@type` and the `{code}_id` lineage attribute name, so
 * every authored expression that addresses a level addresses it by code.
 * Nova stores references as UUIDs and prints the current spelling, which
 * makes a rename safe INSIDE Nova — but a code that already reached a
 * device is a contract with data Nova did not author.
 *
 * `parentLevelUuid` absent means a root level. The graph is a FOREST and
 * may branch: `parent_type` is a nullable self-FK and `::has_children`
 * merely asks `filter(parent_type=self).exists()`, so two levels may
 * share one parent. Nothing here assumes a chain.
 */
export const organizationLevelSchema = z
	.object({
		uuid: uuidSchema,
		code: z
			.string()
			.min(1)
			.max(LEVEL_CODE_MAX_LENGTH)
			.regex(LEVEL_CODE_PATTERN),
		name: z.string().min(1).max(LEVEL_NAME_MAX_LENGTH),
		description: z.string().optional(),
		/** The level directly above. Absent means this is a root level. */
		parentLevelUuid: uuidSchema.optional(),
		caseFlow: levelCaseFlowSchema,
		addressBook: levelAddressBookSchema,
	})
	.strict();
export type OrganizationLevel = z.infer<typeof organizationLevelSchema>;

/**
 * One custom field every place can carry — the app's half of CommCare's
 * per-domain location data schema, compiling to one `Field` row on the
 * domain's `LocationFields` definition.
 *
 * Deliberately the same shape as `UserProperty` (`./users.ts`), because
 * HQ uses the same `custom_data_fields` machinery for both and splits
 * them only by `field_type`. The divergence belongs in the field type,
 * not the model. `regex` / `regex_msg` are absent here for the same
 * reason they are absent there: enforcement sits behind the paid
 * `REGEX_FIELD_VALIDATION` privilege, so an authored pattern would
 * silently not validate on a stock domain.
 *
 * `levelUuids` is the one addition — one app-wide catalog whose entries
 * may declare which levels they apply to. Absent means every level.
 *
 * Values live on the location rows, keyed by this `uuid` rather than by
 * `slug`, so renaming a slug rewrites nothing. That mirrors HQ, where
 * definitions live in `custom_data_fields` and values in a plain metadata
 * blob on `SQLLocation`. There is no `LocationFixtureDataField` model to
 * build to, and the indexed `data_<slug>` attribute shape that survives
 * in two orphaned HQ test files is a REMOVED feature (`index_in_fixture`)
 * — custom values reach the wire only as `<location_data>` children, never
 * as attributes, so they are never join keys.
 */
export const locationPropertySchema = z
	.object({
		uuid: uuidSchema,
		slug: z.string().min(1),
		label: z.string().min(1).max(CUSTOM_DATA_FIELD_LABEL_MAX_LENGTH),
		/**
		 * Whether a place must carry a value for this before it can be saved.
		 *
		 * Enforced by `lib/organization/valueCatalog.ts`, on location writes and
		 * catalog commits. The
		 * citation is not decoration: this field shipped once as a declaration
		 * with no enforcement anywhere, and **a schema field that promises a
		 * constraint it does not impose is worse than no field at all** — a
		 * missing feature gets discovered, a phantom one gets inherited by
		 * everyone who reads the schema and reasonably assumes the guarantee
		 * holds. Any constraint added beside these three names where it is
		 * enforced, or it is not a constraint.
		 */
		required: z.boolean().optional(),
		/** A closed set of accepted values; absent means free text. The shared
		 *  catalog check lets empty text through because
		 *  CommCare's fixture emits an empty element for an unset field. */
		choices: z
			.array(z.string().min(1))
			.refine((choices) => new Set(choices).size === choices.length, {
				message: "Accepted place-information values must be unique.",
			})
			.optional(),
		/** Which levels carry this field; absent means every level. Enforced in
		 *  the shared catalog check, against the level a place will HAVE, so
		 *  retyping a place into a level its information does not apply to is
		 *  refused rather than silently leaving values nothing will emit. */
		levelUuids: z.array(uuidSchema).min(1).optional(),
	})
	.strict();
export type LocationProperty = z.infer<typeof locationPropertySchema>;

/**
 * Where a persona works.
 *
 * ONE optional slot rather than two, and that is load-bearing rather than
 * tidy: HQ's `CommCareUserResource` rejects a primary location supplied
 * without its list and requires the primary to appear in the list, so two
 * independent slots could drift into a state no push can represent. As
 * one object they cannot, and "assigned nowhere" is simply the slot's
 * absence.
 *
 * **The two projections of an assignment disagree, and which one is asking
 * decides the right answer.** In the SESSION block
 * (`users/models.py::CouchUser.get_user_session_data`) all three of
 * `commcare_location_id`, `commcare_location_ids`, and
 * `commcare_primary_case_sharing_id` are written inside one
 * `if location_id := ...`, so an unassigned worker carries none of them. In
 * the USERCASE (`callcenter/sync_usercase.py::_get_user_case_fields`) the
 * same three are written unconditionally, empty-valued when there is no
 * assignment. "Absent" and "present but empty" are therefore both correct,
 * and a consumer that picks the wrong projection makes a condition pass
 * that should not — which is why preview resolves the two separately
 * rather than deriving one from the other.
 *
 * The uuids name rows in the app's locations store, not blueprint
 * entities, so they are validated against Postgres inside the commit
 * transaction and carried as exact reference edges — a location a persona
 * stands on cannot be deleted out from under it.
 *
 * `additionalUuids` never contains `primaryUuid`; the list CommCare
 * receives is the primary followed by these.
 */
export const personaLocationsSchema = z
	.object({
		primaryUuid: uuidSchema,
		additionalUuids: z.array(uuidSchema).min(1).optional(),
	})
	.strict();
export type PersonaLocations = z.infer<typeof personaLocationsSchema>;

// ── Reading the collections ──────────────────────────────────────────
//
// Both slots are optional on the doc and omitted when empty, so an app
// that declares no organization serializes byte-identically to one
// authored before these collections existed. These readers are the one
// place that absence collapses to an empty collection, so no call site
// hand-rolls `?? {}`.

export interface OrganizationCollections {
	readonly organizationLevels?: Record<string, OrganizationLevel>;
	readonly organizationLevelOrder?: readonly Uuid[];
	readonly locationProperties?: Record<string, LocationProperty>;
	readonly locationPropertyOrder?: readonly Uuid[];
}

export function organizationLevelsOf(
	doc: OrganizationCollections,
): Record<string, OrganizationLevel> {
	return doc.organizationLevels ?? recordFromEntries([]);
}

export function locationPropertiesOf(
	doc: OrganizationCollections,
): Record<string, LocationProperty> {
	return doc.locationProperties ?? recordFromEntries([]);
}

function inSequence<T>(
	record: Record<string, T>,
	order: readonly Uuid[] | undefined,
): T[] {
	const out: T[] = [];
	for (const uuid of order ?? []) {
		const entity = record[uuid];
		if (entity !== undefined) out.push(entity);
	}
	return out;
}

/** Organization levels in authored order. */
export function orderedOrganizationLevels(
	doc: OrganizationCollections,
): OrganizationLevel[] {
	return inSequence(organizationLevelsOf(doc), doc.organizationLevelOrder);
}

/** Custom place-information fields in authored order. */
export function orderedLocationProperties(
	doc: OrganizationCollections,
): LocationProperty[] {
	return inSequence(locationPropertiesOf(doc), doc.locationPropertyOrder);
}

/**
 * Every location uuid a persona's assignment names, primary first.
 *
 * The order is the order CommCare receives, so the primary leads — and a
 * single helper is what keeps the primary-must-be-in-the-list rule from
 * being restated (and mis-stated) at each of the emitter, the validator,
 * and the reference-edge extractor.
 */
export function assignedLocationUuids(
	locations: PersonaLocations | undefined,
): readonly string[] {
	if (locations === undefined) return [];
	return [locations.primaryUuid, ...(locations.additionalUuids ?? [])];
}

/**
 * Whether places at this level can own cases.
 *
 * One reader for the flag that decides whether an owner target is legal,
 * because it is spelled differently on the two `caseFlow` arms and every
 * consumer that re-destructures it is a place the two can disagree.
 */
export function levelOwnsCases(level: OrganizationLevel): boolean {
	return level.caseFlow.ownsCases;
}

/**
 * Whether workers can be assigned to places at this level.
 */
export function levelHoldsWorkers(level: OrganizationLevel): boolean {
	return level.caseFlow.workers === "assigned";
}

/**
 * How far below an assigned place its worker's cases reach.
 *
 * A level nobody is assigned to has no descendant scope at all — HQ reads
 * `view_descendants` off the assigned location's type, so the question is
 * meaningless there rather than answered `none`. Returning the `none`
 * scope keeps every caller on one shape.
 */
const NO_DESCENDANTS: DescendantCaseScope = { kind: "none" };

export function levelDescendantCases(
	level: OrganizationLevel,
): DescendantCaseScope {
	return level.caseFlow.workers === "assigned"
		? level.caseFlow.descendantCases
		: NO_DESCENDANTS;
}

/**
 * The levels above `level`, nearest first, stopping at the root.
 *
 * Tolerant of a broken chain by construction: an unknown or repeated
 * parent ends the walk rather than throwing or looping. The validator is
 * what refuses to COMMIT a cycle; this has to stay total because it also
 * runs over documents being repaired.
 */
export function ancestorLevels(
	level: OrganizationLevel,
	levels: Record<string, OrganizationLevel>,
): OrganizationLevel[] {
	const chain: OrganizationLevel[] = [];
	const seen = new Set<string>([level.uuid]);
	let current = level;
	while (current.parentLevelUuid !== undefined) {
		if (seen.has(current.parentLevelUuid)) break;
		const parent = levels[current.parentLevelUuid];
		if (parent === undefined) break;
		seen.add(parent.uuid);
		chain.push(parent);
		current = parent;
	}
	return chain;
}

/**
 * Whether a place at `childLevelUuid` may sit under a place at
 * `parentLevelUuid`.
 *
 * The rule is STRICT ANCESTRY, not immediate parentage — an intermediate
 * level may be skipped. That is a real hierarchy rather than a leniency:
 * health structures routinely have optional rungs, where some regions run
 * districts and some do not, and the fixture carries it faithfully because
 * every level's `{code}_id` attribute is blank-filled before self and each
 * ancestor are written (`fixtures.py::_get_fixture_node`). A facility with no
 * district emits `district_id=''`, and an expression joining on it finds
 * nothing — which is the truth.
 *
 * What strict ancestry rules out is a level repeating inside one chain, and
 * that has a concrete failure. The attribute writes in that same loop go
 * self-first then upward, each unconditionally assigning `{code}_id`, so an
 * ancestor sharing the child's code OVERWRITES the child's own id in its own
 * lineage attribute: a facility under another facility emits
 * `facility_id = <the parent's>`, and every two-hop join through that
 * attribute silently resolves to the wrong element. Two levels can never
 * share a code, so strict ancestry is exactly what keeps a chain's codes
 * distinct.
 *
 * One predicate, two consumers: the store enforces it and the authoring
 * surface's parent picker filters by it, so an author is never offered a
 * placement the store will refuse.
 *
 * **A skipped rung is a deployment constraint, not a wire one.** The future
 * location fixture can carry it faithfully, but HQ refuses to CREATE one.
 * Both its web form and its v0.6 location API route
 * through `util.py::get_location_type`, which admits only the types
 * `forms.py::LocationForm.get_allowed_types` returns for the chosen parent,
 * and that query filters `parent_type=parent.location_type` — the immediate
 * child types alone. A push of a ragged tree therefore fails with "Location
 * type not valid for the selected parent." Nova still models the real
 * hierarchy rather than making an author invent a placeholder district whose
 * id every `district_id` join would then wrongly resolve; the constraint is
 * surfaced as a deployment prerequisite instead of being smuggled into the
 * data model.
 */
export function levelMayNestUnder(
	childLevelUuid: string,
	parentLevelUuid: string,
	levels: Record<string, OrganizationLevel>,
): boolean {
	const child = levels[childLevelUuid];
	if (child === undefined) return false;
	return ancestorLevels(child, levels).some(
		(ancestor) => ancestor.uuid === parentLevelUuid,
	);
}
