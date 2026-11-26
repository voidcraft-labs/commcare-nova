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
 *   each table’s sheet). Supplied owners are resolved in the selected project space.
 *   Unknown owners leave the row in place and produce HQ’s partial verdict (code 402).
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
 *   (`fixtures/resources/v0_1.py::FixtureResource`): that table’s rows in
 *   native order. A row with multiple occurrences uses field lists. Other rows
 *   return one scalar per field. Selected lookup_table_item detail reads return
 *   all occurrences, their properties, row attributes and sort keys. No REST
 *   list or detail response is a worker’s authenticated restore.
 *
 * The table list and the rows read answer a publish's `managed-data` edge as
 * they answer its `project-data` edge: from the tables the peer holds, which
 * a capture over tables CommCare HQ manages gives it before its first
 * publish (`holdTables`), and which Nova's workbook never replaces, since it
 * leaves such a table out.
 * - `GET /a/<domain>/apps/source/<app id>/` (`app_manager/views/apps.py::app_source`):
 *   the source the peer holds for the app, 404 before a create. A create
 *   makes it hold the shell's source (`shellSource`), and an update the
 *   source HQ serves after it (`sourceAfterUpdate`): the content fields the
 *   body replaces, the stored media map pruned to paths the app references,
 *   and the fields the project space keeps.
 * - `POST /a/<domain>/apps/api/import_app/`
 *   (`app_manager/views/app_import_api.py::_handle_import_app`): recorded,
 *   and answered as HQ answers a create (201) or an update (200) of the one
 *   app the peer holds, whose id is fixed. The peer counts the imports into
 *   the app's version as HQ does (`ApplicationBase.save` raises it by one):
 *   the create leaves version 1, and the content import that fills it
 *   version 2. An update also saves once more if it prunes unused media
 *   mappings. Its answer names the final version. A media job that maps a file
 *   saves the app once more (`hqmedia/tasks.py::process_bulk_upload_zip`),
 *   and so do a person's saves in HQ (`applyHqSide`), which the model counts
 *   as one: Nova compares the counter only within one publish, with reads it
 *   makes after those saves. The capture records the counter around each
 *   import and each media upload (`saveCounter`), and the HQ side holds
 *   HQ's own counter's move over the same write to it
 *   (`proof/observe/publish.py`), so the model cannot drift from HQ's;
 *   `proof/hq/test_publish.py` holds the facts it models to HQ's own views.
 *   The capture takes the peer's state after the first publish
 *   (`snapshot`) and puts it back before each later update (`restore`),
 *   since each one stands for a separate next publish over that same app.
 * - `POST /a/<domain>/apps/api/<app id>/multimedia/`
 *   (`app_import_api.py::_handle_upload_multimedia`): recorded, and answered
 *   as HQ answers a ZIP it accepted for the app a create made (200, with a
 *   `processing_id`); 404 before any create, 400 without the
 *   `bulk_upload_file` field. The peer processes it as HQ's task does
 *   (`processMediaUpload`): each file found or made as a media document of
 *   its content and mapped in the app's `multimedia_map` at its path.
 * - `GET /a/<domain>/apps/api/<app id>/multimedia/status/<processing id>/`
 *   (`app_import_api.py::_handle_multimedia_status`, which serves
 *   `hqmedia/cache.py::BulkMultimediaStatusCache.get_response`): processing
 *   complete, no errors, and every file of the ZIP matched, each under its
 *   class with the path it was mapped at and the id of the document there
 *   (`matched_files`), which Nova records as the file standing at the path.
 * - `GET /a/<domain>/apps/view/<app id>/current_version/`
 *   (`app_manager/views/releases.py::current_app_version`): the app's save
 *   counter as `currentVersion`, with `latestBuild` and `latestReleasedBuild`
 *   null, since the peer makes no build; 404 before a create, as HQ answers
 *   an app it holds no working copy of.
 * - `GET /hq/multimedia/file/<class>/<id>/` (`hqmedia/views.py::ViewMultimediaFile`):
 *   the bytes of the media document the peer holds under that class and
 *   id, 404 for any other, as Nova reads a file to settle a path by its
 *   content (`lib/commcare/hq/media.ts::readHqMediaFile`).
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
 * An app CommCare HQ's own pages made (an `hq-authored` document's A) is
 * held as HQ's source read served it, with the media documents its map
 * names (`holdSource`), and the lookup tables its project space holds as
 * HQ's models made them (`holdTables`), before Nova's first publish over it.
 *
 * Anything else is answered 404 and recorded as unexpected, so a capture
 * whose client asked for something the peer does not model fails rather
 * than decoding a refusal as an ordinary result.
 */

import { createHash } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { createConnection } from "node:net";
import AdmZip from "adm-zip";
import { type Document, type Element, isTag, Text } from "domhandler";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import type { CommCareCredentials } from "@/lib/commcare/client";
import { APP_SHELL_KEYS } from "@/lib/commcare/expander";
import { HQ_PRIVATE_FEATURE_FLAG_SYMBOLS } from "@/lib/commcare/projectSpaceCompatibility";
import { serializeXml } from "@/lib/commcare/serializeXml";
import { COMMCARE_SERVERS } from "@/lib/commcare/servers";
import { domainFeatureFlag } from "@/lib/commcare/surface/gates";
import type { HqAnyModule } from "@/lib/commcare/types";
import { parseXml } from "@/lib/commcare/xmlParse";
import type { AssetKind } from "@/lib/domain";
import { ACCEPTED_FORMATS } from "@/lib/domain/multimedia";
import type { HqFormPlace, HqSideContentSaves, HqSideSaves } from "./documents";
import { readPeerWorkbook, type WorkbookOwner } from "./lookupWorkbook";

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
	readonly lookupOwners?: readonly WorkbookOwner[];
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
	/** Text, or a media file's bytes. */
	readonly body: string | Uint8Array;
}

/** The prefix of every path an app names a media file by. */
const JR_FILE = "jr://file/";

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
 * The custom properties an app holds after a save of HQ's app settings page,
 * where the project space holds `CUSTOM_PROPERTIES`
 * (`proof/observe/hqside.py::_page_custom_properties`). The page lists the
 * ones the profile holds (`views/apps.py::get_app_view_context`'
 * `customProperties`, none where the profile has no such key), and its save
 * posts each whose key and value are both set (`commcare_settings.js`'
 * `serialize`); `views/settings.py::edit_commcare_profile` resets the key to
 * `{}` and stores the posted ones. So the save keeps every custom property,
 * Nova's own among them, but one with an empty key or value.
 */
function pageSavedCustomProperties(
	profile: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	const held = profile.custom_properties;
	if (held === null || typeof held !== "object") return {};
	return Object.fromEntries(
		Object.entries(held).filter(([key, value]) => key !== "" && Boolean(value)),
	);
}

/**
 * The keys HQ serves for an app created without them, each with the value
 * its source read gives such an app (`models/applications.py::Application`:
 * an empty `DictProperty` or `SchemaDictProperty`, `auto_gps_capture`'s
 * default `false`). A shell holds none of the first four, which arrive with
 * the update; it holds `translations`, and `auto_gps_capture` only for a
 * Connect app. No body Nova sends holds `build_profiles`, and an update never
 * writes it, so the app keeps HQ's empty one
 * (`proof/hq-reads/shell/app-source.json`).
 */
const HQ_DEFAULTS_FOR_A_SHELL: Readonly<Record<string, unknown>> = {
	profile: {},
	multimedia_map: {},
	logo_refs: {},
	add_ons: {},
	translations: {},
	auto_gps_capture: false,
	build_profiles: {},
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
	readonly owners?: readonly WorkbookOwner[];
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
		readonly isIndexed?: true;
	}[];
	readonly itemAttributes: readonly string[];
	readonly description: string;
	readonly rows: readonly PeerRow[];
}

/** Tastypie's collection metadata. Links retain the selected table predicate. */
function tastypiePage<T>(url: URL, items: readonly T[], defaultLimit: number) {
	const offset = Number(url.searchParams.get("offset") ?? 0),
		limit = Number(url.searchParams.get("limit") ?? defaultLimit);
	if (
		!Number.isSafeInteger(offset) ||
		offset < 0 ||
		!Number.isSafeInteger(limit) ||
		limit <= 0
	)
		throw Error("Invalid fixture pagination.");
	const page = (start: number) => {
		const next = new URL(url);
		next.searchParams.set("limit", String(limit));
		next.searchParams.set("offset", String(start));
		return next.pathname + next.search;
	};
	return {
		meta: {
			limit,
			offset,
			total_count: items.length,
			next: offset + limit < items.length ? page(offset + limit) : null,
			previous: offset > 0 ? page(Math.max(0, offset - limit)) : null,
		},
		objects: items.slice(offset, offset + limit),
	};
}
/** LookupTableItemResource always emits the complete list of decorated values.
 * FixtureResource uses a scalar per field unless any field has multiple values. */
function detailedFields(row: PeerRow) {
	return Object.fromEntries(
		Object.entries(row.fields).map(([field, values]) => [
			field,
			{
				field_list: values.map((item) => ({
					field_value: item.value,
					properties: item.properties,
				})),
			},
		]),
	);
}
function fixtureListFields(row: PeerRow) {
	if (Object.values(row.fields).some((values) => values.length > 1))
		return detailedFields(row);
	return Object.fromEntries(
		Object.entries(row.fields).map(([field, values]) => {
			const first = values[0];
			if (!first)
				throw Error(
					"HQ's scalar fixture list cannot project a field with no occurrence.",
				);
			return [field, first.value];
		}),
	);
}

/** The classes of media HQ stores (`hqmedia/models.py::CommCareMultimedia.get_doc_types`). */
export type HqMediaClass = "CommCareImage" | "CommCareAudio" | "CommCareVideo";

const HQ_MEDIA_CLASS_OF_KIND: Readonly<
	Partial<Record<AssetKind, HqMediaClass>>
> = {
	image: "CommCareImage",
	audio: "CommCareAudio",
	video: "CommCareVideo",
};

/** `get_nice_name` of each class, the `media_type` a matched entry names. */
const HQ_MEDIA_NICE_NAME: Readonly<Record<HqMediaClass, string>> = {
	CommCareImage: "Image",
	CommCareAudio: "Audio",
	CommCareVideo: "Video",
};

/**
 * One media document HQ holds (`hqmedia/models.py::CommCareMultimedia`):
 * its class, the MD5 of its bytes, by which `get_by_data` finds it before it
 * makes another (`get_by_hash`), and its bytes with their type, which
 * `views.py::ViewMultimediaFile` serves. The peer mints its ids; HQ's are
 * Couch's, and no read the HQ side holds compares one.
 */
export interface PeerMediaFile {
	readonly id: string;
	readonly mediaClass: HqMediaClass;
	readonly md5: string;
	readonly contentType: string;
	readonly bytes: Uint8Array;
}

/** One matched entry of a media upload's report, the keys of `get_media_info` the peer can give. */
interface MatchedMedia {
	readonly path: string;
	readonly uid: string;
	readonly m_id: string;
	readonly url: string;
	readonly updated: boolean;
	readonly original_path: string;
	readonly media_type: string;
}

/** `BulkMultimediaStatusCache.matched_files`: every class, each with what the processing matched. */
type MediaReport = Readonly<Record<HqMediaClass, readonly MatchedMedia[]>>;

function md5(bytes: Uint8Array): string {
	return createHash("md5").update(bytes).digest("hex");
}

/**
 * The entry `Application.create_mapping` writes at `path` for `file`, every
 * key in the order HQ serializes an `HQMediaMapItem`
 * (`proof/hq-reads/case-list-inline/app-source-after-media.json`), its
 * `unique_id` as `HQMediaMapItem.gen_unique_id` gives it.
 */
export function mediaMapItem(
	path: string,
	file: Pick<PeerMediaFile, "id" | "mediaClass">,
): Record<string, unknown> {
	return {
		multimedia_id: file.id,
		media_type: file.mediaClass,
		version: null,
		unique_id: createHash("md5").update(`${path}: ${file.id}`).digest("hex"),
		upstream_media_id: null,
		doc_type: "HQMediaMapItem",
	};
}

/**
 * The format of a ZIP entry Nova's bulk upload writes, by its extension.
 * HQ types each entry by its bytes (`get_class_by_data`); Nova names each
 * entry with the extension its own upload gave the bytes it validated
 * (`lib/domain/multimedia.ts::ACCEPTED_FORMATS`), so the two agree for every
 * entry Nova writes, and an extension no format declares is refused.
 */
function entryFormat(name: string): {
	readonly mediaClass: HqMediaClass;
	readonly contentType: string;
} {
	const dot = name.lastIndexOf(".");
	const extension = dot === -1 ? "" : name.slice(dot).toLowerCase();
	const format = ACCEPTED_FORMATS.find(
		(candidate) =>
			candidate.extension === extension ||
			(candidate.declaredExtensions as readonly string[]).includes(extension),
	);
	const mediaClass =
		format === undefined ? undefined : HQ_MEDIA_CLASS_OF_KIND[format.kind];
	if (format === undefined || mediaClass === undefined) {
		throw new Error(
			`Nova's media upload holds ${name}, whose extension names no picture, sound or video Nova accepts, and the capture peer types an entry by it.`,
		);
	}
	return { mediaClass, contentType: format.mime };
}

/** Everything the peer holds of the project space that an import or a push changes. */
export interface PeerHolding {
	/** The source HQ serves for the app, once a create has made it. */
	readonly source: Readonly<Record<string, unknown>> | undefined;
	/** The app's version: the number of imports HQ has saved it under. */
	readonly version: number;
	/** The media documents HQ holds, one per content (`PeerMediaFile`). */
	readonly media: readonly PeerMediaFile[];
	/** What the last media upload's processing matched, by class, as its status reports it. */
	readonly mediaReport: MediaReport | undefined;
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
 * `application` as an update: the content keys the body carries replace HQ's.
 * HQ keeps its stored multimedia map even if the body supplies one
 * (`models/applications.py::_merge_source_into_app`). It serves that content
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
	const { multimedia_map: _excluded, ...content } = application;
	return withFields(
		{ ...current, ...content },
		{
			doc_type: "Application",
			"build_spec.version": commcareVersion,
			...changed,
		},
	);
}

/** The media paths in a Nova content import that HQ keeps in its existing
 * multimedia_map (hqmedia/models.py::remove_unused_mappings). Every input
 * here is a Nova export that has passed the form validator. */
function importedMediaPaths(source: Json): Set<string> {
	const paths = new Set<string>();
	function addMenu(media: {
		media_image?: Record<string, string>;
		media_audio?: Record<string, string>;
	}) {
		for (const path of [
			...Object.values(media.media_image ?? {}),
			...Object.values(media.media_audio ?? {}),
		]) {
			if (path) paths.add(path);
		}
	}
	for (const logo of Object.values(
		(source.logo_refs ?? {}) as Record<string, { path: string }>,
	)) {
		paths.add(logo.path);
	}
	for (const module of (source.modules ?? []) as HqAnyModule[]) {
		addMenu(module);
		if (module.case_list?.show) addMenu(module.case_list);
		if (module.case_list_form?.form_id) addMenu(module.case_list_form);
		for (const detail of [
			module.case_details?.short,
			module.case_details?.long,
		]) {
			if (!detail) continue;
			for (const column of detail.columns) {
				if (column.format !== "enum-image") continue;
				// Nova writes the same asset in each app language.
				for (const item of column.enum) {
					for (const path of Object.values(item.value)) paths.add(path);
				}
			}
		}
		for (const form of module.forms) {
			addMenu(form);
			const name = `${form.unique_id}.xml`;
			const xml = attachmentsOf(source)[name];
			if (xml === undefined)
				throw contentRefused(`a form with no ${name} attachment`);
			// XForm.media_references reads only itext media values. An
			// ordinary label containing a file path does not keep the mapping.
			let level = elements(parseXml(xml));
			for (const step of [
				"html",
				"head",
				"model",
				"itext",
				"translation",
				"text",
			]) {
				level = level.filter((node) => local(node) === step).flatMap(elements);
			}
			for (const value of level) {
				if (
					local(value) !== "value" ||
					!["image", "audio", "video", "video-inline"].includes(
						value.attribs.form ?? "",
					)
				)
					continue;
				const first = value.children[0];
				if (first?.type === "text") paths.add(first.data);
			}
		}
	}
	return paths;
}

/** A table's definition as `run_upload.py::table_key` compares two of them. */
function tableKey(table: Omit<PeerTable, "id" | "rows">): string {
	return JSON.stringify([
		table.isGlobal,
		table.tag,
		table.fields.map((field) => [
			field.name,
			field.properties,
			field.isIndexed === true,
		]),
		table.itemAttributes,
		table.description,
	]);
}

// ── A person's saves to the app's content ────────────────────────────

type Json = Record<string, unknown>;

function contentRefused(what: string): Error {
	return new Error(
		`hq-side.json saves ${what}, which the capture peer does not hold. Look at the save's place against the document's menus and forms.`,
	);
}

function modulesOf(source: Json): Json[] {
	const modules = source.modules;
	if (!Array.isArray(modules))
		throw contentRefused("into an app with no menus");
	return modules as Json[];
}

function formsOf(module: Json, where: number): Json[] {
	const forms = module.forms;
	if (!Array.isArray(forms))
		throw contentRefused(`into menu ${where}, which holds no forms`);
	return forms as Json[];
}

function moduleAt(source: Json, index: number): Json {
	const module = modulesOf(source)[index];
	if (module === undefined) throw contentRefused(`into menu ${index}`);
	return module;
}

function formAt(source: Json, place: HqFormPlace): Json {
	const form = formsOf(moduleAt(source, place.module), place.module)[
		place.form
	];
	if (form === undefined)
		throw contentRefused(`into form ${place.form} of menu ${place.module}`);
	return form;
}

function attachmentsOf(source: Json): Record<string, string> {
	const attachments = source._attachments;
	if (attachments === null || typeof attachments !== "object")
		throw contentRefused("into an app with no form sources");
	return attachments as Record<string, string>;
}

function attachmentName(form: Json): string {
	return `${String(form.unique_id)}.xml`;
}

/** The app's first language: the one HQ's form builder and its pages edit by default. */
function firstLanguage(source: Json): string {
	const langs = source.langs;
	if (!Array.isArray(langs) || typeof langs[0] !== "string")
		throw contentRefused("into an app with no language");
	return langs[0];
}

function elements(node: { readonly children: readonly unknown[] }): Element[] {
	return node.children.filter((child): child is Element =>
		isTag(child as Element),
	);
}

function local(element: Element): string {
	const at = element.name.indexOf(":");
	return at === -1 ? element.name : element.name.slice(at + 1);
}

function descendants(root: { readonly children: readonly unknown[] }) {
	const found: Element[] = [];
	const walk = (node: { readonly children: readonly unknown[] }) => {
		for (const child of elements(node)) {
			found.push(child);
			walk(child);
		}
	};
	walk(root);
	return found;
}

/**
 * The declaration HQ's form builder begins every form it saves with: its
 * writer opens the document with `XMLWriter.writeStartDocument` under
 * `new XMLWriter('UTF-8', '1.0')` (`Vellum/src/writer.js::createXForm`), and
 * the forms HQ's own tests keep from the builder begin with it
 * (`corehq/apps/app_manager/tests/data/save_to_case_in_groups.xml`). Nova's
 * own emission begins `<?xml version="1.0"?>`, so every save of the builder
 * changes the form's bytes, which a publish's comparison reads.
 */
const FORM_BUILDER_DECLARATION = '<?xml version="1.0" encoding="UTF-8" ?>';

/**
 * A form's source as the peer stores one HQ's form builder saved
 * (`views/forms.py::patch_xform` stores the bytes the builder posts): the
 * builder's declaration, then the form as the peer's serializer writes it.
 * The rest of the builder's own spelling is not modeled; the HQ side holds
 * the reading of what the peer serves to the reading of what HQ serves after
 * the builder's own save.
 */
function builderWritten(root: Document): string {
	return `${FORM_BUILDER_DECLARATION}\n${serializeXml(root)}`;
}

/**
 * The XForm `xml` with the label of the question at `question` reading
 * `label` in `lang`, the form's default language, as HQ's form builder leaves
 * it after the label is set through the question's own object
 * (`javaRosa/itext.js::ItextItem.set` with no language named, which
 * `proof/editors/driver/steps/vellum/edit.js` calls): that language's text
 * for the label's itext id, and every other language's whose text is empty
 * or equal to the default's before it, written as the builder's save stores
 * it (`builderWritten`). A label written with a markdown form
 * is refused, since the builder writes that form again from its own switch,
 * which the peer does not model.
 */
function relabeled(
	xml: string,
	question: string,
	lang: string,
	label: string,
): string {
	const root = parseXml(xml);
	const all = descendants(root);
	const control = all.find(
		(element) =>
			local(element) !== "bind" &&
			(element.attribs.ref === question ||
				element.attribs.nodeset === question) &&
			elements(element).some((child) => local(child) === "label"),
	);
	const ref = control?.children
		.filter((child): child is Element => isTag(child as Element))
		.find((child) => local(child) === "label")?.attribs.ref;
	const prefix = "jr:itext('";
	if (ref === undefined || !ref.startsWith(prefix) || !ref.endsWith("')"))
		throw contentRefused(`a label of ${question}, which holds no itext label`);
	const id = ref.slice(prefix.length, -2);
	const plainOf = (translation: Element): Element | undefined => {
		const text = elements(translation).find(
			(element) => element.attribs.id === id,
		);
		const values = text === undefined ? [] : elements(text);
		if (values.some((value) => value.attribs.form === "markdown"))
			throw contentRefused(
				`a label of ${question} written with a markdown form, which the builder writes again from its own switch`,
			);
		return values.find((value) => value.attribs.form === undefined);
	};
	const textOf = (value: Element | undefined): string =>
		(value?.children ?? [])
			.map((child) => (child.type === "text" ? (child as Text).data : "\u0000"))
			.join("");
	const translations = all.filter(
		(element) => local(element) === "translation",
	);
	const own = translations.find((element) => element.attribs.lang === lang);
	const plain = own === undefined ? undefined : plainOf(own);
	if (plain === undefined)
		throw contentRefused(`a label of ${question} with no text in ${lang}`);
	const before = textOf(plain);
	const set = (value: Element) => {
		const replacement = new Text(label);
		replacement.parent = value;
		value.children = [replacement];
	};
	set(plain);
	for (const translation of translations) {
		if (translation === own) continue;
		const other = plainOf(translation);
		if (other === undefined) continue;
		const held = textOf(other);
		if (held === "" || held === before) set(other);
	}
	return builderWritten(root);
}

/** The `xmlns` of an XForm's main instance's root. */
function dataXmlns(xml: string): string {
	const instance = descendants(parseXml(xml)).find(
		(element) =>
			local(element) === "instance" && element.attribs.id === undefined,
	);
	const root = instance === undefined ? undefined : elements(instance)[0];
	const xmlns = root?.attribs.xmlns;
	if (xmlns === undefined)
		throw contentRefused("a form whose XForm names no xmlns on its data");
	return xmlns;
}

/** The form's id HQ stores for a form the peer adds: 32 hexadecimal digits drawn from its `xmlns`. */
function addedFormId(xmlns: string): string {
	return createHash("sha256").update(xmlns).digest("hex").slice(0, 32);
}

/** Move the item at `from` to `to`, as `list.insert(to, list.pop(from))` does. */
function moved<T>(items: readonly T[], from: number, to: number): T[] {
	const next = [...items];
	const [item] = next.splice(from, 1);
	if (item === undefined) throw contentRefused(`a move from place ${from}`);
	next.splice(to, 0, item);
	return next;
}

/**
 * `source` after a person's saves to the app's content (`HqSideContentSaves`),
 * each as the view it reaches stores it:
 *
 * - `formLabel`: the form's XForm with the label set (`relabeled`); the
 *   form builder writes the whole form back through `patch_xform`, and its
 *   own spelling of everything else is not modeled beyond its declaration
 *   (`builderWritten`): the reading of what the peer holds is what the HQ
 *   side holds to HQ's own;
 * - `formResave`: the form's XForm written back as the builder's save
 *   stores it (`builderWritten`), every value as it was. The builder also
 *   posts the form's name and comment, which it reads from HQ's own page
 *   (`views/formdesigner.py::_get_vellum_core_context`), so HQ stores them
 *   as it held them (`_apply_form_name_and_comment_updates`), and the case
 *   references it works out from the form's expressions
 *   (`Vellum/src/core.js::send`), which the peer leaves as HQ held them and
 *   the HQ side holds through the reading;
 * - `questions`: the form's source replaced by the XForm the save leaves
 *   (`util.py::save_xform` stores the bytes as posted where the form's
 *   `xmlns` is its own);
 * - `formAttribute`: each attribute set on the form
 *   (`_edit_form_attr`'s `should_edit` branches for the attributes it
 *   stores as posted: `post_form_workflow`, `form_filter`,
 *   `post_form_workflow_fallback`);
 * - `formActions`: each case property's mapping added to the form's
 *   `update_case.update` (`form_action_diff.py::merge_case_mappings`, a
 *   property not yet mapped);
 * - `moduleAttribute`: the menu's name in the app's first language
 *   (`edit_module_attr`, `name`, under the `lang` cookie HQ's pages set);
 * - `moduleLayout`: the menu's `display_style` as posted
 *   (`edit_module_attr`, `display_style`);
 * - `moduleDetail`: the columns appended to short details or tabs on long details
 *   (`_update_short_details`, `DetailColumn.from_json` of a column that
 *   names every key HQ stores of one);
 * - `formsAddedAndRemoved`: the form removed from its menu, its source kept
 *   among the app's attachments (`Application.delete_form` keeps the blob
 *   for `DeleteFormRecord.undo`), then a form added at the menu's end with
 *   the posted XForm, named in the first language, its `xmlns` the one the
 *   XForm's data names (`FormSource.__set__`), its other keys those of the
 *   menu's first form, and an id the peer draws from its `xmlns`
 *   (`addedFormId`);
 * - `order`: the menu moved with the menus under it after it
 *   (`Application.rearrange_modules`), and the form moved within its menu
 *   (`rearrange_forms`, one menu);
 * - `mediaReplaced`: left to `TargetPeer.applyHqSide`, which holds the
 *   files a media upload maps (`TargetPeer.replaceMedia`).
 */
export function sourceAfterContentSaves(
	source: Json,
	saves: HqSideContentSaves,
): Json {
	const next = structuredClone(source) as Json;
	const lang = (): string => firstLanguage(next);
	if (saves.formLabel !== undefined) {
		const { question, label } = saves.formLabel;
		const form = formAt(next, saves.formLabel);
		const attachments = attachmentsOf(next);
		const name = attachmentName(form);
		const xml = attachments[name];
		if (xml === undefined) throw contentRefused(`a label in ${name}`);
		attachments[name] = relabeled(xml, question, lang(), label);
	}
	if (saves.formResave !== undefined) {
		const form = formAt(next, saves.formResave);
		const attachments = attachmentsOf(next);
		const name = attachmentName(form);
		const xml = attachments[name];
		if (xml === undefined) throw contentRefused(`a save of ${name}`);
		attachments[name] = builderWritten(parseXml(xml));
	}
	if (saves.questions !== undefined) {
		const form = formAt(next, saves.questions);
		const xmlns = dataXmlns(saves.questions.xform);
		if (xmlns !== form.xmlns)
			throw contentRefused(
				`questions under the xmlns ${xmlns} into a form whose xmlns is ${String(form.xmlns)}`,
			);
		attachmentsOf(next)[attachmentName(form)] = saves.questions.xform;
	}
	if (saves.formAttribute !== undefined) {
		const form = formAt(next, saves.formAttribute);
		for (const [attribute, value] of Object.entries(
			saves.formAttribute.attributes,
		)) {
			if (
				attribute !== "post_form_workflow" &&
				attribute !== "form_filter" &&
				attribute !== "post_form_workflow_fallback"
			)
				throw contentRefused(`the form attribute ${attribute}`);
			form[attribute] = value;
		}
	}
	if (saves.formActions !== undefined) {
		const form = formAt(next, saves.formActions);
		const actions = (form.actions ?? {}) as Json;
		const update = (actions.update_case ?? {}) as Json;
		const mapped = { ...((update.update ?? {}) as Json) };
		for (const [property, path] of Object.entries(saves.formActions.update)) {
			if (Object.hasOwn(mapped, property))
				throw contentRefused(
					`the case property ${property}, which the form already maps`,
				);
			mapped[property] = { question_path: path, update_mode: "always" };
		}
		form.actions = { ...actions, update_case: { ...update, update: mapped } };
	}
	if (saves.moduleAttribute !== undefined) {
		const module = moduleAt(next, saves.moduleAttribute.module);
		module.name = {
			...((module.name ?? {}) as Json),
			[lang()]: saves.moduleAttribute.name,
		};
	}
	if (saves.moduleLayout !== undefined) {
		const module = moduleAt(next, saves.moduleLayout.module);
		module.display_style = saves.moduleLayout.displayStyle;
	}
	if (saves.moduleDetail !== undefined) {
		const module = moduleAt(next, saves.moduleDetail.module);
		const details = (module.case_details ?? {}) as Json;
		if ("tabs" in saves.moduleDetail) {
			module.case_details = {
				...details,
				long: {
					...((details.long ?? {}) as Json),
					tabs: structuredClone(saves.moduleDetail.tabs),
				},
			};
		} else {
			const short = (details.short ?? {}) as Json;
			const columns = Array.isArray(short.columns) ? short.columns : [];
			module.case_details = {
				...details,
				short: {
					...short,
					columns: [...columns, ...structuredClone(saves.moduleDetail.columns)],
				},
			};
		}
	}
	if (saves.formsAddedAndRemoved !== undefined) {
		const { module: at, removed, added } = saves.formsAddedAndRemoved;
		const module = moduleAt(next, at);
		const forms = formsOf(module, at);
		if (forms[removed] === undefined)
			throw contentRefused(`a removal of form ${removed} of menu ${at}`);
		const kept = forms.filter((_form, index) => index !== removed);
		const template = kept[0];
		if (template === undefined)
			throw contentRefused(`a form added to menu ${at}, which keeps no form`);
		const xmlns = dataXmlns(added.xform);
		const form: Json = {
			...structuredClone(template),
			unique_id: addedFormId(xmlns),
			xmlns,
			name: { [lang()]: added.name },
		};
		module.forms = [...kept, form];
		attachmentsOf(next)[attachmentName(form)] = added.xform;
	}
	if (saves.order?.modules !== undefined) {
		const { from, to } = saves.order.modules;
		const modules = modulesOf(next);
		const moving = modules[from];
		if (moving === undefined) throw contentRefused(`a move of menu ${from}`);
		const rest = modules.filter((_module, index) => index !== from);
		const under = rest.filter(
			(module) => module.root_module_id === moving.unique_id,
		);
		const others = rest.filter(
			(module) => module.root_module_id !== moving.unique_id,
		);
		next.modules = [
			...others.slice(0, to),
			moving,
			...under,
			...others.slice(to),
		];
	}
	if (saves.order?.forms !== undefined) {
		const { module: at, from, to } = saves.order.forms;
		const module = moduleAt(next, at);
		module.forms = moved(formsOf(module, at), from, to);
	}
	return next;
}

const EMPTY_HOLDING: PeerHolding = {
	source: undefined,
	version: 0,
	media: [],
	mediaReport: undefined,
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

	/**
	 * Hold `tables` as the lookup tables the project space has before Nova's
	 * first publish, as HQ's own upload made them: every table and row under
	 * the id HQ gave it, in the order HQ lists them. A capture over tables
	 * CommCare HQ manages (`PublishInput.hqTables`) reads them through the
	 * same two resources as every other table. Refused once the peer holds
	 * anything, since no request of a capture made them.
	 */
	holdTables(tables: readonly PeerTable[]): void {
		if (
			this.holding.source !== undefined ||
			this.holding.tables.length > 0 ||
			this.requests.length > 0
		) {
			throw new Error(
				"The capture gave its peer lookup tables to hold after the peer had answered a request. Give the tables before the first publish.",
			);
		}
		const tags = new Set(tables.map((table) => table.tag));
		if (tags.size !== tables.length) {
			throw new Error(
				"The capture gave its peer two lookup tables under one tag, which HQ never holds in one project space (`LookupTable.Meta.unique_together`).",
			);
		}
		this.holding = { ...this.holding, tables: structuredClone(tables) };
	}

	/**
	 * Hold `source` as the app's, at the one id the peer answers for, as it
	 * holds one after `applyRetained`: an app CommCare HQ's own pages made,
	 * which no request of a capture sent. Every later answer is the peer's
	 * own (`sourceAfterUpdate` over it). `files` are the media documents the
	 * project space holds for the files the source maps, each under the id
	 * its map names, so Nova's read of a mapped file is answered with its
	 * bytes. The app's version is the one the source holds, which each import
	 * then raises. Refused once the peer holds an app or has answered a
	 * request.
	 */
	holdSource(
		source: Readonly<Record<string, unknown>>,
		files: readonly Omit<PeerMediaFile, "md5">[] = [],
	): void {
		if (this.holding.source !== undefined || this.requests.length > 0) {
			throw new Error(
				"The capture gave its peer an app's source to hold after the peer held an app or had answered a request. Give it before the first publish over that app.",
			);
		}
		if (source.doc_type !== "Application") {
			throw new Error(
				`The capture gave its peer a source whose doc_type is ${JSON.stringify(source.doc_type)}; HQ's source read serves an Application.`,
			);
		}
		const media: PeerMediaFile[] = [];
		for (const file of files) {
			if (media.some((held) => held.id === file.id)) continue;
			media.push({ ...file, md5: md5(file.bytes) });
		}
		this.holding = {
			...this.holding,
			source: structuredClone(source) as Record<string, unknown>,
			version: typeof source.version === "number" ? source.version : 1,
			media: [...this.holding.media, ...media],
		};
	}

	/**
	 * The app's save counter as `current_app_version` answers it, or null
	 * before a create, when HQ holds no app to answer for. A capture records
	 * it around each write so the HQ side holds HQ's own counter's move over
	 * the same write to the peer's (`proof/observe/publish.py`).
	 */
	saveCounter(): number | null {
		return this.holding.source === undefined ? null : this.holding.version;
	}

	/** The requests received since `mark`, for one step of a capture. */
	since(mark: number): readonly PeerRequest[] {
		return this.requests.slice(mark);
	}

	private mint(kind: "table" | "row" | "media"): string {
		const minted = this.holding.minted + 1;
		this.holding = { ...this.holding, minted };
		return kind === "media"
			? `nova-proof-${kind}-${minted}`
			: createHash("sha256")
					.update(`nova-proof-${kind}-${minted}`)
					.digest("hex")
					.slice(0, 32);
	}

	/**
	 * `source` as a save of the app settings page leaves its custom
	 * properties: under `CUSTOM_PROPERTIES` the page posts the ones it lists
	 * (`pageSavedCustomProperties`) and `edit_commcare_profile` resets the
	 * key to `{}` before it stores them; without the flag the view leaves
	 * the key alone.
	 */
	private pageSaved(source: Record<string, unknown>): Record<string, unknown> {
		if (!this.state.flags.has("CUSTOM_PROPERTIES")) return source;
		const profile = (source.profile ?? {}) as Record<string, unknown>;
		return {
			...source,
			profile: {
				...profile,
				custom_properties: pageSavedCustomProperties(profile),
			},
		};
	}

	/**
	 * The media document HQ holds for `bytes` of `mediaClass`, found by its
	 * content or made (`CommCareMultimedia.get_by_data`, then `attach_data`,
	 * which saves a document it made).
	 */
	private mediaFor(
		bytes: Uint8Array,
		mediaClass: HqMediaClass,
		contentType: string,
	): PeerMediaFile {
		const hash = md5(bytes);
		const held = this.holding.media.find(
			(file) => file.md5 === hash && file.mediaClass === mediaClass,
		);
		if (held !== undefined) return held;
		const made: PeerMediaFile = {
			id: this.mint("media"),
			mediaClass,
			md5: hash,
			contentType,
			bytes: new Uint8Array(bytes),
		};
		this.holding = { ...this.holding, media: [...this.holding.media, made] };
		return made;
	}

	/** `source` with `path` mapped to `file` (`Application.create_mapping`, which strips the path). */
	private mapped(
		source: Readonly<Record<string, unknown>>,
		path: string,
		file: PeerMediaFile,
	): Record<string, unknown> {
		const key = path.trim();
		const map = (source.multimedia_map ?? {}) as Record<string, unknown>;
		return {
			...source,
			multimedia_map: { ...map, [key]: mediaMapItem(key, file) },
		};
	}

	/** The media document the app's map names at `path`, or undefined where it names none. */
	mappedAt(path: string): PeerMediaFile | undefined {
		const map = (this.holding.source?.multimedia_map ?? {}) as Record<
			string,
			{ readonly multimedia_id?: unknown }
		>;
		const id = map[path]?.multimedia_id;
		return this.holding.media.find((file) => file.id === id);
	}

	/**
	 * Nova's bulk upload processed as `hqmedia/tasks.py::process_bulk_upload_zip`
	 * processes it: each entry, in the ZIP's order, typed (`entryFormat`),
	 * found or made as a document of its content, and mapped at
	 * `jr://file/<entry>` (`get_form_path`), every entry matching a path the
	 * app references, since Nova's upload carries only those files; the app
	 * saved once after. The report lists each matched entry under its class
	 * (`add_matched_path`, `get_media_info`).
	 */
	private processMediaUpload(zip: Buffer): void {
		const source = this.holding.source;
		if (source === undefined) {
			throw new Error(
				"The capture peer was asked to process a media upload before the app was there.",
			);
		}
		let next: Record<string, unknown> = structuredClone(source) as Record<
			string,
			unknown
		>;
		const report: Record<HqMediaClass, MatchedMedia[]> = {
			CommCareImage: [],
			CommCareAudio: [],
			CommCareVideo: [],
		};
		for (const entry of new AdmZip(zip).getEntries()) {
			if (entry.isDirectory) continue;
			const name = entry.entryName;
			const format = entryFormat(name);
			const file = this.mediaFor(
				entry.getData(),
				format.mediaClass,
				format.contentType,
			);
			const path = `${JR_FILE}${name.trim().replace(/^\//, "")}`;
			next = this.mapped(next, path, file);
			report[format.mediaClass].push({
				path,
				uid: file.md5,
				m_id: file.id,
				url: `/hq/multimedia/file/${file.mediaClass}/${file.id}/`,
				updated: true,
				original_path: name,
				media_type: HQ_MEDIA_NICE_NAME[file.mediaClass],
			});
		}
		const matched = Object.values(report).flat().length;
		this.holding = {
			...this.holding,
			source: next,
			mediaReport: report,
			/* The job saves the app once where it mapped a file. */
			version: this.holding.version + (matched > 0 ? 1 : 0),
		};
	}

	/**
	 * A person's replacement of the file at `path`, as HQ's media page uploads
	 * a picture there (`hqmedia/views.py::ProcessImageFileUploadView`,
	 * `BaseProcessFileUploadView.process_upload`): the document of the posted
	 * bytes found or made, and the path mapped to it
	 * (`Application.create_mapping`). The document the path named before is
	 * kept: HQ deletes no media document.
	 */
	replaceMedia(
		replaced: NonNullable<HqSideContentSaves["mediaReplaced"]>,
	): void {
		const source = this.holding.source;
		if (source === undefined) {
			throw new Error(
				"The capture applied a person's media upload before the app was there.",
			);
		}
		const format = ACCEPTED_FORMATS.find(
			(candidate) => candidate.mime === replaced.mimeType,
		);
		if (format === undefined || format.kind !== "image") {
			throw new Error(
				`hq-side.json replaces the picture at ${replaced.path} with a file of type ${replaced.mimeType}, which HQ's image upload refuses (ProcessImageFileUploadView.valid_base_types).`,
			);
		}
		const file = this.mediaFor(
			Buffer.from(replaced.base64, "base64"),
			"CommCareImage",
			format.mime,
		);
		this.holding = {
			...this.holding,
			source: this.mapped(source, replaced.path, file),
		};
	}

	/**
	 * Apply what a person saves in HQ over the app (`HqSideSaves`), as the HQ
	 * view each save reaches applies it (`proof/observe/hqside.py`):
	 *
	 * - `uiTranslations`: each language's texts beside the ones the app holds
	 *   for it (`views/apps.py::edit_app_ui_translations`);
	 * - `appAttributes`: each attribute set on the app, and `custom_properties`
	 *   as the settings page's save leaves them (`pageSavedCustomProperties`;
	 *   the page's save, `views/settings.py::edit_commcare_settings`:
	 *   `edit_commcare_profile`, then `views/apps.py::edit_app_attr` over
	 *   every attribute it names);
	 * - `buildProfiles`: the app's `build_profiles` replaced whole by the
	 *   profiles saved, each under its id as
	 *   `views/releases.py::LanguageProfilesView.post` stores it, a
	 *   `BuildProfile` with its languages, its name and no practice worker
	 *   (`practice_mobile_worker_id` empty), in the key order HQ's source read
	 *   serves it. An update leaves the map as it is, since no body Nova sends
	 *   holds the key (`models/applications.py::_merge_source_into_app`), and
	 *   a publish holds what the map names to the languages it writes;
	 * - `addOns`: each slug set on or off over the app's map
	 *   (`views/apps.py::edit_add_ons` stores each slug HQ lists that the
	 *   save posts, and no other). The save posts every slug HQ lists, as
	 *   the section does (`proof/observe/hqside.py::add_ons` refuses
	 *   another), so HQ's fill of an empty map before it stores them
	 *   (`add_ons.py::init_app`) leaves no slug the save does not name;
	 * - `profileProperties`: each setting set over the app's
	 *   `profile.properties`, and `custom_properties` as the same page's save
	 *   leaves them (`views/settings.py::edit_commcare_profile`);
	 * - `profileFeatures`: each feature set over the app's
	 *   `profile.features`, by the same view, with the same custom properties;
	 * - `lookupTable`: the table under its tag uploaded again with a property
	 *   on one field and an attribute on every row, which
	 *   `run_upload.py::_run_upload` reads as another table and makes under a
	 *   new id with new rows, then described in HQ's table editor. The owners
	 *   live on no read the peer answers;
	 * - the saves to the app's content (`HqSideContentSaves`), each as the
	 *   view it reaches stores it (`sourceAfterContentSaves`; a replaced
	 *   picture, `replaceMedia`).
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
			next = this.pageSaved(next);
		}
		if (saves.buildProfiles !== undefined) {
			next = {
				...next,
				build_profiles: Object.fromEntries(
					saves.buildProfiles.map((profile) => [
						profile.id,
						{
							langs: [...profile.langs],
							name: profile.name,
							practice_mobile_worker_id: profile.practice_worker_id ?? "",
							doc_type: "BuildProfile",
						},
					]),
				),
			};
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
						...((profile.properties ?? {}) as Record<string, unknown>),
						...saves.profileProperties,
					},
				},
			};
			next = this.pageSaved(next);
		}
		if (saves.profileFeatures !== undefined) {
			const profile = (next.profile ?? {}) as Record<string, unknown>;
			next = {
				...next,
				profile: {
					...profile,
					features: {
						...((profile.features ?? {}) as Record<string, unknown>),
						...saves.profileFeatures,
					},
				},
			};
			next = this.pageSaved(next);
		}
		next = sourceAfterContentSaves(next, saves);
		/* A person's saves leave the save counter past where Nova last read it. */
		this.holding = {
			...this.holding,
			source: next,
			version: this.holding.version + 1,
		};
		if (saves.mediaReplaced !== undefined)
			this.replaceMedia(saves.mediaReplaced);
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

	/**
	 * Apply the requests a first publish sent, retained from before a
	 * migration (`proof/migrations/<id>/`), in the order it sent them: each
	 * answered as the view it reaches answers it, so the peer then holds what
	 * HQ held after that publish, as it does after a first publish a capture
	 * sent. They are no requests of this capture, so none is recorded; one
	 * the peer refuses ends the capture.
	 */
	async applyRetained(
		requests: readonly {
			readonly method: string;
			readonly path: string;
			readonly contentType: string;
			readonly body: Buffer;
		}[],
	): Promise<void> {
		for (const request of requests) {
			const unexpected = this.unexpected.length;
			const answer = await this.answer({
				method: request.method,
				path: request.path,
				contentType: request.contentType,
				body: request.body,
			});
			if (
				answer.status < 200 ||
				answer.status >= 300 ||
				this.unexpected.length !== unexpected
			) {
				this.unexpected.splice(unexpected);
				throw new Error(
					`The capture peer answered the retained ${request.method} ${request.path} of a migration witness's A with ${answer.status} (${answer.body}), and HQ took it when the first publish sent it. Look at the retained body and its sidecar under proof/migrations/, and at whether the configuration's domain is the one it was sent to.`,
				);
			}
		}
	}

	/** HQ's upload of a workbook with `replace`, over what the peer holds. */
	private uploadWorkbook(bytes: Uint8Array) {
		const { tables, missingOwners } = readPeerWorkbook(
			bytes,
			this.state.lookupOwners ?? [],
		);
		for (const { definition, rows } of tables) {
			const held = this.holding.tables.find(
				(table) => table.tag === definition.tag,
			);
			const same =
				held !== undefined && tableKey(held) === tableKey(definition);
			const id = same ? held.id : this.mint("table");
			const table: PeerTable = {
				...definition,
				id,
				rows: rows.map((row) => ({ ...row, id: this.mint("row") })),
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
		return missingOwners;
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
			const missing = this.uploadWorkbook(
				new Uint8Array(await file.arrayBuffer()),
			);
			return missing.length
				? json(200, {
						code: 402,
						message: `Unknown lookup owners: ${missing.join(", ")}`,
					})
				: json(200, { code: 200, message: "Done" });
		}
		const tableRoot = `${domainPath}/api/lookup_table/v1/`;
		if (request.method === "GET" && url.pathname.startsWith(tableRoot)) {
			const selected = url.pathname.slice(tableRoot.length);
			const definition = (table: PeerTable) => ({
				id: table.id,
				tag: table.tag,
				is_global: table.isGlobal,
				item_attributes: table.itemAttributes,
				fields: table.fields.map((f) => ({
					field_name: f.name,
					properties: f.properties,
				})),
				resource_uri: `${tableRoot}${table.id}/`,
			});
			if (selected === "")
				return json(
					200,
					tastypiePage(url, this.holding.tables.map(definition), 100),
				);
			const found = this.holding.tables.find(
				(table) => selected === `${table.id}/`,
			);
			return found ? json(200, definition(found)) : json(404, {});
		}
		const detailRoot = `${domainPath}/api/lookup_table_item/v1/`;
		if (request.method === "GET" && url.pathname.startsWith(detailRoot)) {
			const id = url.pathname.slice(detailRoot.length).split("/");
			if (id.length !== 2 || !id[0] || id[1] !== "") return json(404, {});
			for (const table of this.holding.tables) {
				const index = table.rows.findIndex((row) => row.id === id[0]);
				if (index !== -1) {
					const row = table.rows[index];
					return json(200, {
						id: row.id,
						data_type_id: table.id,
						fields: detailedFields(row),
						item_attributes: row.itemAttributes,
						sort_key: index,
					});
				}
			}
			return json(404, {});
		}
		if (route === `GET ${domainPath}/api/fixture/v1/`) {
			const table = this.holding.tables.find(
				(held) => held.id === url.searchParams.get("fixture_type_id"),
			);
			const rows = table?.rows ?? [];
			return json(
				200,
				tastypiePage(
					url,
					rows.map((row) => ({
						fields: fixtureListFields(row),
						fixture_type: table?.tag ?? null,
						id: row.id,
						resource_uri: `${domainPath}/api/fixture/v1/${row.id}/`,
					})),
					1000,
				),
			);
		}
		if (
			route ===
			`GET ${domainPath}/apps/view/${this.state.appId}/current_version/`
		) {
			if (this.holding.source === undefined) {
				return { status: 404, contentType: "text/html", body: "Not Found" };
			}
			return json(200, {
				currentVersion: this.holding.version,
				latestBuild: null,
				latestReleasedBuild: null,
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
			const source = sourceAfterUpdate(
				this.holding.source,
				JSON.parse(await app.text()),
				this.state.commcareVersion,
				this.state.sourceChanges,
			);
			// HQ excludes the stored map from the import, then removes unused
			// mappings. Removing one or several paths costs one additional save.
			const entries = Object.entries(this.holding.source.multimedia_map ?? {});
			let version = this.holding.version + 1;
			if (entries.length > 0) {
				const referenced = importedMediaPaths(source);
				const kept = entries.filter(([path]) => referenced.has(path));
				source.multimedia_map = Object.fromEntries(kept);
				if (kept.length < entries.length) version++;
			}
			this.holding = { ...this.holding, source, version };
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
			this.processMediaUpload(Buffer.from(await file.arrayBuffer()));
			return json(200, { success: true, processing_id: MEDIA_PROCESSING_ID });
		}
		const report = this.holding.mediaReport;
		if (
			route === `GET ${media}status/${MEDIA_PROCESSING_ID}/` &&
			report !== undefined
		) {
			const matched = Object.values(report).flat().length;
			return json(200, {
				type: "zip",
				in_celery: true,
				is_ready: true,
				complete: true,
				progress: { percent: 100, current: matched, total: matched },
				errors: [],
				processing_id: MEDIA_PROCESSING_ID,
				unmatched_files: [],
				unmatched_count: 0,
				matched_files: report,
				matched_count: matched,
				total_files: matched,
				processed_files: matched,
				skipped_files: [],
				image_count: report.CommCareImage.length,
				audio_count: report.CommCareAudio.length,
				video_count: report.CommCareVideo.length,
				success: true,
			});
		}
		const served = /^GET \/hq\/multimedia\/file\/([^/]+)\/([^/]+)\/$/.exec(
			route,
		);
		if (served !== null) {
			const file = this.holding.media.find(
				(held) => held.mediaClass === served[1] && held.id === served[2],
			);
			if (file === undefined) {
				return { status: 404, contentType: "text/html", body: "Not Found" };
			}
			return {
				status: 200,
				contentType: file.contentType,
				body: Buffer.from(file.bytes),
			};
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
