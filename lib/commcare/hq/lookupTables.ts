import { withHqRequestDeadline } from "./deadline";
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
	writeMayHaveLanded,
} from "./http";
import { isHqObject, readHqCollection } from "./readCollection";

/** One lookup table as CommCare HQ reports it. */
export interface HqLookupTable {
	/** CommCare HQ's own id: the table UUID's hex, no hyphens. */
	readonly id: string;
	/** The tag Nova matches on, and the name a person sees in CommCare HQ. */
	readonly tag: string;
	readonly isGlobal: boolean;
	/** Field names in CommCare HQ's stored order. */
	readonly fields: readonly string[];
	/** Each field's property names, in HQ's order, keyed by field name. */
	readonly fieldProperties: Readonly<Record<string, readonly string[]>>;
	/** The row attributes the table's definition names, in HQ's order. */
	readonly itemAttributes: readonly string[];
}

/**
 * One row of a lookup table as `fixtures/resources/v0_1.py::FixtureResource`
 * serves it. A field holds its one value as a string when every field of the
 * row holds one (`fixtures/models.py::LookupTableRow.fields_without_attributes`),
 * and otherwise every field of the row holds its ordered values with their
 * properties (`LookupTableItemResource.dehydrate_fields`).
 */
export interface HqFixtureRow {
	readonly id: string;
	readonly fields: Readonly<
		Record<
			string,
			| string
			| readonly {
					readonly value: string;
					readonly properties: Readonly<Record<string, string>>;
			  }[]
		>
	>;
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

function toHqLookupTable(raw: unknown): HqLookupTable | null {
	if (
		!isHqObject(raw) ||
		typeof raw.id !== "string" ||
		raw.id.trim() === "" ||
		typeof raw.tag !== "string" ||
		raw.tag.trim() === ""
	)
		return null;
	/* `dehydrate_fields` answers `[{field_name, properties}]`; older rows
	 * and the XML serializer spell it `name`. Reading both is not an alias
	 * layer: the names identify the columns, and the properties are what the
	 * drift comparison reads of each. */
	const fields: string[] = [];
	const fieldProperties: Record<string, readonly string[]> = {};
	if (Array.isArray(raw.fields)) {
		for (const field of raw.fields) {
			if (typeof field === "string") {
				fields.push(field);
				fieldProperties[field] = [];
				continue;
			}
			if (!isHqObject(field)) continue;
			const name =
				typeof field.field_name === "string"
					? field.field_name
					: typeof field.name === "string"
						? field.name
						: null;
			if (name === null) continue;
			fields.push(name);
			fieldProperties[name] = Array.isArray(field.properties)
				? field.properties.filter(
						(property): property is string => typeof property === "string",
					)
				: [];
		}
	}
	const itemAttributes = Array.isArray(raw.item_attributes)
		? raw.item_attributes.filter(
				(attribute): attribute is string => typeof attribute === "string",
			)
		: [];
	return {
		id: raw.id,
		tag: raw.tag,
		isGlobal: raw.is_global === true,
		fields,
		fieldProperties,
		itemAttributes,
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

	const rows = await readHqCollection(
		creds,
		`${baseUrl(creds)}/a/${domain}/api/lookup_table/v1/?limit=${LOOKUP_TABLE_PAGE_SIZE}`,
		"lookup table list",
		MAX_LOOKUP_TABLE_PAGES,
	);
	if ("success" in rows) return rows;
	const tables: HqLookupTable[] = [];
	for (const raw of rows) {
		const table = toHqLookupTable(raw);
		if (table === null) {
			log.error("[commcare] lookup table identity is malformed", undefined, {
				domain,
			});
			return { success: false, status: 502 };
		}
		tables.push(table);
	}
	return tables;
}

/**
 * A bound on how many pages of one table's rows Nova will follow. HQ serves
 * at most 1,000 rows a page whatever `limit` asks, so this admits a table of
 * a million rows and stops a cursor that never terminates. Each page has its
 * own request deadline, so a long table is never cut off by one deadline
 * meant for a single request.
 */
const MAX_FIXTURE_ROW_PAGES = 1_000;

/** How many tables' rows a publish reads from CommCare HQ at once. */
export const LOOKUP_ROWS_READ_CONCURRENCY = 4;

function toFixtureRowFields(
	raw: Record<string, unknown>,
): HqFixtureRow["fields"] | null {
	const fields: Record<string, HqFixtureRow["fields"][string]> = {};
	const values = Object.values(raw);
	/* The two shapes never mix in one row: `FixtureResource.dehydrate_fields`
	 * falls back to the `field_list` form for the whole row as soon as one of
	 * its fields holds more than one value. */
	if (values.every((value) => typeof value === "string")) {
		for (const [name, value] of Object.entries(raw)) {
			fields[name] = value as string;
		}
		return fields;
	}
	for (const [name, value] of Object.entries(raw)) {
		if (!isHqObject(value) || !Array.isArray(value.field_list)) return null;
		const list: { value: string; properties: Record<string, string> }[] = [];
		for (const item of value.field_list) {
			if (
				!isHqObject(item) ||
				typeof item.field_value !== "string" ||
				!isHqObject(item.properties) ||
				!Object.values(item.properties).every(
					(property) => typeof property === "string",
				)
			)
				return null;
			list.push({
				value: item.field_value,
				properties: item.properties as Record<string, string>,
			});
		}
		fields[name] = list;
	}
	return fields;
}

/**
 * Every row of one lookup table, in HQ's own order
 * (`fixtures/models.py::LookupTableRowManager.iter_rows` sorts by
 * `sort_key`), with the total HQ reports for it.
 *
 * `FixtureResource` filtered by `fixture_type_id` is the one read that
 * answers a single table's rows. It needs the same API access the table
 * list does. A row that holds a field with no value makes HQ's serializer
 * raise and the whole read fail, which is a refusal here like any other.
 */
export async function readHqLookupTableRows(
	creds: CommCareCredentials,
	domain: string,
	tableId: string,
): Promise<
	| { readonly totalCount: number; readonly rows: readonly HqFixtureRow[] }
	| CommCareApiError
> {
	if (!isValidDomainSlug(domain) || !/^[\w-]+$/.test(tableId))
		return INVALID_DOMAIN_SLUG;
	const firstUrl = `${baseUrl(creds)}/a/${domain}/api/fixture/v1/?fixture_type_id=${encodeURIComponent(tableId)}`;
	const reported: { totalCount: number | null } = { totalCount: null };
	const raw = await readHqCollection(
		creds,
		firstUrl,
		"lookup table rows",
		MAX_FIXTURE_ROW_PAGES,
		{
			deadline: "page",
			onMeta: (meta) => {
				if (
					reported.totalCount === null &&
					typeof meta.total_count === "number" &&
					Number.isSafeInteger(meta.total_count) &&
					meta.total_count >= 0
				)
					reported.totalCount = meta.total_count;
			},
		},
	);
	if ("success" in raw) return raw;
	const rows: HqFixtureRow[] = [];
	for (const value of raw) {
		if (
			!isHqObject(value) ||
			typeof value.id !== "string" ||
			value.id.trim() === "" ||
			!isHqObject(value.fields)
		) {
			log.error("[commcare] lookup table row is malformed", undefined, {
				domain,
			});
			return { success: false, status: 502, cause: "malformed" };
		}
		const fields = toFixtureRowFields(value.fields);
		if (fields === null) {
			log.error("[commcare] lookup table row fields are malformed", undefined, {
				domain,
			});
			return { success: false, status: 502, cause: "malformed" };
		}
		rows.push({ id: value.id, fields });
	}
	/* The total is the first page's, and the pages together must hold
	 * exactly that many rows: a table that changed between two pages is a
	 * read that cannot be compared, never a short list. */
	const { totalCount } = reported;
	if (totalCount === null || totalCount !== rows.length) {
		log.error(
			"[commcare] lookup table rows disagree with their total",
			undefined,
			{
				domain,
				rows: rows.length,
			},
		);
		return { success: false, status: 502, cause: "malformed" };
	}
	return { totalCount, rows };
}

/**
 * Whether a `Content-Type` header names a media type other than JSON. An
 * answer with no `Content-Type` names none, so its body is read for a
 * verdict and an unreadable one stays an answer that may have landed.
 */
function namesNonJsonMediaType(header: string | null): boolean {
	if (header === null) return false;
	const mediaType = header.split(";", 1)[0]?.trim().toLowerCase();
	return mediaType !== "application/json";
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
export const FIXTURE_UPLOAD_PARTIAL_CODE = 402;
const FIXTURE_UPLOAD_FORMAT_FAILURE_CODE = 405;

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
	 * Two things rule it out: the `fail` verdict, which
	 * `validate_fixture_file_format` raises before `upload_fixture_file`
	 * runs, and the statuses `http.ts::writeMayHaveLanded` settles, which
	 * are CommCare HQ or its front door saying no before the view ran.
	 * Everything else — a 5xx out of the view, a gateway that gave up
	 * waiting, a connection that died, an answer Nova cannot read —
	 * counts as landed, because `_run_upload` is
	 * NOT one transaction: only `flush` is `@atomic`, and `process_table`
	 * calls it mid-pass once a table has more than a thousand rows to
	 * write or delete. A big workbook that dies after that flush leaves
	 * real tables behind, and a caller told nothing landed would record
	 * nothing and meet its own tables as a stranger's next publish.
	 */
	readonly mayHaveLanded: boolean;
	/**
	 * True when CommCare HQ answered with its "Upgrade Required" page: the
	 * project space's plan has no Lookup Tables, so the plan check in front
	 * of the view (`fixtures/dispatcher.py::require_can_edit_fixtures`
	 * through `accounting/decorators.py::requires_privilege_with_fallback`)
	 * turned the upload away before anything was written. False on every
	 * other refusal.
	 */
	readonly upgradeRequired: boolean;
}

/**
 * The status this adapter reports for the plan page. HQ sends that page as
 * 200, so the status is Nova's own choice for the arm; it is not 402, which
 * the deployment reads as HQ's "took only part" verdict.
 */
export const FIXTURE_UPLOAD_UPGRADE_REQUIRED_STATUS = 426;

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
		return {
			...INVALID_DOMAIN_SLUG,
			message: "",
			mayHaveLanded: false,
			upgradeRequired: false,
		};

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

	return withHqRequestDeadline(async (signal) => {
		let res: Response;
		try {
			res = await fetch(`${baseUrl(creds)}/a/${domain}/fixtures/fixapi/`, {
				method: "POST",
				headers: { Authorization: authHeader(creds) },
				body: form,
				redirect: "manual",
				signal,
			});
		} catch (error) {
			log.error("[commcare] lookup table upload unreachable", undefined, {
				domain,
				error: error instanceof Error ? error.message : String(error),
			});
			/* The request went out and no answer came back, so what CommCare HQ
			 * did with the workbook is unknown. */
			return {
				success: false,
				status: 503,
				message: "",
				mayHaveLanded: true,
				upgradeRequired: false,
			};
		}
		if (!res.ok) {
			/* No verdict body, so no sentence to keep. Whether anything landed
			 * is the shared rule: the permission layer answers before
			 * `_run_upload` can run, while anything else means it may have run
			 * and stopped somewhere unknown. That deliberately includes a
			 * gateway's own 502 or 504, which says the request was forwarded
			 * and then waited on, not that it never arrived. */
			const refusal = await logAndReturnError(
				"lookup table upload failed",
				res,
			);
			return {
				...refusal,
				message: "",
				mayHaveLanded: writeMayHaveLanded(res.status, refusal.edgeRefusal),
				upgradeRequired: false,
			};
		}
		/* The upload view answers JSON on every path, its verdict in the
		 * body's `code` (`fixtures/views.py::upload_fixture_api` returns a
		 * `JsonResponse`). The one OK answer that is not JSON is the plan
		 * page the privilege check serves before the view runs, so nothing
		 * was written. */
		if (namesNonJsonMediaType(res.headers.get("content-type"))) {
			await res.body?.cancel();
			log.warn("[commcare] lookup table upload needs a plan upgrade", {
				domain,
			});
			return {
				success: false,
				status: FIXTURE_UPLOAD_UPGRADE_REQUIRED_STATUS,
				message: "",
				mayHaveLanded: false,
				upgradeRequired: true,
			};
		}
		let body: unknown;
		try {
			body = await res.json();
		} catch {
			log.error("[commcare] lookup table upload returned non-JSON", undefined, {
				domain,
			});
			/* CommCare HQ answered something Nova cannot read, which says
			 * nothing about what it did with the workbook. */
			return {
				success: false,
				status: signal.aborted ? 503 : 502,
				message: "",
				mayHaveLanded: true,
				upgradeRequired: false,
			};
		}
		if (
			!isHqObject(body) ||
			(body.code !== FIXTURE_UPLOAD_SUCCESS_CODE &&
				body.code !== FIXTURE_UPLOAD_PARTIAL_CODE &&
				body.code !== FIXTURE_UPLOAD_FORMAT_FAILURE_CODE)
		) {
			log.error(
				"[commcare] lookup table upload verdict is malformed",
				undefined,
				{ domain },
			);
			// Only HQ's explicit pre-write format refusal and its plan page prove
			// nothing landed. An unknown verdict cannot authorize dropping the
			// ownership evidence.
			return {
				success: false,
				status: 502,
				message: "",
				mayHaveLanded: true,
				upgradeRequired: false,
			};
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
				upgradeRequired: false,
			};
		}
		return { success: true, message };
	}, 60_000);
}
