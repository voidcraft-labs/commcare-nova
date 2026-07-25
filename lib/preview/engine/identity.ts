// lib/preview/engine/identity.ts
//
// ResolvedPreviewIdentity — the one identity contract every preview surface
// speaks: Search and Results session evaluation, form XPath `#user/*`, the
// SQL compiler's session bindings, and the acting user behind case writes
// all derive from a single resolved identity instead of ad-hoc projections.
//
// TWO IDS, AND THEY ARE NOT INTERCHANGEABLE. `actorUserId` is the signed-in
// Nova member: it is the ONLY thing that ever authorizes anything, and it
// is always a real account. `ownerId` is the CommCare worker the preview is
// acting AS: the value stamped on `owner_id` when the preview writes a case
// row, and the value `session/context/userid` resolves to. Previewing as
// yourself makes them the same string; previewing as a persona makes
// `ownerId` that persona's UUID while `actorUserId` stays you. Keying an
// authorization decision on `ownerId` would let an authored blueprint value
// choose whose data a request may read — `__tests__/identity.test.ts` pins
// that they cannot be conflated.
//
// Providers are the only constructors of the type. Server Actions resolve
// the identity at their own boundary and never accept one from the client;
// a persona is named by UUID and resolved against the COMMITTED blueprint,
// so a client can select an identity but never assert one.
//
// The identity carries TWO projections of the same worker, because the wire
// has two. `session` is `instance('commcaresession')/session/…`, built by
// `commcare-core .../SessionInstanceBuilder.java::addMetadata` +
// `::addUserProperties` from the restore's registration block. `usercase` is
// the `commcare-user` case that `#user/<prop>` reads, built independently by
// `commcare-hq .../callcenter/sync_usercase.py::_get_user_case_fields`. They
// share the authored user data and differ in their built-in keys, so
// collapsing them would make one of the two lie.

import {
	BUILT_IN_USER_PROPERTIES,
	COMMCARE_MOBILE_WORKER_USER_TYPE,
	COMMCARE_STANDARD_USER_TYPE,
	type Persona,
	personaUserData,
	type UserCollections,
	userPropertiesOf,
} from "@/lib/domain";
import type { SessionContextField } from "@/lib/domain/predicate";

/**
 * The session slices a preview expression can read on the device: the
 * closed-namespace context fields and the open-namespace user-data map.
 *
 * User-data keys are ABSENT when the worker has no value — never coerced
 * to an empty string — preserving the wire's absent-node comparison split.
 * Each evaluation layer applies its own documented blank fallback where
 * the device would read an absent node as blank.
 */
export interface PreviewSearchSessionValues {
	readonly context: Readonly<Partial<Record<SessionContextField, string>>>;
	readonly user: Readonly<Record<string, string>>;
}

/** Narrow user shape shared by Better Auth's client and server session. */
export interface PreviewSessionUser {
	readonly id: string;
	readonly name?: string | null;
	readonly email?: string | null;
}

/**
 * One resolved identity for the whole preview runtime.
 *
 * `actorUserId` authorizes; `ownerId` owns. `session` and `usercase` are
 * the two wire projections of the same worker. `personaUuid` is present
 * only while previewing as a named persona, and exists so surfaces can say
 * whose session they are showing.
 */
export interface ResolvedPreviewIdentity {
	readonly actorUserId: string;
	readonly ownerId: string;
	readonly session: PreviewSearchSessionValues;
	readonly usercase: Readonly<Record<string, string>>;
	readonly personaUuid?: string;
}

/**
 * The signed-out projection: device context only, no user values. This is
 * NOT an identity — it exists so client surfaces can evaluate session
 * expressions before hydration resolves the real session, reading every
 * user-backed slice as absent.
 */
const ANONYMOUS_SESSION_VALUES: PreviewSearchSessionValues = {
	context: {
		deviceid: "nova-preview",
		appversion: "preview",
	},
	user: {},
};

/** Split a display name the way an HQ profile's first/last name divides. */
function splitName(name: string): { first: string; last: string } {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	return { first: parts[0] ?? "", last: parts.slice(1).join(" ") };
}

/** Drop empty values so an absent key stays absent rather than blank. */
function nonEmpty(
	entries: readonly (readonly [string, string])[],
): Record<string, string> {
	return Object.fromEntries(entries.filter(([, value]) => value !== ""));
}

/**
 * The framework keys CommCare injects into `session/user/data` AFTER the
 * authored data, so they win every collision
 * (`users/models.py::CouchUser.get_user_session_data`).
 *
 * Only the ones Nova can honestly know are emitted. `commcare_project` is
 * the HQ domain and stays ABSENT until a deployment target supplies one —
 * inventing a slug to make a condition pass is exactly the dishonesty the
 * preview contract forbids. `commcare_phone_number` comes from the HQ
 * account and is likewise absent. The location keys are absent while
 * nobody is assigned anywhere, which is what HQ does too:
 * `get_user_session_data` writes all three or none.
 *
 * `commcare_profile` IS emitted, empty — not by this function but by
 * `UserData.to_dict`, which always includes the slot
 * (`user_data.py::UserData._provided_by_system`). Nova deliberately does
 * not use profiles, so empty is the true value rather than a missing one.
 *
 * `user_type` is emitted too, and it is the one key the RESTORE does not
 * decide. HQ sends it only for a practice user, but the client seeds it:
 * every `commcare-core .../User.java` constructor calls
 * `setUserType(STANDARD)` — a plain `properties.put` — and
 * `UserXmlParser::parse` builds the User before applying any `<data key>`.
 * So the device always has it, `"standard"` for an ordinary worker, and
 * leaving it absent here would make a condition on it fire on a device and
 * not in Preview.
 */
function frameworkSessionKeys(displayName: string): Record<string, string> {
	const { first, last } = splitName(displayName);
	return {
		...nonEmpty([
			["commcare_first_name", first],
			["commcare_last_name", last],
		]),
		commcare_user_type: COMMCARE_MOBILE_WORKER_USER_TYPE,
		commcare_profile: "",
		user_type: COMMCARE_STANDARD_USER_TYPE,
	};
}

/**
 * The usercase's built-in fields, from
 * `callcenter/sync_usercase.py::_get_user_case_fields`. These are the
 * unprefixed names `#user/<prop>` reads — a DIFFERENT set from the session
 * block's `commcare_`-prefixed keys, which is the whole reason the two
 * projections exist separately.
 *
 * `commcare_project` is absent here for the same reason it is absent from
 * the session block. `language` and `last_device_id_used` are HQ account
 * settings Nova does not model, and HQ writes them as empty strings, so
 * they are emitted empty rather than invented.
 *
 * The three location keys behave DIFFERENTLY here than in the session
 * block, and the difference is easy to get wrong: `_get_user_case_fields`
 * writes all three unconditionally, taking the `else` branch to `''` when
 * the worker has no location, where `get_user_session_data` omits them
 * entirely. So the usercase carries them empty and the session block does
 * not carry them at all. `commcare_profile` rides in the same way it does
 * on the session side — the dict starts from `UserData.to_dict()`, which
 * always includes the slot, and it survives the valid-XML-name filter.
 */
function usercaseBuiltIns(worker: {
	id: string;
	username: string;
	personName: string;
	email: string;
}): Record<string, string> {
	const { first, last } = splitName(worker.personName);
	return {
		...nonEmpty([
			["name", worker.personName],
			["username", worker.username],
			["email", worker.email],
			["first_name", first],
			["last_name", last],
		]),
		hq_user_id: worker.id,
		language: "",
		phone_number: "",
		last_device_id_used: "",
		commcare_profile: "",
		commcare_location_id: "",
		commcare_location_ids: "",
		commcare_primary_case_sharing_id: "",
	};
}

/**
 * Every DECLARED property, seeded blank.
 *
 * HQ's `users/user_data.py::UserData.to_dict` starts from
 * `{field: '' for field in self._schema_fields}` before layering authored
 * values on top, so a property the app declares but this worker has no
 * value for arrives as a present, empty node — while an undeclared key is
 * genuinely absent. Reproducing that split is what makes a `= ''`
 * comparison behave the same in Preview as on a device.
 */
function declaredPropertySlots(doc: UserCollections): Record<string, string> {
	const slots: Record<string, string> = {};
	for (const property of Object.values(userPropertiesOf(doc))) {
		slots[property.slug] = "";
	}
	return slots;
}

/** Authored values keyed by slug rather than by property UUID. */
function authoredBySlug(
	values: Record<string, string>,
	doc: UserCollections,
): Record<string, string> {
	const properties = userPropertiesOf(doc);
	const bySlug: Record<string, string> = {};
	for (const [propertyUuid, value] of Object.entries(values)) {
		const property = properties[propertyUuid];
		if (property !== undefined) bySlug[property.slug] = value;
	}
	return bySlug;
}

/**
 * Build both wire projections for one worker.
 *
 * The layering is CommCare's: declared slots blank, authored values over
 * them, framework keys last so they win every collision — the exact order
 * `get_user_session_data` writes in.
 */
function projections(
	worker: {
		id: string;
		/** The login handle — `session/context/username` and the usercase's. */
		username: string;
		/** The human name the first/last split comes from. */
		personName: string;
		email: string;
	},
	authored: Record<string, string>,
	doc: UserCollections,
): Pick<ResolvedPreviewIdentity, "session" | "usercase"> {
	const declared = declaredPropertySlots(doc);
	const values = authoredBySlug(authored, doc);
	return {
		session: {
			context: {
				userid: worker.id,
				username: worker.username,
				deviceid: "nova-preview",
				appversion: "preview",
			},
			user: {
				...declared,
				...values,
				...frameworkSessionKeys(worker.personName),
			},
		},
		usercase: {
			...declared,
			...values,
			...usercaseBuiltIns(worker),
		},
	};
}

/**
 * Preview as the signed-in member. The member is both the actor and the
 * worker, so their own case rows are the ones the preview reads and
 * writes and owner-scoped expressions behave truthfully.
 *
 * Refuses (returns `null`) without a persisted user id — the seam every
 * provider shares, so nothing downstream ever handles an unpersisted
 * actor. A member carries no authored user data: they are a Nova account,
 * not a worker the app defines, so every declared property reads as the
 * blank a worker without a value would have.
 */
export function previewAsMe(
	user: PreviewSessionUser | null | undefined,
	doc: UserCollections = {},
): ResolvedPreviewIdentity | null {
	if (user === null || user === undefined) return null;
	if (user.id.trim() === "") return null;

	const email = user.email?.trim() ?? "";
	const name = user.name?.trim() ?? "";

	return {
		actorUserId: user.id,
		ownerId: user.id,
		...projections(
			{
				id: user.id,
				username: email || name || user.id,
				personName: name || email || user.id,
				email,
			},
			{},
			doc,
		),
	};
}

/**
 * Preview as a named persona: the signed-in member still authorizes, but
 * the app runs as that persona.
 *
 * The persona's UUID is its CommCare identity — cases the preview creates
 * are owned by it, and `session/context/userid` resolves to it — so a
 * case list filtered to the current user shows that persona's caseload
 * rather than the member's. Its user data is the role's defaults with the
 * persona's own overrides on top.
 *
 * Refuses without a persisted actor for the same reason `previewAsMe`
 * does: a persona never authorizes anything on its own.
 */
export function previewAsPersona(
	user: PreviewSessionUser | null | undefined,
	persona: Persona,
	doc: UserCollections,
): ResolvedPreviewIdentity | null {
	if (user === null || user === undefined) return null;
	if (user.id.trim() === "") return null;

	return {
		actorUserId: user.id,
		ownerId: persona.uuid,
		personaUuid: persona.uuid,
		...projections(
			{
				id: persona.uuid,
				username: persona.name,
				personName: persona.name,
				email: "",
			},
			personaUserData(persona, doc),
			doc,
		),
	};
}

/**
 * Project an identity — or its absence — into the session vocabulary
 * expression evaluation reads. `null` yields the anonymous projection.
 */
export function previewSessionValues(
	identity: ResolvedPreviewIdentity | null,
): PreviewSearchSessionValues {
	return identity?.session ?? ANONYMOUS_SESSION_VALUES;
}

/**
 * The built-in properties Nova cannot honestly supply while the app has
 * only been previewed — the ones an authoring surface should label rather
 * than let an author write a condition against and watch it never fire.
 */
export const UNAVAILABLE_BUILT_IN_USER_PROPERTIES =
	BUILT_IN_USER_PROPERTIES.filter(
		(property) =>
			property.availability !== "derived" &&
			property.availability !== "constant",
	).map((property) => property.slug);

/**
 * Material equality over the resolved identity — used to distinguish a
 * re-derived-but-identical identity (a session refetch minting new object
 * references) from a real identity change that must rebuild evaluation
 * state.
 */
export function samePreviewIdentity(
	a: ResolvedPreviewIdentity | null,
	b: ResolvedPreviewIdentity | null,
): boolean {
	if (a === null || b === null) return a === b;
	return (
		a.actorUserId === b.actorUserId &&
		a.ownerId === b.ownerId &&
		a.personaUuid === b.personaUuid &&
		sameStringRecord(a.session.context, b.session.context) &&
		sameStringRecord(a.session.user, b.session.user) &&
		sameStringRecord(a.usercase, b.usercase)
	);
}

function sameStringRecord(
	a: Readonly<Record<string, string | undefined>>,
	b: Readonly<Record<string, string | undefined>>,
): boolean {
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	return (
		aKeys.length === bKeys.length && aKeys.every((key) => a[key] === b[key])
	);
}
