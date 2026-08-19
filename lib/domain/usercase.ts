// lib/domain/usercase.ts
//
// The worker's own case — CommCare's `commcare-user` case type, and the one
// place Nova decides what is on it.
//
// A CommCare worker has a case of their own. `#user/<prop>` reads it (the
// hashtag expands to a `casedb` join on `hq_user_id`, `lib/commcare/hashtags.ts`),
// a form can write to it through `usercase_update`, and HQ keeps it in step
// with the user record. It is NOT the session block: the two projections carry
// the same authored data under different built-in keys — `first_name` here,
// `commcare_first_name` there — so collapsing them would make one of the two
// lie (`lib/preview/CLAUDE.md` § Resolved preview identity).
//
// HQ's writer is `callcenter/sync_usercase.py::_get_user_case_fields`, and
// this module mirrors exactly what it puts on the case. Two of its rules are
// easy to get backwards, and both are pinned by tests:
//
// - **The name key is `case_name`, not `name`.** `_get_user_case_fields` does
//   build a `name` entry, but both writers pop it straight back out into the
//   case's own name — `_UserCaseHelper.create_usercase` does
//   `case_name=fields.pop('name', None)` and `::update_user_case` does
//   `kwargs['case_name'] = fields.pop('name')` — so it never reaches
//   `<update>` as a property.
//   `app_schemas/case_properties.py::get_usercase_properties` lists no `name`
//   either. What the device exposes instead is the casedb's own `case_name`
//   node (`commcare-core .../CaseChildElement.java`), so emitting `name` here
//   would make `#user/name` read the worker's name in Preview and blank in
//   the field.
// - **`external_id` is a READ contract only.** HQ finds a usercase by external
//   id (`CommCareCase.objects.get_case_by_external_id`, reached from
//   `CouchUser.get_usercase`), but `_get_user_case_fields` never writes it and
//   `create_usercase` never passes it. Writing it would make an
//   `external_id = ''` comparison answer differently here than in the field.
//
// Nova owns this case type; nothing may author a create or close of it
// (`RESERVED_CASE_OPERATION_TYPES` in `./forms`).

import type { CaseType } from "./blueprint";
import {
	MAX_CASE_SCALAR_TEXT_LENGTH,
	prepareCaseScalarTextValue,
} from "./caseScalarText";
import { proseText } from "./prose";
import { mergeOwnRecords, recordFromEntries } from "./records";
import { isStandardCaseListProperty } from "./standardCaseProperties";
import type { UserCollections } from "./users";
import { userPropertiesOf } from "./users";

/**
 * The case type of a worker's own record.
 *
 * `change_feed/topics.py::COMMCARE_USER`. Beware HQ's three same-named
 * `COMMCARE_USER` constants with three different values — see
 * `./users::COMMCARE_MOBILE_WORKER_USER_TYPE` for which is which.
 */
export const USERCASE_CASE_TYPE = "commcare-user";

/** The worker facts every usercase built-in derives from. */
export interface UsercaseWorker {
	/** The user id. Also the `hq_user_id` the `#user/` join matches on. */
	readonly id: string;
	/** The login handle. */
	readonly username: string;
	/** The human name the case's name and the first/last split come from. */
	readonly personName: string;
	readonly email: string;
}

/** Split a display name the way an HQ profile's first/last name divides. */
export function splitWorkerName(name: string): {
	readonly first: string;
	readonly last: string;
} {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	return { first: parts[0] ?? "", last: parts.slice(1).join(" ") };
}

/**
 * Every key a usercase can carry from the built-ins, whatever this worker's
 * facts happen to be.
 *
 * The SCHEMA has to be the superset and the VALUES are the subset, which is
 * why this is a list rather than the keys of a sample record.
 * `commcare_project` is the case that proves it: the value is written only
 * when Nova knows the project space, so deriving the key list from a
 * projectless sample produced a case type that rejected the very row a
 * project-bearing sync wrote. Adding a conditional key to
 * `usercaseBuiltInValues` and forgetting this list is a failed insert, which
 * is a loud failure — the reverse would be a silently unstorable property.
 */
export const USERCASE_BUILT_IN_KEYS: readonly string[] = [
	"case_name",
	"username",
	"email",
	"first_name",
	"last_name",
	"hq_user_id",
	"language",
	"phone_number",
	"last_device_id_used",
	"commcare_profile",
	"commcare_location_id",
	"commcare_location_ids",
	"commcare_primary_case_sharing_id",
	"commcare_project",
];

/**
 * The name the worker's case carries.
 *
 * HQ's own fallback, verbatim: `_get_user_case_fields` writes
 * `user.name or user.raw_username`, so a worker with no display name is named
 * for their login rather than left nameless. Nova needs the fallback for a
 * second reason it cannot decline — `cases.case_name` is `NOT NULL` and
 * carries a length check, so a blank name is a failed insert rather than an
 * ugly one.
 *
 * Normalized through the shared scalar-text contract, the same one every other
 * case write passes through, so a name that arrives with boundary code units
 * or overlong text is repaired identically here and there. The id is the last
 * resort: it is never blank, and a case named for its own id is at least
 * findable.
 */
export function usercaseName(worker: UsercaseWorker): string {
	for (const candidate of [worker.personName, worker.username, worker.id]) {
		const prepared = prepareCaseScalarTextValue(candidate, "reject");
		if (prepared.ok) return prepared.value;
	}
	// Unreachable through a persisted worker: an id is a uuid, which is
	// neither blank nor overlong. Truncating beats throwing from a projection.
	return worker.id.slice(0, MAX_CASE_SCALAR_TEXT_LENGTH);
}

/**
 * The keys HQ writes on every usercase, whatever the app declared.
 *
 * Present-and-empty is deliberate wherever HQ writes the slot unconditionally
 * (`user.language or ''`), because a declared-but-empty value and an absent
 * key answer a `= ''` comparison differently and the device has the former.
 *
 * `commcare_project` is the exception: `_get_user_case_fields` ends with an
 * unconditional `fields.update({... 'commcare_project': domain})`, but the
 * domain is never empty on a device, so an empty value here would be one no
 * worker can hold. Absent behaves like the device for every comparison.
 *
 * The three location keys go the OTHER way from the session block, and this is
 * the easiest thing in the file to get backwards: `get_user_session_data`
 * writes all three or none, so the session omits them entirely while nobody is
 * assigned anywhere — while `_get_user_case_fields` takes an explicit `else ''`
 * branch, so the usercase always carries them empty.
 *
 * `commcare_profile` rides in the same way it does on the session side: the
 * dict starts from `UserData.to_dict()`, which always includes the slot, and
 * it survives the valid-XML-element-name filter.
 *
 * `language` and `last_device_id_used` are the contrast that makes
 * `commcare_project`'s absence right — HQ genuinely writes those empty
 * (`user.language or ''`), so Preview carries them empty too.
 */
export function usercaseBuiltInValues(
	worker: UsercaseWorker,
	projectSpace: string | null,
): Record<string, string> {
	const { first, last } = splitWorkerName(worker.personName);
	return {
		case_name: usercaseName(worker),
		username: worker.username,
		email: worker.email,
		first_name: first,
		last_name: last,
		hq_user_id: worker.id,
		language: "",
		phone_number: "",
		last_device_id_used: "",
		commcare_profile: "",
		commcare_location_id: "",
		commcare_location_ids: "",
		commcare_primary_case_sharing_id: "",
		...(projectSpace === null ? {} : { commcare_project: projectSpace }),
	};
}

/**
 * Every DECLARED worker property, seeded blank.
 *
 * `users/user_data.py::UserData.to_dict` seeds `{field: '' for field in
 * self._schema_fields}` before applying any value, so a declared property with
 * no value is present-and-empty on the device while an undeclared key is
 * genuinely absent. That split is what a `= ''` comparison depends on.
 */
export function declaredUsercaseSlots(
	doc: UserCollections,
): Record<string, string> {
	return recordFromEntries(
		Object.values(userPropertiesOf(doc)).map(
			(property) => [property.slug, ""] as const,
		),
	);
}

/** Authored worker values re-keyed from property UUID to current slug. */
export function usercaseValuesBySlug(
	values: Record<string, string>,
	doc: UserCollections,
): Record<string, string> {
	const properties = userPropertiesOf(doc);
	const entries: Array<readonly [string, string]> = [];
	for (const [propertyUuid, value] of Object.entries(values)) {
		const property = Object.hasOwn(properties, propertyUuid)
			? properties[propertyUuid]
			: undefined;
		if (property !== undefined) entries.push([property.slug, value]);
	}
	return recordFromEntries(entries);
}

/**
 * The `commcare-user` case type, derived rather than declared.
 *
 * The worker-property catalog is what an author edits; this is the case type
 * that catalog implies, and it is the schema the case store materializes so a
 * usercase row can be stored and read like any other. Deriving it is what
 * keeps the two from drifting: there is no second place to add a property.
 *
 * It is deliberately NOT in `effectiveCaseTypes`. That view is the authoring
 * catalog — what a module can list, a form can create, a picker can offer —
 * and the usercase is none of those. Nova owns it, HQ creates the row, and no
 * author may open or close one. It joins the catalog only at the STORAGE
 * boundary (`buildCaseTypeMap`), which is exactly the set of callers that
 * need to resolve a `commcare-user` property's type to read or write a row.
 *
 * `case_name` is absent for the same reason it is absent from HQ's
 * `get_usercase_properties`: the worker's name is the case's own name column,
 * not a property beside it. Every remaining value is text, because HQ stores
 * all user data as strings (`users/user_data.py`) and worker properties carry
 * no authored data type.
 */
export function usercaseCaseType(doc: UserCollections): CaseType {
	const builtIns = USERCASE_BUILT_IN_KEYS.filter(
		(name) => !isStandardCaseListProperty(name),
	);
	const declared = Object.values(userPropertiesOf(doc));
	const labelBySlug = new Map(declared.map((p) => [p.slug, p.label]));
	const names = [...builtIns, ...declared.map((property) => property.slug)];
	return {
		name: USERCASE_CASE_TYPE,
		properties: [...new Set(names)].map((name) => ({
			name,
			label: proseText(labelBySlug.get(name) ?? name),
			data_type: "text" as const,
		})),
	};
}

/**
 * Everything on one worker's usercase: the declared slots, their authored
 * values, and the built-ins over the top.
 *
 * One derivation with two consumers. Preview reads it to answer
 * `#user/<prop>` before a row exists, and the materializer writes it into
 * that row. They cannot be allowed to differ: the wire resolves `#user/` from
 * `casedb`, so the row is the truth, and a projection that disagreed with it
 * would make Preview answer a question differently from the device for a
 * worker who had simply been saved once.
 *
 * Built-ins last. An author may declare a worker property whose slug collides
 * with one (nothing reserves them), and HQ resolves that the same way:
 * `_get_user_case_fields` layers its own keys over `UserData.to_dict()`.
 */
export function usercaseRecord(
	worker: UsercaseWorker,
	authored: Record<string, string>,
	doc: UserCollections,
	projectSpace: string | null,
): Record<string, string> {
	return mergeOwnRecords(
		declaredUsercaseSlots(doc),
		usercaseValuesBySlug(authored, doc),
		usercaseBuiltInValues(worker, projectSpace),
	);
}

/**
 * The subset of `desired` that a stored usercase does not already carry.
 *
 * This is HQ's `_get_changed_fields` and it is the "without clobbering"
 * contract: it writes a key only when the value differs, and it NEVER removes
 * one. A property a form wrote through `usercase_update` therefore survives
 * every subsequent persona edit that does not name that same property, which
 * is exactly the behaviour a worker sees in the field.
 *
 * The comparison is against the stored value coerced to text, because a
 * usercase property is text everywhere it matters — HQ stores user data as
 * strings, and the case type declares every slot `text` — while a JSONB read
 * can hand back a number or boolean for a row written before that was true.
 * Comparing untouched would rewrite such a row on every sync forever.
 */
export function usercaseChangedFields(
	stored: Readonly<Record<string, unknown>>,
	desired: Readonly<Record<string, string>>,
): Record<string, string> {
	const changed: Array<readonly [string, string]> = [];
	for (const [key, value] of Object.entries(desired)) {
		const current = Object.hasOwn(stored, key) ? stored[key] : undefined;
		const asText =
			current === undefined || current === null ? undefined : String(current);
		if (asText !== value) changed.push([key, value]);
	}
	return recordFromEntries(changed);
}
