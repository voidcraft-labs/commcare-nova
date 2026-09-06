import "server-only";

/**
 * The organization one CommCare HQ project space holds, and how Nova puts
 * its places there.
 *
 * Two resources that differ in what they will let Nova do, and the
 * asymmetry decides the whole driver's shape:
 *
 *   * **Levels** (`location_type`) are READ-ONLY. `v0_5.py::LocationTypeResource.Meta`
 *     allows nothing but `get`, so Nova cannot create a level. That is why
 *     the levels half of the setup artifact stays an instruction while the
 *     places half becomes a record of what Nova did — and why the level
 *     read is a blocking preflight edge rather than a step that fixes what
 *     it finds.
 *   * **Places** (`location`) are writable through `v0_6.py::LocationResource.patch_list`,
 *     which is `@atomic` and capped at `patch_limit = 100`.
 *
 * Reading either one needs FOUR things, and Nova cannot tell them apart
 * from the answer, so every refusal here names all of them rather than
 * guessing at one:
 *
 *   * the project space's `LOCATIONS` privilege — `v0_5.py::BaseLocationsResource.dispatch`
 *     answers a bodyless 403 without it;
 *   * the project space's `API_ACCESS` privilege — `api/resources/__init__.py::HqBaseResource.dispatch`
 *     answers 401 with a subscription message;
 *   * the account's Edit Locations permission, and
 *   * the account's Access APIs permission — `api/resources/auth.py::RequirePermissionAuthentication`
 *     checks `{permission, 'access_api'}` together
 *     (`users/decorators.py::require_api_permission`) and answers a
 *     bodyless 403 without either.
 *
 * Two of those four produce an identical bodyless 403, so a message that
 * picked one would be confidently wrong half the time.
 */

import { log } from "@/lib/logger";
import {
	authHeader,
	baseUrl,
	type CommCareApiError,
	type CommCareCredentials,
	INVALID_DOMAIN_SLUG,
	isValidDomainSlug,
} from "./http";
import { isHqObject, readHqCollection } from "./readCollection";

/** One level, as CommCare HQ reports it. Nova reads these, never writes. */
export interface HqLocationType {
	/** CommCare HQ's primary key, which its own resource URIs address. */
	readonly id: string;
	readonly name: string;
	/** What a push names the level by. */
	readonly code: string;
	/** The level directly above, by code. Null at the top of the tree. */
	readonly parentCode: string | null;
	readonly administrative: boolean;
	readonly sharesCases: boolean;
	readonly viewDescendants: boolean;
}

/** One place already on the project space. */
export interface HqLocation {
	/** CommCare HQ's `location_id` — the durable key the ledger stores. */
	readonly locationId: string;
	readonly name: string;
	/** Domain-unique, and the key every bulk upload matches on. */
	readonly siteCode: string;
	readonly locationTypeCode: string;
	/** Null at the top. CommCare HQ spells that as `""`; this does not. */
	readonly parentLocationId: string | null;
	/**
	 * The place's custom fields, as the target holds them right now.
	 *
	 * Read because `_update` REPLACES `metadata` wholesale rather than
	 * merging: a push that sent only what Nova models would delete every
	 * other field, and on a place somebody else made those are theirs.
	 */
	readonly values: Readonly<Record<string, unknown>>;
}

/**
 * One place as a push presents it.
 *
 * Exactly the keys `v0_6.py::LocationResource._update` recognizes. It pops
 * each one it knows and then raises `"Invalid fields were included in
 * request"` on whatever is left, so this type is the complete permitted
 * surface rather than a convenient subset.
 *
 * `siteCode` is deliberately required rather than optional. `_update`
 * REGENERATES the code from the name whenever `name` is present and
 * `site_code` is not, so omitting it on a rename would silently repoint
 * the key that every bulk upload and worker assignment matches on.
 */
export interface HqLocationPush {
	/** Present to update that place; absent to create one. */
	readonly locationId?: string;
	readonly name: string;
	readonly siteCode: string;
	readonly locationTypeCode: string;
	readonly parentLocationId?: string;
	/** Exact decimal strings. A coordinate is never a float on this wire. */
	readonly latitude?: string;
	readonly longitude?: string;
	readonly locationData?: Readonly<Record<string, unknown>>;
}

/**
 * The `location_id`s of one accepted batch, in REQUEST ORDER.
 *
 * Order is the only thing tying a result back to what Nova sent:
 * `api/resources/__init__.py::patch_list_replica` answers
 * `[bundle.data['_id'] for bundle in bundles_seen]` — a bare JSON array of
 * strings, with no echo of the place each came from.
 */
export interface HqLocationPatchResult {
	readonly ids: readonly string[];
}

/**
 * A refused batch, carrying CommCare HQ's own sentence about why.
 *
 * The message is worth having rather than the status alone: it names the
 * offending place by site code (`v0_6.py::LocationAPIError.__init__`
 * appends it), and the four things it can say — an unrecognized field, a
 * level that cannot nest under that parent, a duplicate sibling name, a
 * site code already taken — are the ones a person can act on. Every one
 * of them rolls the whole `@atomic` batch back. A lost response or an
 * unusable acknowledgement does not establish rollback; callers must preserve
 * that uncertainty instead of claiming no places were created.
 */
export interface HqLocationPushRefusal extends CommCareApiError {
	/** CommCare HQ's own words. Empty when it gave none. */
	readonly message: string;
	/** True when the response cannot prove the atomic batch rolled back. */
	readonly mayHaveLanded: boolean;
}

/** The most places one atomic request may carry (`patch_limit`). */
export const HQ_LOCATION_PATCH_LIMIT = 100;

/**
 * How many to ask for per page when reading.
 *
 * `v0_6.py::LocationResource.Meta.max_limit` is 5000 and the level
 * resource takes tastypie's default 1000. Nova has to read the WHOLE list
 * either way — the resource has no filter that takes a set of site codes,
 * so there is no smaller question to ask — and asking in large pages is
 * what keeps a big project space to a handful of round trips.
 */
const LOCATION_PAGE_SIZE = 1000;

/**
 * A bound on pages followed, so a cursor that never terminates cannot
 * spin here holding a request open. A hundred thousand places is not a
 * project space Nova is refusing to serve; it is a cursor that is wrong.
 */
const MAX_LOCATION_PAGES = 100;

/**
 * The levels the project space defines.
 *
 * Read before anything is pushed, because it answers the one question
 * Nova must not guess at: whether each place's level is the IMMEDIATE
 * child of its parent place's level. `util.py::get_location_type` admits
 * only the types `forms.py::LocationForm.get_allowed_types` returns, and
 * that query is `parent_type=parent.location_type` — immediate children
 * alone, and `parent_type=None` for a place with no parent. Nova
 * deliberately allows a place to skip a rung
 * (`lib/domain/organization.ts::levelMayNestUnder` is strict ancestry),
 * so this is a real authored shape that CommCare HQ will not take.
 *
 * A refusal is never read as "there are no levels": that reading would
 * report every place as unpushable for the wrong reason.
 */
export async function listHqLocationTypes(
	creds: CommCareCredentials,
	domain: string,
): Promise<readonly HqLocationType[] | CommCareApiError> {
	if (!isValidDomainSlug(domain)) return INVALID_DOMAIN_SLUG;
	const raw = await readHqCollection(
		creds,
		`${baseUrl(creds)}/a/${domain}/api/location_type/v1/?limit=${LOCATION_PAGE_SIZE}`,
		"location type list",
		MAX_LOCATION_PAGES,
	);
	if ("success" in raw) return raw;

	/* The level above is declared as `parent = fields.ForeignKey('self',
	 * 'parent_type')`, so it serializes under the key `parent` and as a
	 * resource URI ending in the parent's primary key — never as a code.
	 * Every level is in this same answer, so the URI resolves locally
	 * rather than costing a request per level. */
	const codeById = new Map<string, string>();
	const codes = new Set<string>();
	const levels: Record<string, unknown>[] = [];
	for (const value of raw) {
		if (
			!isHqObject(value) ||
			(typeof value.id !== "number" && typeof value.id !== "string") ||
			!/^\d+$/.test(String(value.id)) ||
			typeof value.code !== "string" ||
			value.code.trim() === "" ||
			typeof value.name !== "string" ||
			typeof value.administrative !== "boolean" ||
			typeof value.shares_cases !== "boolean" ||
			typeof value.view_descendants !== "boolean" ||
			codeById.has(String(value.id)) ||
			codes.has(value.code)
		)
			return malformedInventory("level");
		codeById.set(String(value.id), value.code);
		codes.add(value.code);
		levels.push(value);
	}
	const types: HqLocationType[] = [];
	for (const level of levels) {
		const parentCode = parentLevelCode(level.parent, codeById, creds, domain);
		if (parentCode === undefined) return malformedInventory("level parent");
		types.push({
			id: String(level.id),
			name: level.name as string,
			code: level.code as string,
			parentCode,
			administrative: level.administrative === true,
			sharesCases: level.shares_cases === true,
			viewDescendants: level.view_descendants === true,
		});
	}
	const parents = new Map(types.map((level) => [level.code, level.parentCode]));
	for (const level of types) {
		const visited = new Set<string>();
		let code: string | null = level.code;
		while (code !== null) {
			if (visited.has(code)) return malformedInventory("level cycle");
			visited.add(code);
			code = parents.get(code) ?? null;
		}
	}
	return types;
}

function malformedInventory(part: string): CommCareApiError {
	log.error("[commcare] organization inventory is malformed", undefined, {
		part,
	});
	return { success: false, status: 502 };
}

/** ForeignKey serializes a URI. Missing/unresolvable is not a root. Both HQ
 * API route spellings resolve locally; no request follows this reference. */
function parentLevelCode(
	parent: unknown,
	codeById: ReadonlyMap<string, string>,
	creds: CommCareCredentials,
	domain: string,
): string | null | undefined {
	if (parent === null) return null;
	if (typeof parent !== "string" || parent === "") return undefined;
	let url: URL;
	try {
		url = new URL(parent, baseUrl(creds));
	} catch {
		return undefined;
	}
	if (
		url.origin !== new URL(baseUrl(creds)).origin ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		return undefined;
	const prefixes = [
		`/a/${domain}/api/location_type/v1/`,
		`/a/${domain}/api/v0.5/location_type/`,
	];
	const prefix = prefixes.find((candidate) =>
		url.pathname.startsWith(candidate),
	);
	if (prefix === undefined) return undefined;
	const id = url.pathname.slice(prefix.length).replace(/\/$/, "");
	return /^\d+$/.test(id) ? codeById.get(id) : undefined;
}

/**
 * The places the project space currently holds.
 *
 * `Meta.queryset` is `SQLLocation.active_objects.all()`, so an ARCHIVED
 * place is absent from this answer while still holding its site code —
 * `util.py::validate_site_code` queries `SQLLocation.objects`, not the
 * active manager. A code that looks free here can therefore still be
 * taken, which is why a site-code collision is reported from CommCare
 * HQ's own refusal rather than predicted from this list.
 */
export async function listHqLocations(
	creds: CommCareCredentials,
	domain: string,
): Promise<readonly HqLocation[] | CommCareApiError> {
	if (!isValidDomainSlug(domain)) return INVALID_DOMAIN_SLUG;
	const raw = await readHqCollection(
		creds,
		`${baseUrl(creds)}/a/${domain}/api/location/v2/?limit=${LOCATION_PAGE_SIZE}`,
		"location list",
		MAX_LOCATION_PAGES,
	);
	if ("success" in raw) return raw;

	const places: HqLocation[] = [];
	const ids = new Set<string>();
	const codes = new Set<string>();
	for (const place of raw) {
		if (
			!isHqObject(place) ||
			typeof place.location_id !== "string" ||
			place.location_id.trim() === "" ||
			typeof place.site_code !== "string" ||
			place.site_code.trim() === "" ||
			typeof place.name !== "string" ||
			typeof place.location_type_code !== "string" ||
			place.location_type_code.trim() === "" ||
			(place.parent_location_id !== null &&
				typeof place.parent_location_id !== "string") ||
			!isHqObject(place.location_data) ||
			ids.has(place.location_id) ||
			codes.has(place.site_code)
		)
			return malformedInventory("place");
		ids.add(place.location_id);
		codes.add(place.site_code);
		places.push({
			locationId: place.location_id,
			name: place.name,
			siteCode: place.site_code,
			locationTypeCode: place.location_type_code,
			parentLocationId:
				place.parent_location_id === "" ? null : place.parent_location_id,
			// HQ validates modeled fields, then replaces the entire metadata
			// object. Foreign JSON values must survive that replacement too.
			values: place.location_data,
		});
	}
	return places;
}

/**
 * Put one atomic batch of places on the project space.
 *
 * `v0_6.py::LocationResource.patch_list` is `@atomic` and upserts on the
 * presence of `location_id`, so a batch is all-or-nothing and IS the
 * partial-failure boundary: everything in it lands, or nothing does. Nova
 * sends one batch per level, parents first, because a child names its
 * parent by the `location_id` the parent's own batch returned.
 *
 * Two things about the answer are easy to get wrong, and both are handled
 * here rather than by every caller:
 *
 *   * Success is **202 Accepted**, not 200.
 *   * The body is a BARE ARRAY of ids, not an envelope and not objects.
 *     Position is the only link back to the place Nova sent, so an answer
 *     whose length does not match the request cannot be matched up at all
 *     and is refused: recording the wrong remote id against a place would
 *     make the next publish quietly update somebody else's.
 */
export async function patchHqLocations(
	creds: CommCareCredentials,
	domain: string,
	places: readonly HqLocationPush[],
): Promise<HqLocationPatchResult | HqLocationPushRefusal> {
	if (!isValidDomainSlug(domain)) {
		return { ...INVALID_DOMAIN_SLUG, message: "", mayHaveLanded: false };
	}
	if (places.length === 0) return { ids: [] };
	if (places.length > HQ_LOCATION_PATCH_LIMIT) {
		/* CommCare HQ answers "Object count exceeds limit for PATCH method."
		 * and takes none of them. Refusing here names the caller's bug
		 * instead of turning it into a remote error somebody has to read. */
		log.error("[commcare] location batch over the atomic limit", undefined, {
			domain,
			count: places.length,
			limit: HQ_LOCATION_PATCH_LIMIT,
		});
		return { success: false, status: 400, message: "", mayHaveLanded: false };
	}

	const body = JSON.stringify({
		objects: places.map((place) => ({
			...(place.locationId === undefined
				? {}
				: { location_id: place.locationId }),
			name: place.name,
			site_code: place.siteCode,
			location_type_code: place.locationTypeCode,
			...(place.parentLocationId === undefined
				? {}
				: { parent_location_id: place.parentLocationId }),
			...(place.latitude === undefined ? {} : { latitude: place.latitude }),
			...(place.longitude === undefined ? {} : { longitude: place.longitude }),
			...(place.locationData === undefined
				? {}
				: { location_data: place.locationData }),
		})),
	});

	let res: Response;
	try {
		res = await fetch(`${baseUrl(creds)}/a/${domain}/api/location/v2/`, {
			method: "PATCH",
			headers: {
				Authorization: authHeader(creds),
				"Content-Type": "application/json",
			},
			body,
			redirect: "manual",
		});
	} catch (error) {
		log.warn("[commcare] location push unreachable", {
			domain,
			error: error instanceof Error ? error.message : String(error),
		});
		return { success: false, status: 503, message: "", mayHaveLanded: true };
	}

	if (res.status !== 202) return refusedPush(res, domain, places.length);

	let parsed: unknown;
	try {
		parsed = await res.json();
	} catch {
		log.error("[commcare] location push returned non-JSON", undefined, {
			domain,
		});
		return { success: false, status: 502, message: "", mayHaveLanded: true };
	}
	if (
		!Array.isArray(parsed) ||
		parsed.length !== places.length ||
		new Set(parsed).size !== parsed.length ||
		!parsed.every(
			(id, index): id is string =>
				typeof id === "string" &&
				/^[A-Za-z0-9_-]+$/.test(id) &&
				(places[index].locationId === undefined ||
					id === places[index].locationId),
		)
	) {
		log.error(
			"[commcare] location push answered an unusable shape",
			undefined,
			{
				domain,
				sent: places.length,
				received: Array.isArray(parsed) ? parsed.length : null,
			},
		);
		return { success: false, status: 502, message: "", mayHaveLanded: true };
	}
	return { ids: parsed };
}

/**
 * Read a refused batch once: CommCare HQ's sentence, then the log line.
 *
 * `LocationAPIError` is a tastypie `BadRequest`, which tastypie answers as
 * 400 with `{"error": "<message>"}`. Everything else — the bodyless 403s,
 * the 401 subscription message, an edge refusal — has no sentence worth
 * repeating, and the caller says the useful thing instead.
 */
async function refusedPush(
	res: Response,
	domain: string,
	count: number,
): Promise<HqLocationPushRefusal> {
	let body = "";
	try {
		body = await res.text();
	} catch {}
	let message = "";
	try {
		const parsed: unknown = JSON.parse(body);
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			typeof (parsed as { error?: unknown }).error === "string"
		) {
			message = (parsed as { error: string }).error;
		}
	} catch {}
	const refusal = {
		domain,
		status: res.status,
		count,
		body: body.slice(0, 200),
	};
	if (res.status === 401 || res.status === 403) {
		log.warn("[commcare] location push refused", refusal);
	} else {
		log.error("[commcare] location push failed", undefined, refusal);
	}
	return {
		success: false,
		status: res.status,
		message,
		mayHaveLanded: ![400, 401, 403].includes(res.status),
	};
}
