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
	assignedLocationUuids,
	asUuid,
	BUILT_IN_USER_PROPERTIES,
	COMMCARE_MOBILE_WORKER_USER_TYPE,
	COMMCARE_STANDARD_USER_TYPE,
	declaredUsercaseSlots,
	mergeOwnRecords,
	type Persona,
	personaUserData,
	recordFromEntries,
	splitWorkerName,
	type UserCollections,
	type Uuid,
	usercaseBuiltInValues,
	usercaseValuesBySlug,
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
	/** Stable custom-property identity → current worker-data wire slug. */
	readonly userPropertySlugs: Readonly<Record<string, string>>;
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
	userPropertySlugs: {},
};

/**
 * The framework keys CommCare injects into `session/user/data` AFTER the
 * authored data, so they win every collision
 * (`users/models.py::CouchUser.get_user_session_data`).
 *
 * Only the ones Nova can honestly know are emitted. `commcare_project` is
 * the HQ domain, so it appears exactly when a deployment has put this app
 * on one project space and stays ABSENT otherwise — including when two
 * project spaces hold it, where picking one would be a guess. Inventing a
 * slug to make a condition pass is exactly the dishonesty the preview
 * contract forbids. First name, last name, and phone number are
 * different: HQ writes all three keys unconditionally, so Preview preserves
 * their present-empty shape when Nova has no value. The location keys are absent while
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
function frameworkSessionKeys(
	displayName: string,
	projectSpace: string | null,
): Record<string, string> {
	const { first, last } = splitWorkerName(displayName);
	return {
		commcare_first_name: first,
		commcare_last_name: last,
		commcare_phone_number: "",
		commcare_user_type: COMMCARE_MOBILE_WORKER_USER_TYPE,
		commcare_profile: "",
		user_type: COMMCARE_STANDARD_USER_TYPE,
		...(projectSpace === null ? {} : { commcare_project: projectSpace }),
	};
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
	projectSpace: string | null,
): Pick<ResolvedPreviewIdentity, "session" | "usercase"> {
	const declared = declaredUsercaseSlots(doc);
	const values = usercaseValuesBySlug(authored, doc);
	return {
		session: {
			context: {
				userid: worker.id,
				username: worker.username,
				deviceid: "nova-preview",
				appversion: "preview",
			},
			user: mergeOwnRecords(
				declared,
				values,
				frameworkSessionKeys(worker.personName, projectSpace),
			),
			userPropertySlugs: recordFromEntries(
				Object.values(userPropertiesOf(doc)).map(
					(property) => [property.uuid, property.slug] as const,
				),
			),
		},
		usercase: mergeOwnRecords(
			declared,
			values,
			usercaseBuiltInValues(worker, projectSpace),
		),
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
	projectSpace: string | null = null,
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
			projectSpace,
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
	projectSpace: string | null = null,
): ResolvedPreviewIdentity | null {
	if (user === null || user === undefined) return null;
	if (user.id.trim() === "") return null;

	const projected = projections(
		{
			id: persona.uuid,
			username: persona.name,
			personName: persona.name,
			email: "",
		},
		personaUserData(persona, doc),
		doc,
		projectSpace,
	);
	const locationIds = assignedLocationUuids(persona.locations);
	const primary = locationIds[0];
	const locationSession: Record<string, string> =
		primary === undefined
			? {}
			: {
					commcare_location_id: primary,
					commcare_location_ids: locationIds.join(" "),
					commcare_primary_case_sharing_id: primary,
				};
	const locationUsercase = {
		commcare_location_id: primary ?? "",
		commcare_location_ids: locationIds.join(" "),
		commcare_primary_case_sharing_id: primary ?? "",
	};

	return {
		actorUserId: user.id,
		ownerId: persona.uuid,
		personaUuid: persona.uuid,
		session: {
			...projected.session,
			user: mergeOwnRecords(projected.session.user, locationSession),
		},
		usercase: mergeOwnRecords(projected.usercase, locationUsercase),
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

/** Project the serializable identity record into emitter/compiler bindings. */
export function previewUserPropertySlugMap(
	session: PreviewSearchSessionValues,
): ReadonlyMap<Uuid, string> {
	return new Map(
		Object.entries(session.userPropertySlugs).map(([uuid, slug]) => [
			asUuid(uuid),
			slug,
		]),
	);
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
		sameStringRecord(
			a.session.userPropertySlugs,
			b.session.userPropertySlugs,
		) &&
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
