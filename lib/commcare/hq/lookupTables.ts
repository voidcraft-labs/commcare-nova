import "server-only";

/**
 * The lookup tables one CommCare HQ project space holds, and how Nova puts
 * its own there.
 *
 * Two endpoints, deliberately unlike each other, because CommCare HQ has
 * no single one that does both:
 *
 *   * **Reading** goes through the tastypie `lookup_table` resource. It is
 *     the only way to find out what a project space already holds, and
 *     Nova needs that before it writes anything: the upload matches tables
 *     BY TAG (`upload/run_upload.py::table_key`), so pushing blind would
 *     silently take over a table somebody else made that happens to share
 *     a name.
 *   * **Writing** goes through the Excel fixture upload. The row resource
 *     keys rows by a server-minted UUID with no natural key, so a JSON row
 *     sync would make Nova keep per-row remote-id bookkeeping for data
 *     whose whole identity is its content. The workbook takes a table's
 *     definition and rows together and replaces them wholesale, which is
 *     what Nova actually means.
 *
 * The two also authorize differently, and the asymmetry is load-bearing.
 * The read is a tastypie resource, so it needs the paid API_ACCESS
 * privilege on the domain (`api/resources/__init__.py::HqBaseResource.dispatch`)
 * AND the account's own Access APIs permission
 * (`api/resources/auth.py::LoginAndDomainAuthentication.is_authenticated`).
 * The upload is a plain view behind `@api_auth()` and
 * `@require_can_edit_fixtures`, needing neither. So a project space can
 * accept the push while refusing to say what it already holds — which is
 * exactly the case Nova must refuse rather than push into, and why the
 * read's failure is a blocking preflight edge rather than a shrug.
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
	WAF_PADDING,
	warnAndReturnError,
} from "./http";

/** One lookup table as CommCare HQ reports it. */
export interface HqLookupTable {
	/** CommCare HQ's own id: the table UUID's hex, no hyphens. */
	readonly id: string;
	/** The tag Nova matches on, and the name a person sees in CommCare HQ. */
	readonly tag: string;
	readonly isGlobal: boolean;
	/** Field names in CommCare HQ's stored order. */
	readonly fields: readonly string[];
}

/** Tastypie's list envelope, only the parts Nova reads. */
interface LookupTableListResponse {
	readonly meta?: { readonly next?: string | null };
	readonly objects?: readonly {
		readonly id?: unknown;
		readonly tag?: unknown;
		readonly is_global?: unknown;
		readonly fields?: unknown;
	}[];
}

/**
 * How many tables to ask for at a time.
 *
 * Tastypie caps a page at its own `max_limit`, and asking for more than it
 * allows is answered with a page rather than an error, so the loop below
 * follows `meta.next` regardless of what this asks for.
 */
const LOOKUP_TABLE_PAGE_SIZE = 100;

/**
 * A bound on how many pages Nova will follow.
 *
 * A pagination cursor that never terminates would otherwise spin here
 * forever holding a request open. Twenty pages is far past any plausible
 * project space, so reaching it means the cursor is wrong rather than the
 * data being large.
 */
const MAX_LOOKUP_TABLE_PAGES = 20;

function toHqLookupTable(raw: {
	readonly id?: unknown;
	readonly tag?: unknown;
	readonly is_global?: unknown;
	readonly fields?: unknown;
}): HqLookupTable | null {
	if (typeof raw.id !== "string" || typeof raw.tag !== "string") return null;
	/* `dehydrate_fields` answers `[{field_name, properties}]`; older rows
	 * and the XML serializer spell it `name`. Reading both is not an alias
	 * layer — Nova stores neither, it only needs enough to compare shape
	 * when reporting a conflict. */
	const fields = Array.isArray(raw.fields)
		? raw.fields.flatMap((field): string[] => {
				if (typeof field === "string") return [field];
				if (field !== null && typeof field === "object") {
					const named = field as { field_name?: unknown; name?: unknown };
					if (typeof named.field_name === "string") return [named.field_name];
					if (typeof named.name === "string") return [named.name];
				}
				return [];
			})
		: [];
	return {
		id: raw.id,
		tag: raw.tag,
		isGlobal: raw.is_global === true,
		fields,
	};
}

/**
 * Every lookup table the project space holds.
 *
 * A refusal here is never treated as "there are none": that reading would
 * turn a permissions problem into a silent takeover of every same-named
 * table on the target.
 */
export async function listHqLookupTables(
	creds: CommCareCredentials,
	domain: string,
): Promise<readonly HqLookupTable[] | CommCareApiError> {
	if (!isValidDomainSlug(domain)) return INVALID_DOMAIN_SLUG;

	const tables: HqLookupTable[] = [];
	let url = `${baseUrl(creds)}/a/${domain}/api/lookup_table/v1/?limit=${LOOKUP_TABLE_PAGE_SIZE}`;
	for (let page = 0; page < MAX_LOOKUP_TABLE_PAGES; page += 1) {
		let res: Response;
		try {
			res = await fetch(url, {
				headers: { Authorization: authHeader(creds) },
			});
		} catch (error) {
			log.warn("[commcare] lookup table list unreachable", {
				domain,
				error: error instanceof Error ? error.message : String(error),
			});
			return { success: false, status: 503 };
		}
		if (!res.ok) {
			/* Warn rather than error: a project space without the API
			 * privilege answers this on every publish of a table-bearing
			 * app, and it is a state a person resolves in CommCare HQ
			 * rather than a fault in Nova. */
			return warnAndReturnError("lookup table list failed", res);
		}
		let body: LookupTableListResponse;
		try {
			body = (await res.json()) as LookupTableListResponse;
		} catch {
			log.error("[commcare] lookup table list returned non-JSON", undefined, {
				domain,
			});
			return { success: false, status: 502 };
		}
		for (const raw of body.objects ?? []) {
			const table = toHqLookupTable(raw);
			if (table !== null) tables.push(table);
		}
		const next = body.meta?.next;
		if (typeof next !== "string" || next === "") return tables;
		/* Resolve against the server's own base so a rewritten `next`
		 * cannot walk this request off CommCare HQ. */
		const resolved = new URL(next, baseUrl(creds));
		if (resolved.origin !== new URL(baseUrl(creds)).origin) {
			log.error(
				"[commcare] lookup table pagination left CommCare HQ",
				undefined,
				{
					domain,
				},
			);
			return { success: false, status: 502 };
		}
		url = resolved.toString();
	}
	log.error("[commcare] lookup table list did not terminate", undefined, {
		domain,
		pages: MAX_LOOKUP_TABLE_PAGES,
	});
	return { success: false, status: 508 };
}

/** What CommCare HQ said about a workbook it accepted. */
export interface FixtureUploadResult {
	readonly success: true;
	/** CommCare HQ's own summary, shown to the person who published. */
	readonly message: string;
}

/**
 * CommCare HQ answers the upload 200 with its verdict in the BODY.
 *
 * `views.py::UploadFixtureAPIResponse.response_codes` maps its three
 * statuses to 200 / 402 / 405, and `JsonResponse` carries all three over
 * HTTP 200. Reading the HTTP status alone would report every refusal as a
 * success.
 */
const FIXTURE_UPLOAD_SUCCESS_CODE = 200;

/**
 * `warning`: the workbook was processed and some of it did not take.
 *
 * Nova treats it as a refusal — it pushes whole tables, and a project
 * space holding half of one no longer matches the app about to be sent to
 * it. But it is a refusal about data that IS partly over there:
 * `_upload_fixture_api` reaches this only after `upload_fixture_file` ran,
 * so the tables in the workbook exist on the project space and the caller
 * has to record what it now owns rather than walk away from it. `fail`
 * (405) is the opposite — `validate_fixture_file_format` raised before
 * anything was written.
 */
const FIXTURE_UPLOAD_PARTIAL_CODE = 402;

interface FixtureUploadResponse {
	readonly message?: unknown;
	readonly code?: unknown;
}

/**
 * A refusal that keeps CommCare HQ's own sentence.
 *
 * The synchronous path exists for this message and nothing else — it is
 * `result.get_display_message()` on a warning and the formatting
 * complaint on a failure, both written for a person to read and both
 * naming the row or the column Nova could not have guessed at. Dropping
 * it would leave a person told only that the upload was refused.
 */
export interface FixtureUploadRefusal extends CommCareApiError {
	/** Empty when the refusal came from below CommCare HQ's own view. */
	readonly message: string;
	/**
	 * True when Nova cannot rule out that tables reached the project
	 * space, so the caller has to go and look rather than walk away.
	 *
	 * Only three answers rule it out: the `fail` verdict, which
	 * `validate_fixture_file_format` raises before `upload_fixture_file`
	 * runs; a refusal from the permission layer, which never reaches the
	 * view; and an edge that answered instead of CommCare HQ. Everything
	 * else — a 5xx out of the view, a connection that died waiting, an
	 * answer Nova cannot read — counts as landed, because `_run_upload` is
	 * NOT one transaction: only `flush` is `@atomic`, and `process_table`
	 * calls it mid-pass once a table has more than a thousand rows to
	 * write or delete. A big workbook that dies after that flush leaves
	 * real tables behind, and a caller told nothing landed would record
	 * nothing and meet its own tables as a stranger's next publish.
	 */
	readonly mayHaveLanded: boolean;
}

/**
 * Replace the project space's copy of every table in the workbook.
 *
 * Synchronous on purpose. The endpoint's async mode returns a poll URL and
 * skips validation entirely — `tasks.py::fixture_upload_async` calls
 * `upload_fixture_file` without `validate_fixture_file_format`, and
 * `views.py::fixture_api_upload_status` reports only "Upload complete."
 * with the row-level errors dropped. The synchronous path validates first
 * and hands back `result.get_display_message()`, so it is the only one
 * that can tell a person what was wrong with their data.
 *
 * `replace` is CommCare HQ's own word and its own semantic: with it, each
 * table in the workbook ends up holding exactly the rows the workbook
 * carries (`run_upload.py::_run_upload` passes it as `delete_missing`).
 * Tables NOT in the workbook are untouched either way
 * (`tables.process(..., delete_missing=False)`), which is what lets Nova
 * push only the tables one app references without disturbing the rest of
 * the project space.
 */
export async function uploadLookupTableWorkbook(
	creds: CommCareCredentials,
	domain: string,
	workbook: Uint8Array,
	options: { readonly replace: boolean },
): Promise<FixtureUploadResult | FixtureUploadRefusal> {
	if (!isValidDomainSlug(domain))
		return { ...INVALID_DOMAIN_SLUG, message: "", mayHaveLanded: false };

	const form = new FormData();
	/* First, so the workbook's own bytes start past the WAF's body
	 * inspection window. An `.xlsx` is a ZIP of XML parts, which is the
	 * same shape that already tripped the rule on the media bundle. */
	form.append("waf_padding", WAF_PADDING);
	form.append(
		"file-to-upload",
		new Blob([new Uint8Array(workbook)], {
			type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		}),
		"lookup-tables.xlsx",
	);
	form.append("replace", options.replace ? "true" : "false");

	let res: Response;
	try {
		res = await fetch(`${baseUrl(creds)}/a/${domain}/fixtures/fixapi/`, {
			method: "POST",
			headers: { Authorization: authHeader(creds) },
			body: form,
		});
	} catch (error) {
		log.error("[commcare] lookup table upload unreachable", undefined, {
			domain,
			error: error instanceof Error ? error.message : String(error),
		});
		/* The request went out and no answer came back, so what CommCare HQ
		 * did with the workbook is unknown. */
		return { success: false, status: 503, message: "", mayHaveLanded: true };
	}
	if (!res.ok) {
		/* No verdict body, so no sentence to keep. Whether anything landed
		 * depends on how far the request got: the permission layer and the
		 * edge both answer before `_run_upload` can run, while a 5xx out
		 * of the view means it ran and stopped somewhere unknown. */
		const refusal = await logAndReturnError("lookup table upload failed", res);
		return {
			...refusal,
			message: "",
			mayHaveLanded: res.status >= 500 && refusal.edgeRefusal !== true,
		};
	}
	let body: FixtureUploadResponse;
	try {
		body = (await res.json()) as FixtureUploadResponse;
	} catch {
		log.error("[commcare] lookup table upload returned non-JSON", undefined, {
			domain,
		});
		/* CommCare HQ answered something Nova cannot read, which says
		 * nothing about what it did with the workbook. */
		return { success: false, status: 502, message: "", mayHaveLanded: true };
	}
	const message = typeof body.message === "string" ? body.message : "";
	if (body.code !== FIXTURE_UPLOAD_SUCCESS_CODE) {
		log.error("[commcare] lookup table upload refused", undefined, {
			domain,
			code: typeof body.code === "number" ? body.code : null,
			message: message.substring(0, 200),
		});
		/* A warning is a refusal here. CommCare HQ warns when some rows
		 * landed and others did not, and Nova pushes whole tables: a
		 * partial result is a project space whose data no longer matches
		 * the app that was about to be sent to it. */
		return {
			success: false,
			status: typeof body.code === "number" ? body.code : 502,
			message,
			mayHaveLanded: body.code === FIXTURE_UPLOAD_PARTIAL_CODE,
		};
	}
	return { success: true, message };
}
