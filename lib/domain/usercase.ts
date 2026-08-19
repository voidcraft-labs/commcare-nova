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

import { recordFromEntries } from "./records";
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
		case_name: worker.personName,
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
