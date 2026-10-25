/**
 * A CommCare HQ project space as Nova's publish client reads it, served from
 * a loopback HTTP peer.
 *
 * Nova's client builds every URL from the closed server catalog
 * (`lib/commcare/servers.ts::COMMCARE_SERVERS`), so it cannot be pointed at
 * a local address. Instead the peer installs an undici dispatcher whose
 * connector hands every connection to the catalog host a plain socket to
 * the peer, and refuses every other destination, so the client's own
 * `fetch` calls, request construction and response decoding all run as in
 * production. The `https:` origin is spoken as plain HTTP/1.1: the peer
 * proves what Nova sends, not TLS.
 *
 * The peer answers the requests Nova's publish makes of a project space
 * whose feature flags and case search setting a configuration names, each
 * as the HQ view that serves it answers at the pinned commit:
 *
 * - `GET /api/user_domains/v1/` (`api/resources/v0_5.py::UserDomainsResource`,
 *   paginated by `pagination.py::DoesNothingPaginator`): the target domain,
 *   and with `feature_flag=<slug>` the target domain only when that flag is
 *   on for it (`get_object_list` also counts a flag on for the requesting
 *   user, which no configuration sets). The peer knows the slugs of the
 *   flags Nova's probe checks and of `USH_EMPTY_CASE_LIST_TEXT`, which
 *   every publish reads, the only flags Nova asks about, and answers any
 *   other slug with the 400 HQ gives a slug it does not register.
 * - `GET /a/<domain>/phone/search/` (`ota/views.py::search`): with
 *   `SYNC_SEARCH_CASE_CLAIM` off, the outer `required_decorator()` raises
 *   Django's 404; with it on and case search off, `app_aware_search` answers
 *   404 with `CASE_SEARCH_DISABLED_MSG`; with both on, a `text/xml` fixture.
 * - `POST /a/<domain>/fixtures/fixapi/` (`fixtures/views.py::upload_fixture_api`):
 *   recorded, read as HQ's upload reads the workbook (its `types` sheet and
 *   each table's sheet), and answered with HQ's success verdict (code 200).
 *   The peer applies it as `fixtures/upload/run_upload.py::_run_upload`
 *   with `replace` does: a table whose definition
 *   (`run_upload.py::table_key`: whether it is global, its tag, its fields
 *   with their properties, its row attributes and its description) matches
 *   the one under its tag keeps its id, any other replaces it under a new
 *   id, and every table's rows are the sheet's, in order.
 * - `GET /a/<domain>/api/lookup_table/v1/` (`fixtures/resources/v0_1.py::LookupTableResource`):
 *   every table the peer holds, each with its id, tag, `is_global`, its
 *   fields with their properties and its row attributes, in one page.
 * - `GET /a/<domain>/api/fixture/v1/?fixture_type_id=<id>`
 *   (`fixtures/resources/v0_1.py::FixtureResource`): that table's rows in
 *   order, each field as its one value
 *   (`fixtures/models.py::LookupTableRow.fields_without_attributes`), with
 *   `meta.total_count`, in one page.
 * - `GET /a/<domain>/apps/source/<app id>/` (`app_manager/views/apps.py::app_source`):
 *   the source the peer holds for the app, 404 before a create. A create
 *   makes it hold the shell's source (`shellSource`), and an update the
 *   source HQ serves after it (`sourceAfterUpdate`): every key the body
 *   carries replaced, and every key it leaves out kept.
 * - `POST /a/<domain>/apps/api/import_app/`
 *   (`app_manager/views/app_import_api.py::_handle_import_app`): recorded,
 *   and answered as HQ answers a create (201) or an update (200) of the one
 *   app the peer holds, whose id is fixed. The peer counts the imports into
 *   the app's version as HQ does (`ApplicationBase.save` raises it by one):
 *   the create leaves version 1, and the content import that fills it
 *   version 2. The capture takes the peer's state after the first publish
 *   (`snapshot`) and puts it back before each later update (`restore`),
 *   since each one stands for a separate next publish over that same app.
 * - `POST /a/<domain>/apps/api/<app id>/multimedia/`
 *   (`app_import_api.py::_handle_upload_multimedia`): recorded, and answered
 *   as HQ answers a ZIP it accepted for the app a create made (200, with a
 *   `processing_id`); 404 before any create, 400 without the
 *   `bulk_upload_file` field.
 * - `GET /a/<domain>/apps/api/<app id>/multimedia/status/<processing id>/`
 *   (`app_import_api.py::_handle_multimedia_status`, which serves
 *   `hqmedia/cache.py::BulkMultimediaStatusCache.get_response`), with the
 *   fields Nova's poll reads: processing complete, every file of the ZIP
 *   matched and no errors. The peer runs no HQ matching; this answer decides
 *   only which warnings Nova composes after the upload, never another
 *   request.
 *
 * What a person saves in HQ over the first publish (`HqSideSaves`, a
 * document's `hq-side.json`) the peer applies to what it holds as HQ's views
 * apply it (`applyHqSide`, beside `proof/observe/hqside.py`, which makes the
 * same saves in HQ), so the reads of the next publish answer with them. The
 * HQ side holds every field of every read a captured body or its drift
 * verdict was built on to HQ's own answer before it applies the body
 * (`proof/observe/publish.py`), so a peer that models HQ wrongly refuses
 * the capture rather than standing in for HQ.
 *
 * Anything else is answered 404 and recorded as unexpected, so a capture
 * whose client asked for something the peer does not model fails rather
 * than decoding a refusal as an ordinary result.
 */

import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { createConnection } from "node:net";
import AdmZip from "adm-zip";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import * as XLSX from "xlsx";
import type { CommCareCredentials } from "@/lib/commcare/client";
import { APP_SHELL_KEYS } from "@/lib/commcare/expander";
import { HQ_PRIVATE_FEATURE_FLAG_SYMBOLS } from "@/lib/commcare/projectSpaceCompatibility";
import { COMMCARE_SERVERS } from "@/lib/commcare/servers";
import { domainFeatureFlag } from "@/lib/commcare/surface/gates";
import type { HqSideSaves } from "./documents";

/** `ota/views.py::CASE_SEARCH_DISABLED_MSG`. */
const CASE_SEARCH_DISABLED_MSG = "Case search is not enabled for this project";

/** The processing id the peer answers a media upload with; HQ mints one per upload. */
export const MEDIA_PROCESSING_ID = "nova-proof-media-processing";

/** One request the peer received, with its body exactly as sent. */
export interface PeerRequest {
	readonly method: string;
	/** Path and query, as the request line carried them. */
	readonly path: string;
	readonly contentType: string | undefined;
	readonly body: Buffer;
}

/** What the peer holds of the target project space. */
export interface TargetState {
	readonly credentials: CommCareCredentials;
	readonly domain: string;
	/** Feature flags on for the domain, by symbol (`corehq/toggles/__init__.py`). */
	readonly flags: ReadonlySet<string>;
	/** `CaseSearchConfig.enabled` for the domain. */
	readonly caseSearchEnabled: boolean;
	/** The id HQ answers for the app a create makes, and an update names. */
	readonly appId: string;
	/** The CommCare version HQ gives an app it creates there (`get_default_build_spec`). */
	readonly commcareVersion: string;
	/**
	 * Whether the configuration grants `CLOUDCARE`: HQ's create sets a new
	 * app's `cloudcare_enabled` from it
	 * (`models/applications.py::_create_app_from_doc`).
	 */
	readonly cloudcareGranted: boolean;
	/**
	 * Fields of the app's source, by path, that hold other values in this
	 * project space than an update sent (`PublishInput.source`): HQ serves
	 * them after every update.
	 */
	readonly sourceChanges?: Readonly<Record<string, unknown>>;
}

interface Answer {
	readonly status: number;
	readonly contentType: string;
	readonly body: string;
}

/**
 * The symbol of each flag Nova's publish reads, by the slug its gate entry
 * holds: those its probe checks, and `USH_EMPTY_CASE_LIST_TEXT`, which every
 * publish reads for the empty-list text a `.ccz` writes.
 */
const SYMBOL_BY_SLUG: ReadonlyMap<string, string> = new Map(
	[
		...Object.values(HQ_PRIVATE_FEATURE_FLAG_SYMBOLS),
		"USH_EMPTY_CASE_LIST_TEXT",
	].map((symbol) => [domainFeatureFlag(symbol).slug, symbol] as const),
);

function json(status: number, body: unknown): Answer {
	return {
		status,
		contentType: "application/json",
		body: JSON.stringify(body),
	};
}

/**
 * The keys HQ serves for an app created without them, each with the value
 * its source read gives such an app (`models/applications.py::Application`:
 * an empty `DictProperty`, `auto_gps_capture`'s default `false`). A shell
 * holds none of the first four, which arrive with the update; it holds
 * `translations`, and `auto_gps_capture` only for a Connect app.
 */
const HQ_DEFAULTS_FOR_A_SHELL: Readonly<Record<string, unknown>> = {
	profile: {},
	multimedia_map: {},
	logo_refs: {},
	add_ons: {},
	translations: {},
	auto_gps_capture: false,
};

/**
 * The source HQ serves for the app a shell's create made
 * (`app_manager/views/apps.py::app_source`): each key of
 * `lib/commcare/expander.ts::APP_SHELL_KEYS` as the shell sent it, HQ's
 * default for each key the shell does not hold, and the build HQ gives
 * every app it creates (`models/applications.py::_import_app` deletes any
 * `build_spec` a body names, and the app takes
 * `builds/utils.py::get_default_build_spec`, the default build of the
 * configuration's CommCare version, as the lane's HQ seeds it in
 * `proof/hq/state.py`), serialized as HQ's `BuildSpec`. Nova's publish reads
 * the version from it (`HqAppSource.buildSpecVersion`) and holds it to its
 * floor. Its `cloudcare_enabled` is the configuration's `CLOUDCARE` grant,
 * set after the shell's keys whatever the body says, as
 * `models/applications.py::_create_app_from_doc` sets it from the domain's
 * privilege.
 */
export function shellSource(
	shell: Readonly<Record<string, unknown>>,
	commcareVersion: string,
	cloudcareGranted: boolean,
): Record<string, unknown> {
	const source: Record<string, unknown> = structuredClone(
		HQ_DEFAULTS_FOR_A_SHELL,
	);
	for (const key of APP_SHELL_KEYS) {
		if (Object.hasOwn(shell, key)) source[key] = structuredClone(shell[key]);
	}
	source.cloudcare_enabled = cloudcareGranted;
	source.build_spec = {
		doc_type: "BuildSpec",
		version: commcareVersion,
		build_number: null,
		latest: true,
	};
	return source;
}

/** One field of a lookup table's row as HQ holds it: each value with its properties. */
export interface PeerFieldValue {
	readonly value: string;
	readonly properties: Readonly<Record<string, string>>;
}

/** One row of a lookup table as HQ holds it (`fixtures/models.py::LookupTableRow`). */
export interface PeerRow {
	readonly id: string;
	readonly fields: Readonly<Record<string, readonly PeerFieldValue[]>>;
	readonly itemAttributes: Readonly<Record<string, string>>;
}

/** One lookup table as HQ holds it (`fixtures/models.py::LookupTable`). */
export interface PeerTable {
	readonly id: string;
	readonly tag: string;
	readonly isGlobal: boolean;
	readonly fields: readonly {
		readonly name: string;
		readonly properties: readonly string[];
	}[];
	readonly itemAttributes: readonly string[];
	readonly description: string;
	readonly rows: readonly PeerRow[];
}

/** Everything the peer holds of the project space that an import or a push changes. */
export interface PeerHolding {
	/** The source HQ serves for the app, once a create has made it. */
	readonly source: Readonly<Record<string, unknown>> | undefined;
	/** The app's version: the number of imports HQ has saved it under. */
	readonly version: number;
	/** How many files the last media upload's ZIP held, which its status reports matched. */
	readonly mediaFiles: number | undefined;
	/** The lookup tables, in the order HQ lists them. */
	readonly tables: readonly PeerTable[];
	/** How many tables and rows HQ has made, for the next ids it mints. */
	readonly minted: number;
}

/**
 * `source` with each field `fields` names, by its path (`build_spec.version`),
 * set to that value.
 */
export function withFields(
	source: Readonly<Record<string, unknown>>,
	fields: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	const result = structuredClone(source) as Record<string, unknown>;
	for (const [path, value] of Object.entries(fields)) {
		const keys = path.split(".");
		const last = keys.pop();
		if (last === undefined) continue;
		let at = result;
		for (const key of keys) {
			const next = at[key];
			at[key] =
				typeof next === "object" && next !== null && !Array.isArray(next)
					? { ...next }
					: {};
			at = at[key] as Record<string, unknown>;
		}
		at[last] = structuredClone(value);
	}
	return result;
}

/**
 * The source HQ serves for an app holding `current` after it applied
 * `application` as an update: each key the body carries replaces HQ's and
 * each key it leaves out keeps HQ's (`models/applications.py::_merge_source_into_app`),
 * with HQ's own CommCare version (an update keeps the app's `build_spec`),
 * and the fields `changed` names, which the capture's caller says hold
 * other values in this project space (`PublishInput.source`).
 */
export function sourceAfterUpdate(
	current: Readonly<Record<string, unknown>>,
	application: Readonly<Record<string, unknown>>,
	commcareVersion: string,
	changed: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
	return withFields(
		{ ...structuredClone(current), ...structuredClone(application) },
		{
			doc_type: "Application",
			"build_spec.version": commcareVersion,
			...changed,
		},
	);
}

/** A table's definition as `run_upload.py::table_key` compares two of them. */
function tableKey(table: Omit<PeerTable, "id" | "rows">): string {
	return JSON.stringify([
		table.isGlobal,
		table.tag,
		table.fields,
		table.itemAttributes,
		table.description,
	]);
}

/** One sheet's rows as text, each cell as HQ's workbook reader reads it. */
function sheetRows(book: XLSX.WorkBook, name: string): string[][] {
	const sheet = book.Sheets[name];
	if (sheet === undefined) {
		throw new Error(
			`The lookup workbook Nova's push sent has no sheet named ${name}, which HQ's upload reads.`,
		);
	}
	return XLSX.utils.sheet_to_json<string[]>(sheet, {
		header: 1,
		raw: false,
		defval: "",
	});
}

/** The column of `header` holding `name`, or -1. */
function columnOf(header: readonly string[], name: string): number {
	return header.indexOf(name);
}

/**
 * The tables a workbook Nova's push sent defines, each with its rows, read as
 * `fixtures/upload/workbook.py::_FixtureWorkbook` reads Nova's sheets: the
 * `types` sheet's `table_id`, `is_global?` and `field <n>` columns, and on
 * each table's sheet (named by its tag) the `field: <name>` columns. Nova's
 * workbook writes no field property, no row attribute and no owner
 * (`lib/commcare/lookup/workbook.ts`), so a header naming one is refused.
 */
/** One table a workbook defines, and its rows' values by field. */
interface WorkbookTable {
	readonly definition: Omit<PeerTable, "id" | "rows">;
	readonly rows: readonly Readonly<Record<string, string>>[];
}

function workbookTables(bytes: Uint8Array): WorkbookTable[] {
	const book = XLSX.read(bytes, { type: "array" });
	const [header = [], ...types] = sheetRows(book, "types");
	const tagColumn = columnOf(header, "table_id");
	const globalColumn = columnOf(header, "is_global?");
	const fieldColumns = header.flatMap((name, index) =>
		/^field \d+$/.test(name) ? [index] : [],
	);
	if (
		tagColumn === -1 ||
		globalColumn === -1 ||
		fieldColumns.length + 3 !== header.length
	) {
		throw new Error(
			`The lookup workbook's types sheet has the headers ${JSON.stringify(header)}, and the peer reads only the ones Nova's workbook writes (Delete(Y/N), table_id, is_global?, field <n>).`,
		);
	}
	return types.map((row) => {
		const tag = row[tagColumn] ?? "";
		const fields = fieldColumns
			.map((index) => row[index] ?? "")
			.filter((name) => name !== "");
		const [sheetHeader = [], ...sheet] = sheetRows(book, tag);
		const unread = sheetHeader.filter(
			(name) =>
				name !== "UID" &&
				name !== "Delete(Y/N)" &&
				!fields.some((field) => name === `field: ${field}`),
		);
		if (unread.length > 0) {
			throw new Error(
				`The lookup workbook's ${tag} sheet has the headers ${JSON.stringify(unread)}, which the peer does not read.`,
			);
		}
		return {
			definition: {
				tag,
				isGlobal: (row[globalColumn] ?? "").toLowerCase() === "yes",
				fields: fields.map((name) => ({ name, properties: [] })),
				itemAttributes: [],
				description: "",
			},
			rows: sheet.map((cells) =>
				Object.fromEntries(
					fields.map((field) => [
						field,
						cells[columnOf(sheetHeader, `field: ${field}`)] ?? "",
					]),
				),
			),
		};
	});
}

const EMPTY_HOLDING: PeerHolding = {
	source: undefined,
	version: 0,
	mediaFiles: undefined,
	tables: [],
	minted: 0,
};

export class TargetPeer {
	readonly requests: PeerRequest[] = [];
	readonly unexpected: PeerRequest[] = [];
	private holding: PeerHolding = EMPTY_HOLDING;

	constructor(readonly state: TargetState) {}

	/** What the peer holds now, for a capture to put back before a later update (`restore`). */
	snapshot(): PeerHolding {
		return structuredClone(this.holding);
	}

	restore(holding: PeerHolding): void {
		this.holding = structuredClone(holding);
	}

	/** The requests received since `mark`, for one step of a capture. */
	since(mark: number): readonly PeerRequest[] {
		return this.requests.slice(mark);
	}

	private mint(kind: "table" | "row"): string {
		const minted = this.holding.minted + 1;
		this.holding = { ...this.holding, minted };
		return `nova-proof-${kind}-${minted}`;
	}

	/**
	 * Apply what a person saves in HQ over the app (`HqSideSaves`), as the HQ
	 * view each save reaches applies it (`proof/observe/hqside.py`):
	 *
	 * - `uiTranslations`: each language's texts beside the ones the app holds
	 *   for it (`views/apps.py::edit_app_ui_translations`);
	 * - `appAttributes`: each attribute set on the app (`views/apps.py::edit_app_attr`);
	 * - `buildProfiles`: none of the peer's state, since an update never
	 *   writes `build_profiles` and the drift comparison ignores it;
	 * - `addOns`: each slug set on or off over the app's map
	 *   (`views/apps.py::edit_add_ons` stores each slug HQ lists that the
	 *   save posts, and no other). The save posts every slug HQ lists, as
	 *   the section does (`proof/observe/hqside.py::add_ons` refuses
	 *   another), so HQ's fill of an empty map before it stores them
	 *   (`add_ons.py::init_app`) leaves no slug the save does not name;
	 * - `profileProperties`: each setting set over the app's
	 *   `profile.properties`, and `custom_properties` reset to `{}` where the
	 *   project space holds `CUSTOM_PROPERTIES`
	 *   (`views/settings.py::edit_commcare_profile`);
	 * - `lookupTable`: the table under its tag uploaded again with a property
	 *   on one field and an attribute on every row, which
	 *   `run_upload.py::_run_upload` reads as another table and makes under a
	 *   new id with new rows, then described in HQ's table editor. The owners
	 *   live on no read the peer answers.
	 */
	applyHqSide(saves: HqSideSaves): void {
		const { source } = this.holding;
		if (source === undefined) {
			throw new Error(
				"The capture applied a person's saves in HQ before the app was there.",
			);
		}
		let next: Record<string, unknown> = structuredClone(source) as Record<
			string,
			unknown
		>;
		if (saves.uiTranslations !== undefined) {
			const translations = (next.translations ?? {}) as Record<
				string,
				Record<string, string>
			>;
			next = {
				...next,
				translations: Object.fromEntries([
					...Object.entries(translations),
					...Object.entries(saves.uiTranslations).map(([lang, texts]) => [
						lang,
						{ ...(translations[lang] ?? {}), ...texts },
					]),
				]),
			};
		}
		if (saves.appAttributes !== undefined) {
			next = { ...next, ...structuredClone(saves.appAttributes) };
		}
		if (saves.addOns !== undefined) {
			next = {
				...next,
				add_ons: {
					...((next.add_ons ?? {}) as Record<string, boolean>),
					...saves.addOns,
				},
			};
		}
		if (saves.profileProperties !== undefined) {
			const profile = (next.profile ?? {}) as Record<string, unknown>;
			next = {
				...next,
				profile: {
					...profile,
					properties: {
						...((profile.properties ?? {}) as Record<string, string>),
						...saves.profileProperties,
					},
					...(this.state.flags.has("CUSTOM_PROPERTIES") && {
						custom_properties: {},
					}),
				},
			};
		}
		this.holding = { ...this.holding, source: next };
		const kept = saves.lookupTable;
		if (kept === undefined) return;
		const table = this.holding.tables.find((held) => held.tag === kept.tag);
		if (table === undefined) {
			throw new Error(
				`hq-side.json keeps the lookup table ${kept.tag}, and the peer holds no table under that tag.`,
			);
		}
		if (kept.rowAttribute.values.length !== table.rows.length) {
			throw new Error(
				`hq-side.json gives ${kept.rowAttribute.values.length} values of the attribute ${kept.rowAttribute.name}, and the table ${kept.tag} holds ${table.rows.length} rows.`,
			);
		}
		const id = this.mint("table");
		const rows = table.rows.map((row, index): PeerRow => {
			const fields = Object.fromEntries(
				Object.entries(row.fields).map(([name, values]) => [
					name,
					name === kept.fieldProperty.field
						? values.map((value) => ({
								value: value.value,
								properties: {
									[kept.fieldProperty.property]: kept.fieldProperty.value,
								},
							}))
						: values,
				]),
			);
			return {
				id: this.mint("row"),
				fields,
				itemAttributes: {
					[kept.rowAttribute.name]: kept.rowAttribute.values[index] ?? "",
				},
			};
		});
		const replaced: PeerTable = {
			id,
			tag: table.tag,
			isGlobal: table.isGlobal,
			fields: table.fields.map((field) =>
				field.name === kept.fieldProperty.field
					? { name: field.name, properties: [kept.fieldProperty.property] }
					: field,
			),
			itemAttributes: [kept.rowAttribute.name],
			description: kept.description,
			rows,
		};
		this.holding = {
			...this.holding,
			tables: [
				...this.holding.tables.filter((held) => held.tag !== kept.tag),
				replaced,
			],
		};
	}

	/** HQ's upload of a workbook with `replace`, over what the peer holds. */
	private uploadWorkbook(bytes: Uint8Array): void {
		for (const { definition, rows } of workbookTables(bytes)) {
			const held = this.holding.tables.find(
				(table) => table.tag === definition.tag,
			);
			const same =
				held !== undefined && tableKey(held) === tableKey(definition);
			const id = same ? held.id : this.mint("table");
			const table: PeerTable = {
				...definition,
				id,
				rows: rows.map((values) => ({
					id: this.mint("row"),
					fields: Object.fromEntries(
						Object.entries(values).map(([name, value]) => [
							name,
							[{ value, properties: {} }],
						]),
					),
					itemAttributes: {},
				})),
			};
			this.holding = {
				...this.holding,
				tables: same
					? this.holding.tables.map((other) =>
							other.tag === definition.tag ? table : other,
						)
					: [
							...this.holding.tables.filter(
								(other) => other.tag !== definition.tag,
							),
							table,
						],
			};
		}
	}

	async answer(request: PeerRequest): Promise<Answer> {
		const url = new URL(request.path, "http://peer.invalid");
		const domainPath = `/a/${this.state.domain}`;
		const route = `${request.method} ${url.pathname}`;
		if (route === "GET /api/user_domains/v1/") {
			return this.userDomains(url.searchParams.get("feature_flag"));
		}
		if (route === `GET ${domainPath}/phone/search/`) {
			if (!this.state.flags.has("SYNC_SEARCH_CASE_CLAIM")) {
				return { status: 404, contentType: "text/html", body: "Not Found" };
			}
			if (!this.state.caseSearchEnabled) {
				return {
					status: 404,
					contentType: "text/html; charset=utf-8",
					body: CASE_SEARCH_DISABLED_MSG,
				};
			}
			return {
				status: 200,
				contentType: "text/xml; charset=utf-8",
				body: '<results id="case"/>',
			};
		}
		if (route === `POST ${domainPath}/fixtures/fixapi/`) {
			const form = await new Response(new Uint8Array(request.body), {
				headers: { "content-type": request.contentType ?? "" },
			}).formData();
			const file = form.get("file-to-upload");
			if (!(file instanceof Blob)) {
				return json(400, { code: 400, message: "no file-to-upload" });
			}
			this.uploadWorkbook(new Uint8Array(await file.arrayBuffer()));
			return json(200, { code: 200, message: "Lookup tables uploaded." });
		}
		if (route === `GET ${domainPath}/api/lookup_table/v1/`) {
			return json(200, {
				meta: {
					limit: this.holding.tables.length,
					next: null,
					offset: 0,
					previous: null,
					total_count: this.holding.tables.length,
				},
				objects: this.holding.tables.map((table) => ({
					fields: table.fields.map((field) => ({
						field_name: field.name,
						properties: field.properties,
					})),
					id: table.id,
					is_global: table.isGlobal,
					item_attributes: table.itemAttributes,
					tag: table.tag,
				})),
			});
		}
		if (route === `GET ${domainPath}/api/fixture/v1/`) {
			const table = this.holding.tables.find(
				(held) => held.id === url.searchParams.get("fixture_type_id"),
			);
			const rows = table?.rows ?? [];
			return json(200, {
				meta: {
					limit: rows.length,
					next: null,
					offset: 0,
					previous: null,
					total_count: rows.length,
				},
				objects: rows.map((row) => ({
					fields: Object.fromEntries(
						Object.entries(row.fields).map(([name, values]) => [
							name,
							values[0]?.value ?? "",
						]),
					),
					fixture_type: table?.tag ?? null,
					id: row.id,
				})),
			});
		}
		if (route === `GET ${domainPath}/apps/source/${this.state.appId}/`) {
			if (this.holding.source === undefined) {
				return json(404, "Application not found");
			}
			return json(200, this.holding.source);
		}
		if (route === `POST ${domainPath}/apps/api/import_app/`) {
			const form = await new Response(new Uint8Array(request.body), {
				headers: { "content-type": request.contentType ?? "" },
			}).formData();
			const appId = form.get("app_id");
			const app = form.get("app_file");
			if (appId === null) {
				if (!(app instanceof Blob)) {
					return json(400, { success: false, error: "app_file is required" });
				}
				this.holding = {
					...this.holding,
					source: shellSource(
						JSON.parse(await app.text()),
						this.state.commcareVersion,
						this.state.cloudcareGranted,
					),
					version: 1,
				};
				return json(201, { success: true, app_id: this.state.appId });
			}
			if (appId !== this.state.appId || this.holding.source === undefined) {
				return json(404, { success: false, error: "Application not found" });
			}
			if (!(app instanceof Blob)) {
				return json(400, { success: false, error: "app_file is required" });
			}
			const version = this.holding.version + 1;
			this.holding = {
				...this.holding,
				source: sourceAfterUpdate(
					this.holding.source,
					JSON.parse(await app.text()),
					this.state.commcareVersion,
					this.state.sourceChanges,
				),
				version,
			};
			return json(200, { success: true, app_id: this.state.appId, version });
		}
		const media = `${domainPath}/apps/api/${this.state.appId}/multimedia/`;
		if (route === `POST ${media}`) {
			if (this.holding.source === undefined) {
				return json(404, { success: false, error: "Application not found" });
			}
			const form = await new Response(new Uint8Array(request.body), {
				headers: { "content-type": request.contentType ?? "" },
			}).formData();
			const file = form.get("bulk_upload_file");
			if (!(file instanceof Blob)) {
				return json(400, {
					success: false,
					error: "bulk_upload_file is required",
				});
			}
			this.holding = {
				...this.holding,
				mediaFiles: new AdmZip(Buffer.from(await file.arrayBuffer()))
					.getEntries()
					.filter((entry) => !entry.isDirectory).length,
			};
			return json(200, { success: true, processing_id: MEDIA_PROCESSING_ID });
		}
		if (
			route === `GET ${media}status/${MEDIA_PROCESSING_ID}/` &&
			this.holding.mediaFiles !== undefined
		) {
			return json(200, {
				success: true,
				processing_id: MEDIA_PROCESSING_ID,
				complete: true,
				matched_count: this.holding.mediaFiles,
				unmatched_count: 0,
				unmatched_files: [],
				errors: [],
			});
		}
		this.unexpected.push(request);
		return json(404, { error: `The capture peer does not model ${route}.` });
	}

	private userDomains(featureFlag: string | null): Answer {
		const listed = {
			domain_name: this.state.domain,
			project_name: this.state.domain,
		};
		if (featureFlag === null) {
			return json(200, { objects: [listed], meta: { total_count: 1 } });
		}
		const symbol = SYMBOL_BY_SLUG.get(featureFlag);
		if (symbol === undefined) {
			return json(400, `'${featureFlag}' is not a valid feature flag`);
		}
		const on = this.state.flags.has(symbol);
		return json(200, {
			objects: on ? [listed] : [],
			meta: { total_count: on ? 1 : 0 },
		});
	}
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks);
}

/**
 * Run `capture` with Nova's client routed to a peer holding `state`, then
 * restore the previous dispatcher and close the peer and every connection,
 * whether or not the capture succeeded.
 */
export async function withTargetPeer<T>(
	state: TargetState,
	capture: (peer: TargetPeer) => Promise<T>,
): Promise<T> {
	const peer = new TargetPeer(state);
	const expectedAuthorization = `ApiKey ${state.credentials.username}:${state.credentials.apiKey}`;
	const server = createServer(
		// The peer never closes an idle connection itself: the capture closes
		// them all when it ends. Nova's export work runs on this same event
		// loop, and a stretch of it longer than a keep-alive timeout would let
		// the peer's idle timer close a connection undici's pool still offers
		// for the next request, which then fails with ECONNRESET.
		{ keepAliveTimeout: 0 },
		(request: IncomingMessage, response: ServerResponse) => {
			readBody(request)
				.then((body) => {
					const received: PeerRequest = {
						method: request.method ?? "",
						path: request.url ?? "",
						contentType: request.headers["content-type"],
						body,
					};
					peer.requests.push(received);
					return request.headers.authorization === expectedAuthorization
						? peer.answer(received)
						: json(
								401,
								"Username or API Key is incorrect, expired or deactivated",
							);
				})
				.then(
					(answer) => {
						response.writeHead(answer.status, {
							"content-type": answer.contentType,
						});
						response.end(answer.body);
					},
					(error: unknown) => {
						response.destroy(error instanceof Error ? error : undefined);
					},
				);
		},
	);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		server.close();
		throw new Error("The capture peer did not get a loopback port.");
	}
	const host = new URL(COMMCARE_SERVERS[state.credentials.server].baseUrl)
		.hostname;
	const dispatcher = new Agent({
		connect(options, callback) {
			if (options.hostname !== host) {
				callback(
					new Error(
						`The capture routes only ${host} to its peer, and Nova's client asked for ${options.hostname}.`,
					),
					null,
				);
				return;
			}
			// Without noDelay, Nagle's algorithm holds each request's last
			// segment until the peer's delayed acknowledgement, about 40 ms per
			// request; the bytes sent are the same either way.
			const socket = createConnection({
				host: "127.0.0.1",
				port: address.port,
				noDelay: true,
			});
			const failed = (error: Error) => callback(error, null);
			socket.once("error", failed);
			socket.once("connect", () => {
				socket.off("error", failed);
				callback(null, socket);
			});
		},
	});
	const previous = getGlobalDispatcher();
	setGlobalDispatcher(dispatcher);
	try {
		return await capture(peer);
	} finally {
		setGlobalDispatcher(previous);
		await dispatcher.destroy();
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
}
