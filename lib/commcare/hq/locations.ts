import { withHqRequestDeadline } from "./deadline";
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
	HQ_LOCATION_INVENTORY_MAX_ROWS,
	HQ_LOCATION_LIST_MAX_BYTES,
	HQ_LOCATION_PATCH_ACK_MAX_BYTES,
	HQ_LOCATION_TYPE_LIST_MAX_BYTES,
	HQ_LOCATION_TYPE_LIST_MAX_ROWS,
} from "./bounds";
import {
	baseUrl,
	type CommCareApiError,
	type CommCareCredentials,
	HQ_MALFORMED_ANSWER,
	type HqAnswer,
	hqTextFacts,
	INVALID_DOMAIN_SLUG,
	isValidDomainSlug,
	readAnswerJson,
	readRefusedBody,
	sendHq,
} from "./http";
import { parseHqJsonText } from "./jsonText";
import {
	exactLocationJson,
	observedLocationMetadata,
	parseLocationJson,
} from "./locationMetadata";
import { giveBackHeld } from "./memoryMeter";
import {
	HQ_LIST_MOVED,
	type HqPastLimit,
	isHqObject,
	readHqCollection,
} from "./readCollection";
import { readHqJson } from "./readJson";

/** The reader's memory lease holds the accepted page bytes through adoption.
 * An abandoned observation returns its charges before restarting the inventories. */
const inventoryCharges = new WeakMap<object, number>();
export function releaseLocationInventory(items: readonly unknown[]) {
	const bytes = inventoryCharges.get(items);
	if (bytes !== undefined) {
		inventoryCharges.delete(items);
		giveBackHeld("text", bytes);
	}
}
function retainInventory<T>(items: T[], bytes: number): T[] {
	inventoryCharges.set(items, bytes);
	return items;
}

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
	/** Present only after v1 and v2 agreed on one source place. */
	readonly observation?: {
		readonly externalId: string | null;
		readonly nameIsNull: boolean;
		readonly wire: Readonly<Record<string, string>>;
		readonly worker: Readonly<Record<string, string>>;
	};
	/** CommCare HQ's `location_id` — the durable key the ledger stores. */
	readonly locationId: string;
	readonly name: string;
	/** Domain-unique, and the key every bulk upload matches on. */
	readonly siteCode: string;
	readonly locationTypeCode: string;
	/** Null at the top. CommCare HQ spells that as `""`; this does not. */
	readonly parentLocationId: string | null;
	/**
	 * The coordinates as CommCare HQ returned them: tastypie serializes
	 * `locations/models.py::SQLLocation.latitude`, a decimal of ten places,
	 * as a string, so `12.5` reads `"12.5000000000"`. Null where the place
	 * holds none.
	 */
	readonly latitude: string | null;
	readonly longitude: string | null;
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
	readonly name?: string | null;
	readonly siteCode?: string;
	readonly locationTypeCode?: string;
	readonly parentLocationId?: string;
	/** Exact decimal strings. A coordinate is never a float on this wire. */
	readonly latitude?: string | null;
	readonly longitude?: string | null;
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
 * How many to ask for per page when reading: each resource's largest.
 *
 * `v0_6.py::LocationResource.Meta.max_limit` is 5000 and the level
 * resource takes tastypie's default 1000. Nova has to read the WHOLE list
 * either way — the resource has no filter that takes a set of site codes,
 * so there is no smaller question to ask — and asking in the largest pages
 * keeps most project spaces to one request, one evaluation of a list HQ
 * serves with no order (`v0_6.py::LocationResource.Meta.queryset`).
 */
const PLACE_PAGE_SIZE = 5_000;
const LEVEL_PAGE_SIZE = 1_000;

/**
 * A bound on pages followed, past each list's row limit at its page size,
 * so reaching it means a list that never ends rather than a large one.
 */
const MAX_PLACE_PAGES = 21;
const MAX_LEVEL_PAGES = 11;

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
	options: { readonly cancel?: AbortSignal } = {},
): Promise<readonly HqLocationType[] | CommCareApiError> {
	if (!isValidDomainSlug(domain)) return INVALID_DOMAIN_SLUG;
	const list = await readHqCollection(creds, {
		label: "location type list",
		firstUrl: `${baseUrl(creds)}/a/${domain}/api/location_type/v1/?limit=${LEVEL_PAGE_SIZE}`,
		maxPages: MAX_LEVEL_PAGES,
		maxRows: HQ_LOCATION_TYPE_LIST_MAX_ROWS,
		maxBytes: HQ_LOCATION_TYPE_LIST_MAX_BYTES,
		row: (value) => (isHqObject(value) ? value : null),
		identity: (value) => String(value.id),
		cancel: options.cancel,
	});
	if ("success" in list) return list;
	/* Every place is judged against these levels, so a list past Nova's
	 * bound is no answer, never a short list. */
	if ("kind" in list)
		return { success: false, status: 502, cause: "too-large" };
	let kept = false;
	try {
		const raw = list.rows;

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
			if (parentCode === undefined) return HQ_LIST_MOVED;
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
		const parents = new Map(
			types.map((level) => [level.code, level.parentCode]),
		);
		for (const level of types) {
			const visited = new Set<string>();
			let code: string | null = level.code;
			while (code !== null) {
				if (visited.has(code)) return HQ_LIST_MOVED;
				visited.add(code);
				code = parents.get(code) ?? null;
			}
		}
		kept = true;
		return retainInventory(types, list.bytes);
	} finally {
		if (!kept) giveBackHeld("text", list.bytes);
	}
}

function malformedInventory(part: string): CommCareApiError {
	log.error("[commcare] organization inventory is malformed", undefined, {
		part,
	});
	return HQ_MALFORMED_ANSWER;
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
export function listHqLocations(
	creds: CommCareCredentials,
	domain: string,
	options?: { readonly cancel?: AbortSignal },
): Promise<readonly HqLocation[] | CommCareApiError>;
/**
 * With `stopPast`: `past-limit` where the project space holds more places
 * than it, read from the first page's `meta.total_count` after one request,
 * or where the places pass `bounds.ts::HQ_LOCATION_LIST_MAX_BYTES`. Without
 * it the read is a publish's inventory, held to
 * `HQ_LOCATION_INVENTORY_MAX_ROWS` and the same byte bound, and a list past
 * either is no answer (`too-large`): an inventory Nova did not read whole
 * cannot say a site code is free.
 */
export function listHqLocations(
	creds: CommCareCredentials,
	domain: string,
	options: { readonly cancel?: AbortSignal; readonly stopPast: number },
): Promise<readonly HqLocation[] | HqPastLimit | CommCareApiError>;
export async function listHqLocations(
	creds: CommCareCredentials,
	domain: string,
	options: { readonly cancel?: AbortSignal; readonly stopPast?: number } = {},
): Promise<readonly HqLocation[] | HqPastLimit | CommCareApiError> {
	if (!isValidDomainSlug(domain)) return INVALID_DOMAIN_SLUG;
	const { cancel, stopPast } = options;
	const list = await readHqCollection(creds, {
		label: "location list",
		parse: parseLocationJson,
		digestRow: exactLocationJson,
		firstUrl: `${baseUrl(creds)}/a/${domain}/api/location/v2/?limit=${PLACE_PAGE_SIZE}`,
		maxPages: MAX_PLACE_PAGES,
		maxRows: stopPast ?? HQ_LOCATION_INVENTORY_MAX_ROWS,
		maxBytes: HQ_LOCATION_LIST_MAX_BYTES,
		row: (value) => (isHqObject(value) ? value : null),
		identity: (value) => String(value.location_id),
		cancel,
	});
	if ("success" in list) return list;
	if ("kind" in list)
		return stopPast === undefined
			? { success: false, status: 502, cause: "too-large" }
			: list;
	let kept = false;
	try {
		const raw = list.rows;

		const places: HqLocation[] = [];
		const ids = new Set<string>();
		const codes = new Set<string>();
		for (const place of raw) {
			if (
				!isHqObject(place) ||
				typeof place.location_id !== "string" ||
				place.location_id.trim() === "" ||
				typeof place.site_code !== "string" ||
				(place.name !== null && typeof place.name !== "string") ||
				typeof place.location_type_code !== "string" ||
				(place.parent_location_id !== null &&
					typeof place.parent_location_id !== "string") ||
				(place.latitude !== null && typeof place.latitude !== "string") ||
				(place.longitude !== null && typeof place.longitude !== "string") ||
				!isHqObject(place.location_data) ||
				ids.has(place.location_id) ||
				codes.has(place.site_code)
			)
				return malformedInventory("place");
			ids.add(place.location_id);
			codes.add(place.site_code);
			const projected: HqLocation = {
				locationId: place.location_id,
				name: place.name ?? "",
				siteCode: place.site_code,
				locationTypeCode: place.location_type_code,
				parentLocationId:
					place.parent_location_id === "" ? null : place.parent_location_id,
				latitude: place.latitude,
				longitude: place.longitude,
				// HQ validates modeled fields, then replaces the entire metadata
				// object. Foreign JSON values must survive that replacement too.
				values: place.location_data,
			};
			v2Source.set(projected, {
				domain: place.domain,
				modified: place.last_modified,
				name: place.name,
			});
			places.push(projected);
		}
		kept = true;
		return retainInventory(places, list.bytes);
	} finally {
		if (!kept) giveBackHeld("text", list.bytes);
	}
}

const v2Source = new WeakMap<
	HqLocation,
	{ domain: unknown; modified: unknown; name: unknown }
>();

function parentLocationKey(
	value: unknown,
	creds: CommCareCredentials,
	domain: string,
): string | null | undefined {
	if (value === null) return null;
	if (typeof value !== "string" || !value) return undefined;
	try {
		const url = new URL(value, baseUrl(creds));
		if (
			url.origin !== new URL(baseUrl(creds)).origin ||
			url.username ||
			url.password ||
			url.hash ||
			url.search
		)
			return undefined;
		for (const prefix of [
			`/a/${domain}/api/location/v1/`,
			`/a/${domain}/api/v0.5/location/`,
		]) {
			if (!url.pathname.startsWith(prefix)) continue;
			const suffix = url.pathname.slice(prefix.length).replace(/\/$/, "");
			if (suffix && !suffix.includes("/")) return decodeURIComponent(suffix);
		}
	} catch {}
	return undefined;
}

/** A stable join on durable place ID. The v1 parent and type URIs are
 * compared locally within this server and project space; no response URL
 * is followed. An unread or absent field never becomes an empty value. */
export async function listHqLocationObservations(
	creds: CommCareCredentials,
	domain: string,
	levels: readonly HqLocationType[],
	cancel?: AbortSignal,
): Promise<readonly HqLocation[] | CommCareApiError> {
	const places = await listHqLocations(creds, domain, { cancel });
	if ("success" in places) return places;
	let joinedSuccessfully = false;
	let joinedBytes = 0;
	try {
		const list = await readHqCollection(creds, {
			label: "place external IDs",
			firstUrl: `${baseUrl(creds)}/a/${domain}/api/location/v1/?limit=1000`,
			maxPages: Math.ceil(HQ_LOCATION_INVENTORY_MAX_ROWS / 1000) + 1,
			maxRows: HQ_LOCATION_INVENTORY_MAX_ROWS,
			maxBytes: HQ_LOCATION_LIST_MAX_BYTES,
			parse: parseLocationJson,
			digestRow: exactLocationJson,
			row: (value) =>
				isHqObject(value) && typeof value.location_id === "string"
					? value
					: null,
			identity: (row) => String(row.location_id),
			cancel,
		});
		if ("success" in list) return list;
		if ("kind" in list)
			return { success: false, status: 502, cause: "too-large" };
		joinedBytes = list.bytes;
		if (places.length !== list.rows.length) return HQ_LIST_MOVED;
		const details = new Map(list.rows.map((row) => [row.location_id, row]));
		const codes = new Map(levels.map((level) => [level.id, level.code]));
		const joined: HqLocation[] = [];
		for (const place of places) {
			const v1 = details.get(place.locationId);
			const v2 = v2Source.get(place);
			if (!v1 || !v2) return HQ_LIST_MOVED;
			if (
				v2.domain !== domain ||
				v1.domain !== domain ||
				typeof v2.modified !== "string" ||
				!v2.modified ||
				typeof v1.last_modified !== "string" ||
				!v1.last_modified ||
				(v1.external_id !== null && typeof v1.external_id !== "string") ||
				!isHqObject(v1.location_data)
			)
				return malformedInventory("external ID observation");
			if (
				v1.last_modified !== v2.modified ||
				v1.name !== v2.name ||
				v1.site_code !== place.siteCode ||
				v1.latitude !== place.latitude ||
				v1.longitude !== place.longitude ||
				parentLocationKey(v1.parent, creds, domain) !==
					place.parentLocationId ||
				parentLevelCode(v1.location_type, codes, creds, domain) !==
					place.locationTypeCode ||
				exactLocationJson(v1.location_data) !== exactLocationJson(place.values)
			)
				return HQ_LIST_MOVED;
			joined.push({
				...place,
				observation: {
					externalId: v1.external_id,
					nameIsNull: v2.name === null,
					...observedLocationMetadata(place.values),
				},
			});
		}
		joinedSuccessfully = true;
		const firstBytes = inventoryCharges.get(places) ?? 0;
		inventoryCharges.delete(places);
		return retainInventory(joined, firstBytes + list.bytes);
	} finally {
		if (!joinedSuccessfully) {
			releaseLocationInventory(places);
			giveBackHeld("text", joinedBytes);
		}
	}
}

export async function readHqPlaceExternalId(
	creds: CommCareCredentials,
	domain: string,
	id: string,
	cancel?: AbortSignal,
): Promise<{ externalId: string | null; siteCode: string } | CommCareApiError> {
	if (!isValidDomainSlug(domain)) return INVALID_DOMAIN_SLUG;
	if (!id || [".", ".."].includes(id))
		return malformedInventory("place detail id");
	const result = await readHqJson(
		creds,
		`${baseUrl(creds)}/a/${domain}/api/location/v1/${encodeURIComponent(id)}/`,
		"place external ID",
		{ cancel, maxBytes: HQ_LOCATION_LIST_MAX_BYTES },
	);
	if ("success" in result) return result;
	try {
		const row = result.data;
		if (
			!isHqObject(row) ||
			row.domain !== domain ||
			row.location_id !== id ||
			typeof row.site_code !== "string" ||
			(row.external_id !== null && typeof row.external_id !== "string")
		)
			return malformedInventory("place external ID");
		return { externalId: row.external_id, siteCode: row.site_code };
	} finally {
		giveBackHeld("text", result.bytes);
	}
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

	return withHqRequestDeadline(async (signal) => {
		let res: HqAnswer;
		try {
			res = await sendHq(
				creds,
				`${baseUrl(creds)}/a/${domain}/api/location/v2/`,
				{
					method: "PATCH",
					contentType: "application/json",
					body,
					signal,
				},
			);
		} catch (error) {
			log.warn("[commcare] location push unreachable", {
				domain,
				error: error instanceof Error ? error.message : String(error),
			});
			return { success: false, status: 503, message: "", mayHaveLanded: true };
		}

		if (res.status !== 202)
			return await refusedPush(res, domain, places.length);

		const answer = await readAnswerJson(res, HQ_LOCATION_PATCH_ACK_MAX_BYTES);
		if (answer.kind === "unreadable") {
			/* An acknowledgement longer than Nova reads is one it cannot read,
			 * and the batch may have landed either way. */
			log.error("[commcare] location push answer is unreadable", undefined, {
				domain,
				why: answer.why,
			});
			return {
				success: false,
				status: signal.aborted ? 503 : 502,
				message: "",
				mayHaveLanded: true,
			};
		}
		const parsed = answer.data;
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
			return {
				success: false,
				status: 502,
				message: "",
				mayHaveLanded: true,
			};
		}
		return { ids: parsed };
	}, 30_000);
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
	res: HqAnswer,
	domain: string,
	count: number,
): Promise<HqLocationPushRefusal> {
	const read = await readRefusedBody(res);
	/* A refusal past the bound keeps no sentence: its head is not JSON. */
	const body = read.kind === "text" && read.whole ? read.text : "";
	let message = "";
	try {
		const parsed: unknown = parseHqJsonText(body);
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			typeof (parsed as { error?: unknown }).error === "string"
		) {
			message = (parsed as { error: string }).error;
		}
	} catch {}
	/* HQ's sentence names a place and its site code, so the line holds the
	 * body's shape and length, never its words. */
	const facts = hqTextFacts(read.kind === "text" ? read.text : "");
	const refusal = {
		domain,
		status: res.status,
		count,
		body: facts.shape,
		bodyBytes: read.kind === "text" ? read.bytes : 0,
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
