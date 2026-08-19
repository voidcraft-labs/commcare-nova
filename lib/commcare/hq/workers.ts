import "server-only";

/**
 * The mobile workers one CommCare HQ project space holds, and how Nova
 * makes them.
 *
 * A worker is a person's account, which makes this the most careful of
 * the three drivers. Three decisions follow from that and are worth
 * stating before the code:
 *
 *   * **Nova never deletes one.** The resource's DELETE is
 *     `users/models.py::CommCareUser.retire`, which reaches
 *     `::delete_user_data` → `tag_cases_as_deleted_and_remove_indices` and
 *     soft-deletes EVERY case that worker owns. There is no call here that
 *     issues it.
 *   * **An update never carries a password.** A create must (see below),
 *     but sending one on an update resets a working account's password,
 *     and an update is exactly what happens to a worker somebody handed
 *     Nova. So the password is a create-only field in this module's types,
 *     not a flag on a shared one.
 *   * **Reading is separate from writing, and reading is a hint.**
 *     `v0_1.py::CommCareUserResource.obj_get_list` supports no username
 *     filter at all — only `group` and `archived` — so the search below
 *     goes through the Elasticsearch-backed `bulk-user` resource instead,
 *     and its answer is matched EXACTLY here rather than trusted. CommCare
 *     HQ's own `is_username_available` at create time stays the authority
 *     on whether a name is free.
 */

import { log } from "@/lib/logger";
import {
	authHeader,
	baseUrl,
	type CommCareApiError,
	type CommCareCredentials,
	INVALID_DOMAIN_SLUG,
	isValidDomainSlug,
	logAndReturnError,
	warnAndReturnError,
} from "./http";

/** One worker the project space already holds. */
export interface HqMobileWorker {
	/** CommCare HQ's `user_id` — the durable key everything else rides on. */
	readonly userId: string;
	/** The complete username, `<name>@<domain>.commcarehq.org`. */
	readonly username: string;
}

/** The complete set of fields a create may carry. */
export interface HqMobileWorkerCreate {
	/** The bare name; CommCare HQ appends its own user domain. */
	readonly username: string;
	/** Required. See `createHqMobileWorker` for why there is no way out. */
	readonly password: string;
	readonly firstName?: string;
	readonly lastName?: string;
	readonly email?: string;
	readonly userData?: Readonly<Record<string, string>>;
	/** Sent together or not at all, primary included in the list. */
	readonly locations?: {
		readonly primaryLocationId: string;
		readonly locationIds: readonly string[];
	};
}

/**
 * The complete set of fields an update may carry.
 *
 * Deliberately smaller than the create: no username, because
 * `api/user_updates.py::CommcareUserUpdates.update` refuses it outright as
 * a non-editable field, and no password, because Nova will not reset the
 * password of an account somebody is already using.
 */
export interface HqMobileWorkerUpdate {
	readonly firstName?: string;
	readonly lastName?: string;
	readonly email?: string;
	readonly userData?: Readonly<Record<string, string>>;
	/** An empty list clears every assignment; absent leaves them alone. */
	readonly locations?: {
		readonly primaryLocationId: string;
		readonly locationIds: readonly string[];
	} | null;
}

/**
 * A refused write, carrying CommCare HQ's own sentence about why.
 *
 * Worth having rather than the status alone, because CommCare HQ says
 * something specific and actionable in every case Nova cannot predict: a
 * username already taken or reserved, a profile the project space
 * requires and Nova has no vocabulary for, a password its own strength
 * rule rejects, a location that is not active. `obj_update` even
 * accumulates every field's complaint into one sentence
 * (`"The request resulted in the following errors: ..."`).
 */
export interface HqMobileWorkerRefusal extends CommCareApiError {
	/** CommCare HQ's own words. Empty when it gave none. */
	readonly message: string;
}

/** How many workers one search asks about at a time. */
const SEARCH_PAGE_SIZE = 100;

/**
 * Whether the requested usernames already exist on the project space.
 *
 * This exists to answer ONE question before anything is written: which of
 * these names is already somebody's account. It uses `bulk-user`
 * (`v0_5.py::BulkUserResource`), the read-only Elasticsearch resource,
 * because the writable user resource offers no username filter — reading
 * every worker on a large project space to find three would be a slow and
 * rude way to ask.
 *
 * `q` goes straight into an Elasticsearch `query_string`
 * (`v0_5.py::user_es_call`), so the returned usernames are matched
 * EXACTLY here rather than trusted: an analyzer that tokenizes on `@`
 * would otherwise hand back a near miss as a hit. A username Nova asked
 * about and did not get back is reported absent, which is safe in both
 * directions — the create that follows is refused by CommCare HQ's own
 * uniqueness check if it was wrong, and the adoption that follows says it
 * could not find the account rather than guessing at one.
 */
export async function findHqMobileWorkers(
	creds: CommCareCredentials,
	domain: string,
	usernames: readonly string[],
): Promise<readonly HqMobileWorker[] | CommCareApiError> {
	if (!isValidDomainSlug(domain)) return INVALID_DOMAIN_SLUG;
	if (usernames.length === 0) return [];
	if (usernames.length > SEARCH_PAGE_SIZE) {
		log.error("[commcare] worker search over its own limit", undefined, {
			domain,
			count: usernames.length,
			limit: SEARCH_PAGE_SIZE,
		});
		return { success: false, status: 400 };
	}

	const wanted = new Set(usernames);
	/* One query rather than one per name, quoted so a username's own dots
	 * and at-sign cannot read as query syntax. The size is generous
	 * because a `query_string` may answer with near misses, and the exact
	 * match below is what decides. */
	const query = usernames
		.map((username) => `username:"${username.replace(/"/g, "")}"`)
		.join(" OR ");
	const url = new URL(`${baseUrl(creds)}/a/${domain}/api/bulk-user/v1/`);
	url.searchParams.set("q", query);
	url.searchParams.append("fields", "id");
	url.searchParams.append("fields", "username");
	url.searchParams.set("limit", String(usernames.length * 4));

	let res: Response;
	try {
		res = await fetch(url.toString(), {
			headers: { Authorization: authHeader(creds) },
		});
	} catch (error) {
		log.warn("[commcare] worker search unreachable", {
			domain,
			error: error instanceof Error ? error.message : String(error),
		});
		return { success: false, status: 503 };
	}
	if (!res.ok) {
		return res.status === 401 || res.status === 403
			? warnAndReturnError("worker search refused", res)
			: logAndReturnError("worker search failed", res);
	}
	let body: { readonly objects?: readonly unknown[] };
	try {
		body = (await res.json()) as { readonly objects?: readonly unknown[] };
	} catch {
		log.error("[commcare] worker search returned non-JSON", undefined, {
			domain,
		});
		return { success: false, status: 502 };
	}

	const found: HqMobileWorker[] = [];
	for (const raw of body.objects ?? []) {
		if (raw === null || typeof raw !== "object") continue;
		const { id, username } = raw as { id?: unknown; username?: unknown };
		if (typeof id !== "string" || typeof username !== "string") continue;
		if (!wanted.has(username)) continue;
		found.push({ userId: id, username });
	}
	return found;
}

/**
 * Make one mobile worker.
 *
 * **A password is always required and Nova always generates one.** The
 * two-stage account-confirmation branch in `v0_5.py::CommCareUserResource.obj_create`
 * fires only when `require_account_confirmation` or
 * `send_confirmation_email_now` is set; Nova sets neither, so the `else`
 * branch applies and `"Password or connect username required"` is the
 * refusal for omitting it. There is therefore no probe to make and no
 * privilege to check: generate one, hand it back once, and never store it.
 *
 * The username is sent bare. `users/util.py::generate_mobile_username`
 * appends `@<domain>.commcarehq.org` itself, and it is the only field that
 * can never be changed afterwards — `CommcareUserUpdates.update` refuses
 * it as non-editable.
 *
 * Answers **201** with `{"id": "<user_id>"}` — the resource's own
 * `serialize` collapses a POST's bundle to exactly that.
 */
export async function createHqMobileWorker(
	creds: CommCareCredentials,
	domain: string,
	worker: HqMobileWorkerCreate,
): Promise<{ readonly userId: string } | HqMobileWorkerRefusal> {
	if (!isValidDomainSlug(domain)) {
		return { ...INVALID_DOMAIN_SLUG, message: "" };
	}
	const body = JSON.stringify({
		username: worker.username,
		password: worker.password,
		...workerFields(worker),
	});
	return writeWorker(
		creds,
		domain,
		`${baseUrl(creds)}/a/${domain}/api/user/v1/`,
		"POST",
		body,
		(parsed) => {
			const id = (parsed as { id?: unknown }).id;
			return typeof id === "string" && id !== "" ? { userId: id } : null;
		},
	);
}

/**
 * Bring one existing worker into step with what Nova holds.
 *
 * No password and no username: the first would reset an account somebody
 * is using, and the second is refused outright. Everything else goes
 * through `CommcareUserUpdates.update`, whose field map is closed, so
 * `workerFields` below is not a convenience subset but the whole
 * permitted surface.
 *
 * Answers **200**. A rejected field answers 400 with every complaint
 * gathered into one sentence, which is passed through rather than
 * summarized.
 */
export async function updateHqMobileWorker(
	creds: CommCareCredentials,
	domain: string,
	userId: string,
	worker: HqMobileWorkerUpdate,
): Promise<{ readonly userId: string } | HqMobileWorkerRefusal> {
	if (!isValidDomainSlug(domain)) {
		return { ...INVALID_DOMAIN_SLUG, message: "" };
	}
	if (userId === "" || userId.includes("/")) {
		log.error("[commcare] worker update given an unusable id", undefined, {
			domain,
		});
		return { success: false, status: 400, message: "" };
	}
	const body = JSON.stringify(workerFields(worker));
	return writeWorker(
		creds,
		domain,
		`${baseUrl(creds)}/a/${domain}/api/user/v1/${encodeURIComponent(userId)}/`,
		"PUT",
		body,
		() => ({ userId }),
	);
}

/**
 * The fields both writes share, in CommCare HQ's spelling.
 *
 * `primary_location` and `locations` go together or not at all
 * (`user_updates.py::_validate_locations`), and an empty list with no
 * primary is how `::_update_location` reaches `_remove_all_locations` —
 * which is exactly what a persona that stands nowhere means. Omitting
 * both leaves the worker's assignments untouched, which is what a caller
 * with nothing to say about them wants.
 */
function workerFields(
	worker: HqMobileWorkerCreate | HqMobileWorkerUpdate,
): Record<string, unknown> {
	return {
		...(worker.firstName === undefined ? {} : { first_name: worker.firstName }),
		...(worker.lastName === undefined ? {} : { last_name: worker.lastName }),
		...(worker.email === undefined ? {} : { email: worker.email }),
		...(worker.userData === undefined ? {} : { user_data: worker.userData }),
		...(worker.locations === undefined
			? {}
			: worker.locations === null
				? { locations: [] }
				: {
						primary_location: worker.locations.primaryLocationId,
						locations: worker.locations.locationIds,
					}),
	};
}

/** One write, one reading of the answer, one place that logs a refusal. */
async function writeWorker(
	creds: CommCareCredentials,
	domain: string,
	url: string,
	method: "POST" | "PUT",
	body: string,
	read: (parsed: unknown) => { readonly userId: string } | null,
): Promise<{ readonly userId: string } | HqMobileWorkerRefusal> {
	let res: Response;
	try {
		res = await fetch(url, {
			method,
			headers: {
				Authorization: authHeader(creds),
				"Content-Type": "application/json",
			},
			body,
		});
	} catch (error) {
		log.warn("[commcare] worker write unreachable", {
			domain,
			method,
			error: error instanceof Error ? error.message : String(error),
		});
		return { success: false, status: 503, message: "" };
	}

	let text = "";
	try {
		text = await res.text();
	} catch {}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = null;
	}

	if (!res.ok) {
		const message =
			parsed !== null &&
			typeof parsed === "object" &&
			typeof (parsed as { error?: unknown }).error === "string"
				? (parsed as { error: string }).error
				: "";
		/* The body is deliberately NOT logged. A create carries the
		 * generated password, and a refusal echoing the request would put
		 * it in Cloud Logging forever. */
		const context = { domain, method, status: res.status };
		if (res.status === 401 || res.status === 403) {
			log.warn("[commcare] worker write refused", context);
		} else {
			log.error("[commcare] worker write failed", undefined, context);
		}
		return { success: false, status: res.status, message };
	}

	const result = read(parsed);
	if (result === null) {
		log.error("[commcare] worker write answered without an id", undefined, {
			domain,
			method,
		});
		return { success: false, status: 502, message: "" };
	}
	return result;
}
