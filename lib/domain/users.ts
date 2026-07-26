// lib/domain/users.ts
//
// Who runs the app: the user-data property catalog, the reusable user
// types built on it, and the named preview personas that act as those
// types. Three separate collections because they answer three separate
// questions, and the distinction is load-bearing everywhere downstream:
//
//   - a USER PROPERTY is a slot workers carry data in — the app's half
//     of CommCare's per-domain custom user-data schema;
//   - a USER TYPE is a reusable role template that fills those slots
//     with default values ("every CHW carries cadre = community");
//   - a PERSONA is a named design/test actor with stable identity that
//     REFERENCES a user type and may override individual values. It is
//     who Preview runs as.
//
// A DEPLOYED WORKER — a real identity on a target HQ domain, with
// credentials and its own lifecycle — is deliberately absent. It is
// owned by a deployment, not by the blueprint, and is created FROM a
// type or persona rather than being one.
//
// ── What CommCare actually does with all this ────────────────────────
//
// HQ stores one `CustomDataFieldsDefinition` per `(domain, field_type)`
// (`custom_data_fields/models.py::CustomDataFieldsDefinition`, whose Meta
// declares `unique_together = ('domain', 'field_type')`); mobile and web
// users share `field_type = 'UserFields'`
// (`users/views/mobile/custom_data_fields.py::UserFieldsView`) and are
// split only by each field's `required_for`. So the catalog is per-app
// here and per-domain there — one Nova app's catalog compiles to that one
// definition.
//
// A worker's values reach the device through the restore's registration
// block: `users/models.py::CouchUser.get_user_session_data` starts from the
// authored user data and then `update()`s the framework keys over it — so
// the framework wins every collision — and the client's
// `commcare-core .../UserXmlParser.java::parse` writes every `<data key>`
// into `User.properties` verbatim. `SessionInstanceBuilder.java::addUserProperties`
// then exposes that map as `instance('commcaresession')/session/user/data/<slug>`.
// That injected set IS the built-in property catalog below, and it is also
// the reserved-name list — there is no second source for either.
//
// The same values additionally reach the device as the USERCASE, a
// different projection of one identity:
// `callcenter/sync_usercase.py::_get_user_case_fields` copies the authored
// user data (filtered to valid XML element names) and adds its own built-in
// keys — `name`, `username`, `email`, `language`, `phone_number`,
// `first_name`, `last_name`, `hq_user_id`, `commcare_project`, and the
// location keys. Those unprefixed names belong to the usercase and NOT to
// `session/user/data`; keeping the two projections apart is why
// `BUILT_IN_USER_PROPERTIES` carries only what the session block injects.

import { z } from "zod";
import { mergeOwnRecords, ownRecordSchema, ownRecordValue } from "./records";
import { type Uuid, uuidSchema } from "./uuid";

// ── Slug legality ────────────────────────────────────────────────────
//
// Enforced at construction so a push can never fail on identity grounds.
// Every clause is a rule HQ applies to the same string.

/**
 * `custom_data_fields/models.py::Field.slug` is `CharField(max_length=127)`.
 * The form field imposes no shorter bound, so 127 is the real ceiling.
 */
export const USER_PROPERTY_SLUG_MAX_LENGTH = 127;

/** `custom_data_fields/models.py::Field.label` is `CharField(max_length=255)`. */
export const USER_PROPERTY_LABEL_MAX_LENGTH = 255;

/**
 * Intersection of HQ's Django slug charset and the XML element-name shape
 * required by every emitted worker-data path. Django admits a leading digit or
 * hyphen, but those cannot begin the element Nova emits under
 * `session/user/data` and the usercase. The first character is therefore a
 * letter or underscore; subsequent characters retain Django's letters,
 * digits, underscores, and hyphens.
 */
export const USER_PROPERTY_SLUG_PATTERN = /^[a-zA-Z_][-a-zA-Z0-9_]*$/;

/**
 * Slugs predating HQ's `commcare` prefix convention, exempt from it and
 * refused outright (`custom_data_fields/models.py::SYSTEM_FIELDS`, checked
 * by `::validate_reserved_words`).
 */
export const USER_DATA_SYSTEM_FIELDS: readonly string[] = [
	"commtrack-supply-point",
	"name",
	"type",
	"owner_id",
	"external_id",
	"hq_user_id",
	"user_type",
];

/**
 * Prefixes HQ refuses so authored slugs can never shadow a framework key
 * or an XML-reserved name (`::validate_reserved_words`, which walks
 * `[SYSTEM_PREFIX, 'xml']`).
 */
export const USER_DATA_RESERVED_PREFIXES: readonly string[] = [
	"commcare",
	"xml",
];

// ── The built-in property catalog ────────────────────────────────────

/**
 * How truthfully Nova can show a built-in property's value while the app
 * is only being previewed.
 *
 * - `derived` — Nova knows it from the acting identity and shows it.
 * - `constant` — Nova knows it always has one value on a Nova-authored
 *   app and shows that value.
 * - `needs-deployment-target` — the value comes from the HQ domain the
 *   app is deployed to. Absent until a target supplies it; Nova never
 *   invents one to make a condition pass.
 * - `needs-organization` — the value comes from the worker's location
 *   assignment. Absent while the app declares no organization structure,
 *   exactly as HQ omits the key for an unassigned worker.
 * - `not-authorable` — Nova cannot author the account-backed value. When HQ
 *   guarantees the key, Preview preserves the slot as present and empty.
 */
export const BUILT_IN_USER_PROPERTY_AVAILABILITIES = [
	"derived",
	"constant",
	"needs-deployment-target",
	"needs-organization",
	"not-authorable",
] as const;
export type BuiltInUserPropertyAvailability =
	(typeof BUILT_IN_USER_PROPERTY_AVAILABILITIES)[number];

export interface BuiltInUserProperty {
	/** The wire key under `session/user/data/`. */
	readonly slug: string;
	/** Person-facing name for pickers and the catalog surface. */
	readonly label: string;
	/** What an author needs to know about the value, in their words. */
	readonly description: string;
	readonly availability: BuiltInUserPropertyAvailability;
	/**
	 * Whether the CommCare runtime itself reads the key, as opposed to
	 * merely carrying it for authored expressions. Only three do, and each
	 * has a verified reader.
	 */
	readonly readByRuntime: boolean;
}

/**
 * The properties CommCare injects into every worker's session, in the
 * order `get_user_session_data` writes them. This list is simultaneously
 * the built-in catalog authors pick from and the proof that no authored
 * slug can collide with one: every entry is refused by the slug rules
 * above, which `__tests__/users.test.ts` asserts rather than restates.
 *
 * Exactly three are read by the runtime. `user_type` drives demo
 * detection (`commcare-core .../User.java::getUserType`, consumed by
 * `commcare-android .../HomeScreenBaseActivity.java::isDemoUser` among
 * others); `commcare_project` and `commcare_location_ids` are read
 * together by `formplayer .../UserUtils.java::getUserLocationsByDomain`,
 * whose result drives the local case purge in
 * `formplayer .../RestoreFactory.java::getSqlSandbox` when a worker's
 * locations change. Everything else in `session/user/data` is inert —
 * it exists for authored expressions to read and nothing more.
 *
 * `user_type` is the one entry the restore does NOT decide. HQ sends it
 * only for a practice user, but the CLIENT seeds it: every
 * `commcare-core .../User.java` constructor calls `setUserType(STANDARD)`,
 * which is a plain `properties.put`, and `UserXmlParser::parse` builds the
 * User before applying any `<data key>`. So an ordinary worker's device
 * holds `user_type = "standard"` and a practice user's restore overwrites
 * it with `"demo"` — the key is never absent, on either runtime, which is
 * why Preview supplies it too.
 */
export const BUILT_IN_USER_PROPERTIES: readonly BuiltInUserProperty[] = [
	{
		slug: "user_type",
		label: "Account kind",
		description:
			"“standard” for an ordinary worker, “demo” for a practice user. CommCare sets it on the device rather than sending it, so it is always there.",
		availability: "constant",
		readByRuntime: true,
	},
	{
		slug: "commcare_project",
		label: "Project space",
		description:
			"The CommCare project the worker signed into. It is whatever domain you deploy to, so it stays empty until this app has a deployment target.",
		availability: "needs-deployment-target",
		readByRuntime: true,
	},
	{
		slug: "commcare_first_name",
		label: "First name",
		description: "The worker's first name, from their CommCare profile.",
		availability: "derived",
		readByRuntime: false,
	},
	{
		slug: "commcare_last_name",
		label: "Last name",
		description: "The worker's last name, from their CommCare profile.",
		availability: "derived",
		readByRuntime: false,
	},
	{
		slug: "commcare_phone_number",
		label: "Phone number",
		description:
			"The worker's phone number. It is set on their CommCare account; Preview carries the same key with an empty value.",
		availability: "not-authorable",
		readByRuntime: false,
	},
	{
		slug: "commcare_user_type",
		label: "Account type",
		description:
			"Always “commcare” — the value CommCare gives a mobile worker. Web-user accounts are not something this app creates.",
		availability: "constant",
		readByRuntime: false,
	},
	{
		slug: "commcare_profile",
		label: "User profile id",
		description:
			"Empty. Profiles are a separate paid CommCare feature this app does not use; every worker carries its slot as an empty value.",
		availability: "constant",
		readByRuntime: false,
	},
	{
		slug: "commcare_location_id",
		label: "Primary location",
		description:
			"The worker's primary location. It stays empty until this app has an organization structure and the persona is assigned somewhere in it.",
		availability: "needs-organization",
		readByRuntime: false,
	},
	{
		slug: "commcare_location_ids",
		label: "All locations",
		description:
			"Every location the worker is assigned to, separated by spaces. It stays empty until this app has an organization structure.",
		availability: "needs-organization",
		readByRuntime: true,
	},
	{
		slug: "commcare_primary_case_sharing_id",
		label: "Primary case-sharing group",
		description:
			"The same id as the primary location — CommCare repeats it under this name. It stays empty until this app has an organization structure.",
		availability: "needs-organization",
		readByRuntime: false,
	},
];

/**
 * `commcare_user_type`'s only value on a Nova-authored app.
 * `users/models.py::COMMCARE_USER` is `'commcare'`, and
 * `::CouchUser._get_user_type` returns it for every mobile worker. Nova
 * provisions mobile workers only, so the value is knowable rather than
 * invented.
 */
export const COMMCARE_MOBILE_WORKER_USER_TYPE = "commcare";

/**
 * `user_type`'s value for an ordinary worker.
 * `commcare-core .../User.java::STANDARD` — the client seeds it in every
 * constructor, so it is present on the device whether or not the restore
 * carried the key. A practice user's restore overwrites it with `"demo"`
 * (`::TYPE_DEMO`), which is the state that flips demo detection.
 */
export const COMMCARE_STANDARD_USER_TYPE = "standard";

/** Every built-in slug, for membership tests. */
export const BUILT_IN_USER_PROPERTY_SLUGS: ReadonlySet<string> = new Set(
	BUILT_IN_USER_PROPERTIES.map((property) => property.slug),
);

// ── The authored collections ─────────────────────────────────────────

/**
 * One slot workers carry data in — the app's half of CommCare's custom
 * user-data schema, compiling to one `Field` row on the domain's
 * `UserFields` definition.
 *
 * `slug` is the wire key and the name expressions read; `uuid` is the
 * identity every value bag points at, so renaming a slug never rewrites
 * a stored value.
 *
 * Two of HQ's `Field` columns are deliberately absent. `regex` /
 * `regex_msg` sit behind the paid `REGEX_FIELD_VALIDATION` privilege —
 * `custom_data_fields/edit_model.py::CustomDataModelMixin.get_field`
 * drops the pattern and keeps `choices` without it — so an authored
 * pattern would silently not validate on a stock domain. `required_for`
 * splits mobile from web users, and Nova provisions mobile workers only:
 * web users arrive through HQ's `InvitationResource`, which resolves a
 * role by name that a Nova user type cannot supply.
 */
const userPropertyChoicesSchema = z
	.array(z.string().min(1))
	.superRefine((choices, ctx) => {
		const seen = new Set<string>();
		for (const [index, choice] of choices.entries()) {
			if (!seen.has(choice)) {
				seen.add(choice);
				continue;
			}
			ctx.addIssue({
				code: "custom",
				path: [index],
				message: `Accepted value "${choice}" is listed more than once.`,
			});
		}
	});

export const userPropertySchema = z
	.object({
		uuid: uuidSchema,
		/** Absolute fractional sort key (`lib/doc/order`); never reaches CommCare. */
		order: z.string().optional(),
		slug: z
			.string()
			.min(1)
			.max(USER_PROPERTY_SLUG_MAX_LENGTH)
			.regex(USER_PROPERTY_SLUG_PATTERN),
		label: z.string().min(1).max(USER_PROPERTY_LABEL_MAX_LENGTH),
		/** Whether CommCare requires a value when a worker account is created. */
		required: z.boolean().optional(),
		/**
		 * A closed set of accepted values. Absent means free text. HQ stores
		 * this as `Field.choices` and validates against it on user save.
		 */
		choices: userPropertyChoicesSchema.optional(),
	})
	.strict();
export type UserProperty = z.infer<typeof userPropertySchema>;

/**
 * A value bag over the property catalog, keyed by property UUID rather
 * than slug so a slug rename leaves every stored value untouched.
 *
 * Absent key ≡ the property has no authored value for this type or
 * persona. That is a real distinction on the wire: a DECLARED property
 * with no value still reaches the device as an empty string, because
 * `users/user_data.py::UserData.to_dict` seeds `{field: '' for field in
 * self._schema_fields}` before layering authored values over it, while an
 * UNDECLARED key is genuinely absent from the session.
 */
export const userDataValuesSchema = ownRecordSchema(z.string(), z.string());
export type UserDataValues = z.infer<typeof userDataValuesSchema>;

/**
 * A reusable role: a name plus the default user data every worker in that
 * role carries. It compiles to plain per-user `user_data` values, not to
 * an HQ `CustomDataFieldsProfile` — profiles sit behind the paid
 * `APP_USER_PROFILES` privilege, so provisioning through them would make
 * the app's roles depend on the target's plan.
 */
export const userTypeSchema = z
	.object({
		uuid: uuidSchema,
		/** Absolute fractional sort key (`lib/doc/order`); never reaches CommCare. */
		order: z.string().optional(),
		name: z.string().min(1),
		description: z.string().optional(),
		values: userDataValuesSchema.optional(),
	})
	.strict();
export type UserType = z.infer<typeof userTypeSchema>;

/**
 * A named actor Preview can run as: stable identity, a role, where they
 * work, and any user data that differs from the role's defaults.
 *
 * `uuid` is the persona's CommCare identity — it is what Preview stamps
 * as `owner_id` on the case rows the persona creates and what
 * `session/context/userid` resolves to — so it must never be reissued.
 * A persona is not a Nova account and never authorizes anything;
 * authorization always belongs to the signed-in member.
 */
export const personaSchema = z
	.object({
		uuid: uuidSchema,
		/** Absolute fractional sort key (`lib/doc/order`); never reaches CommCare. */
		order: z.string().optional(),
		name: z.string().min(1),
		description: z.string().optional(),
		/** The user type this persona acts as. */
		userTypeUuid: uuidSchema.optional(),
		/** Values that differ from the user type's defaults. */
		values: userDataValuesSchema.optional(),
	})
	.strict();
export type Persona = z.infer<typeof personaSchema>;

// ── Reading the collections ──────────────────────────────────────────
//
// All three slots are optional on the doc and omitted when empty, so an
// app that declares none serializes byte-identically to one authored
// before they existed. These readers are the one place that absence
// collapses to an empty collection, so no call site hand-rolls `?? {}`.
//
// None of the three carries a membership array. Modules, forms, and
// fields need theirs to encode parentage; these are flat, so the record's
// keys ARE the membership and sequence comes from the fractional `order`
// key alone (`lib/doc/order`'s `bySortKey`), which is the model every
// other sequence already follows. One less slot, and no way for a record
// and its order array to disagree.

export interface UserCollections {
	readonly userProperties?: Record<string, UserProperty>;
	readonly userTypes?: Record<string, UserType>;
	readonly personas?: Record<string, Persona>;
}

const NO_PROPERTIES: Record<string, UserProperty> = {};
const NO_TYPES: Record<string, UserType> = {};
const NO_PERSONAS: Record<string, Persona> = {};

export function userPropertiesOf(
	doc: UserCollections,
): Record<string, UserProperty> {
	return doc.userProperties ?? NO_PROPERTIES;
}

export function userTypesOf(doc: UserCollections): Record<string, UserType> {
	return doc.userTypes ?? NO_TYPES;
}

export function personasOf(doc: UserCollections): Record<string, Persona> {
	return doc.personas ?? NO_PERSONAS;
}

/** Stable custom worker-information identity → current emitted slug. */
export function userPropertySlugsByUuid(
	doc: UserCollections,
): ReadonlyMap<Uuid, string> {
	return new Map(
		Object.values(userPropertiesOf(doc)).map((property) => [
			property.uuid,
			property.slug,
		]),
	);
}

/**
 * The user data a persona actually carries: its user type's defaults with
 * the persona's own values layered over them. Layering rather than
 * replacing is what makes a persona an override of a role rather than a
 * second copy of it.
 */
export function personaUserData(
	persona: Persona,
	doc: UserCollections,
): UserDataValues {
	const type =
		persona.userTypeUuid === undefined
			? undefined
			: ownRecordValue(userTypesOf(doc), persona.userTypeUuid);
	return mergeOwnRecords(type?.values, persona.values);
}
