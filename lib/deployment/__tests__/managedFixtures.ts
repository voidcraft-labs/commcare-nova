/**
 * Lookup tables CommCare HQ manages, for the deployment tests that read them
 * again: a copy made through the create arm a bring-in uses, an app that
 * reads it, and CommCare HQ's answers in the shapes
 * `lib/commcare/hq/lookupTables.ts` reads, served by an undici peer.
 *
 * Every copy is made from the same HQ table a test then serves, so its stored
 * canonical value is `canonicalLookupTable` of that table: a read of it
 * unchanged finds nothing to refresh, as a real one would.
 */

import { createHash } from "node:crypto";
import type { MockAgent } from "undici";
import { v7 } from "uuid";
import {
	HqSaveCounter,
	isSaveCounterPath,
	withHqPeer,
} from "@/__tests__/helpers/hqSaveCounter";
import {
	type RetainedPublishRead,
	replyRetained,
	retainedPublishRead,
} from "@/__tests__/helpers/retainedHqReads";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import type {
	HqFixtureRow,
	HqLookupTable,
} from "@/lib/commcare/hq/lookupTables";
import type { AppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import type { BlueprintDoc } from "@/lib/domain";
import {
	type LookupColumnId,
	type LookupTableId,
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { createManagedLookupTablesInTransaction } from "@/lib/lookup/managed";
import type { LookupScope } from "@/lib/lookup/types";
import { authorizeLookupWriteInTransaction } from "@/lib/lookup/writerTransaction";
import { canonicalLookupTable } from "../hqResourceBaseline";
import { managedLookupContentOf } from "../reading/projectData/lookupTables";

export const HOST = "https://india.commcarehq.org";

/**
 * CommCare HQ's save counter for the apps the peer stands for, which each
 * accepted import moves. A suite resets it before each case.
 */
export const hqSaves = new HqSaveCounter();

/** The peer `withHttpPeer` gives, with every app's save counter answered from `hqSaves`. */
export function withManagedPeer<T>(
	run: (peer: MockAgent) => Promise<T>,
): Promise<T> {
	return withHqPeer(hqSaves, HOST, run);
}

/** One table as the peer serves it: CommCare HQ's definition and its rows. */
export interface ServedTable {
	readonly id: string;
	readonly tag: string;
	readonly fields: readonly string[];
	readonly rows: readonly Readonly<Record<string, string>>[];
	readonly isGlobal?: boolean;
	readonly fieldProperties?: Readonly<Record<string, readonly string[]>>;
	/** Row fields served in their several-value form, by field name. */
	readonly manyValues?: Readonly<Record<string, readonly string[]>>;
}

/** The table as `listHqLookupTables` reads it. */
export function hqTableOf(table: ServedTable): HqLookupTable {
	return {
		id: table.id,
		tag: table.tag,
		isGlobal: table.isGlobal ?? true,
		fields: table.fields,
		fieldProperties: Object.fromEntries(
			table.fields.map((field) => [
				field,
				table.fieldProperties?.[field] ?? [],
			]),
		),
		itemAttributes: [],
	};
}

function fixtureRowId(table: ServedTable, index: number) {
	return createHash("sha256")
		.update(`${table.id}-${index}`)
		.digest("hex")
		.slice(0, 32);
}

/** The rows as `readHqLookupTableRows` reads them. */
export function hqRowsOf(table: ServedTable): HqFixtureRow[] {
	return table.rows.map((row, index) => ({
		id: fixtureRowId(table, index),
		fields: { ...row },
	}));
}

/** A managed copy, with the ids its columns were made under, by field name. */
export interface ManagedCopy {
	readonly tableId: LookupTableId;
	readonly columns: Readonly<Record<string, LookupColumnId>>;
}

/**
 * Make Nova's copy of `table` as a bring-in from `origin` would, managed in
 * CommCare HQ, through the create arm.
 */
export async function makeManagedCopy(
	h: AppStateTestDb,
	scope: LookupScope,
	table: ServedTable,
	origin: { readonly server: string; readonly domain: string },
	at = new Date("2026-11-01T09:00:00.000Z"),
): Promise<ManagedCopy> {
	const binding = {
		tag: table.tag,
		tableId: lookupTableIdSchema.parse(v7()),
		columns: Object.fromEntries(
			table.fields.map((field) => [field, lookupColumnIdSchema.parse(v7())]),
		),
	};
	const hqTable = hqTableOf(table);
	const rows = hqRowsOf(table);
	await h.withTransaction(async (tx) =>
		createManagedLookupTablesInTransaction(
			tx,
			await authorizeLookupWriteInTransaction(tx, scope, "edit"),
			[
				{
					binding,
					name: table.tag,
					content: managedLookupContentOf(hqTable, rows),
					origin: {
						server: origin.server,
						domain: origin.domain,
						remoteId: table.id,
						canonical: { ...canonicalLookupTable(hqTable, rows) },
					},
				},
			],
			at,
		),
	);
	return { tableId: binding.tableId, columns: binding.columns };
}

/** One survey whose question chooses from `copy`'s `code` column, labelled by its `name` column. */
export function readerOf(
	copies: readonly ManagedCopy[],
	appName = "Facility visits",
): BlueprintDoc {
	return buildDoc({
		appName,
		modules: [
			{
				name: "Visits",
				forms: [
					{
						name: "Visit",
						type: "survey",
						fields: copies.map((copy, index) => {
							const code = copy.columns.code;
							const name = copy.columns.name;
							if (code === undefined || name === undefined)
								throw new Error("The copy needs a code and a name column.");
							return {
								id: `choice_${index}`,
								kind: "single_select" as const,
								optionsSource: {
									kind: "lookup" as const,
									tableId: copy.tableId,
									valueColumnId: code,
									labelColumnId: name,
								},
							};
						}),
					},
				],
			},
		],
	});
}

function intercept(peer: MockAgent, path: string, method = "GET", host = HOST) {
	return peer.get(host).intercept({
		path,
		method,
		headers: { authorization: "ApiKey account:fixture-key" },
	});
}

/** The table list of `domain`, as `LookupTableResource` answers it. */
export function serveTableList(
	peer: MockAgent,
	domain: string,
	tables: readonly ServedTable[],
	host = HOST,
): void {
	intercept(
		peer,
		`/a/${domain}/api/lookup_table/v1/?limit=1000`,
		"GET",
		host,
	).reply(200, {
		meta: { next: null },
		objects: tables.map((table) => ({
			id: table.id,
			tag: table.tag,
			is_global: table.isGlobal ?? true,
			fields: table.fields.map((field) => ({
				field_name: field,
				properties: [...(table.fieldProperties?.[field] ?? [])],
			})),
		})),
	});
}

/**
 * A table's rows, as `FixtureResource` answers a filtered read. `before` runs
 * as CommCare HQ receives the read, for a case about what happens while Nova
 * is reading CommCare HQ.
 */
export function serveRows(
	peer: MockAgent,
	domain: string,
	table: ServedTable,
	host = HOST,
	before?: () => Promise<void>,
): void {
	const body = {
		meta: { next: null, total_count: table.rows.length },
		objects: table.rows.map((row, index) => {
			const many = table.manyValues;
			const fields =
				many === undefined
					? { ...row }
					: Object.fromEntries(
							table.fields.map((field) => [
								field,
								{
									field_list: (many[field] ?? [row[field] ?? ""]).map(
										(value) => ({ field_value: value, properties: {} }),
									),
								},
							]),
						);
			return {
				id: fixtureRowId(table, index),
				fixture_type: table.tag,
				fields,
			};
		}),
	};
	const interceptor = intercept(
		peer,
		`/a/${domain}/api/fixture/v1/?fixture_type_id=${table.id}`,
		"GET",
		host,
	);
	if (before === undefined) {
		const response = interceptor.reply(200, body);
		if (table.fieldProperties || table.manyValues) {
			response.times(3);
			serveSelectedDetails(peer, domain, table);
		}
		return;
	}
	interceptor.reply(async () => {
		await before();
		return { statusCode: 200, data: JSON.stringify(body) };
	});
}

/** Raw native selected-detail and full web restore responses for a management
 * transfer. Other tables have no interceptor. */
export function serveTransferEvidence(
	peer: MockAgent,
	domain: string,
	table: ServedTable,
) {
	serveTableList(peer, domain, [table]);
	serveRows(peer, domain, table);
	serveSelectedDetails(peer, domain, table);
	const xml = table.rows
		.map(
			(row) =>
				"<" +
				table.tag +
				">" +
				table.fields
					.map((field) => `<${field}>${row[field]}</${field}>`)
					.join("") +
				"</" +
				table.tag +
				">",
		)
		.join("");
	const fixture =
		'<fixture user_id="editor-id" id="item-list:' +
		table.tag +
		'"><' +
		table.tag +
		"_list>" +
		xml +
		"</" +
		table.tag +
		"_list></fixture>";
	const registration =
		'<Registration xmlns="http://openrosa.org/user/registration"><username>account</username><uuid>editor-id</uuid><user_data><data key="commcare_user_type">web</data><data key="commcare_project">' +
		domain +
		"</data></user_data></Registration>";
	const restore =
		'<OpenRosaResponse xmlns="http://openrosa.org/http/response"><message nature="ota_restore_success"/><Sync xmlns="http://commcarehq.org/sync"><restore_id>current</restore_id></Sync>' +
		registration +
		fixture +
		"</OpenRosaResponse>";
	intercept(peer, `/a/${domain}/phone/restore/?overwrite_cache=true`)
		.reply(200, restore)
		.persist();
}

function serveSelectedDetails(
	peer: MockAgent,
	domain: string,
	table: ServedTable,
) {
	const def = {
		id: table.id,
		tag: table.tag,
		is_global: table.isGlobal ?? true,
		item_attributes: [],
		fields: table.fields.map((name) => ({
			field_name: name,
			properties: table.fieldProperties?.[name] ?? [],
		})),
	};
	intercept(peer, `/a/${domain}/api/lookup_table/v1/${table.id}/`)
		.reply(200, def)
		.persist();
	for (const [i, row] of table.rows.entries()) {
		const id = fixtureRowId(table, i);
		intercept(peer, `/a/${domain}/api/lookup_table_item/v1/${id}/`)
			.reply(200, {
				id,
				data_type_id: table.id,
				sort_key: i,
				item_attributes: {},
				fields: Object.fromEntries(
					table.fields.map((name) => [
						name,
						{
							field_list: (table.manyValues?.[name] ?? [row[name]]).map(
								(value) => ({ field_value: value, properties: {} }),
							),
						},
					]),
				),
			})
			.persist();
	}
}

/** A rows read CommCare HQ refuses with `status`. */
export function refuseRows(
	peer: MockAgent,
	domain: string,
	table: ServedTable,
	status: number,
): void {
	intercept(
		peer,
		`/a/${domain}/api/fixture/v1/?fixture_type_id=${table.id}`,
	).reply(status, "");
}

/** Every request the peer was sent, as "METHOD path". */
export function sent(peer: MockAgent, host = HOST): string[] {
	return (
		peer
			.getCallHistory()
			?.calls()
			.map(({ method, fullUrl }) => `${method} ${fullUrl.replace(host, "")}`) ??
		[]
	);
}

/** A stored CommCare HQ connection on `server` for the project spaces named. */
export async function connect(
	h: AppStateTestDb,
	userId: string,
	server: "production" | "india" | "eu",
	domains: readonly string[],
): Promise<void> {
	await h
		.db()
		.insertInto("user_settings")
		.values({
			user_id: userId,
			commcare_username: "account",
			commcare_api_key: "ciphertext",
			commcare_server: server,
			approved_domains: JSON.stringify(
				domains.map((name) => ({ name, displayName: name })),
			),
			updated_at: new Date(),
		})
		.execute();
}

// ── A publish's other answers ────────────────────────────────────────────

export const HQ_APP = "working-app";
export const importPath = (domain: string) =>
	`/a/${domain}/apps/api/import_app/`;
export const sourcePath = (domain: string, appId = HQ_APP) =>
	`/a/${domain}/apps/source/${appId}/`;
export const tablesPath = (domain: string) =>
	`/a/${domain}/api/lookup_table/v1/?limit=1000`;
export const rowsPath = (domain: string, table: ServedTable) =>
	`/a/${domain}/api/fixture/v1/?fixture_type_id=${table.id}`;
export const workbookPath = (domain: string) => `/a/${domain}/fixtures/fixapi/`;

/**
 * An accepted import, written here: 201 for a create, 200 for an update.
 * `before` runs as CommCare HQ receives it, for a case about what happens
 * while a publish is under way.
 */
export function acceptImport(
	peer: MockAgent,
	domain: string,
	status: 200 | 201,
	options: {
		readonly appId?: string;
		readonly before?: () => Promise<void>;
	} = {},
): void {
	intercept(peer, importPath(domain), "POST").reply(async () => {
		await options.before?.();
		const appId = options.appId ?? HQ_APP;
		if (status === 201) hqSaves.create(appId);
		return {
			statusCode: status,
			data: JSON.stringify({
				success: true,
				app_id: appId,
				...(status === 200 && { version: hqSaves.save(appId) }),
			}),
		};
	});
}

/** The app's source, as the proof lane retained CommCare HQ's answer. */
export function serveSource(
	peer: MockAgent,
	domain: string,
	name: RetainedPublishRead,
	appId = HQ_APP,
): void {
	replyRetained(
		intercept(peer, sourcePath(domain, appId)),
		retainedPublishRead(name),
	);
}

/** A workbook CommCare HQ took whole. */
export function takeWorkbook(peer: MockAgent, domain: string): void {
	intercept(peer, workbookPath(domain), "POST").reply(200, {
		code: 200,
		message: "Done",
	});
}

/** Every request but the project-space reads each preflight makes for its flags. */
export function publishRequests(peer: MockAgent, host = HOST): string[] {
	return sent(peer, host).filter(
		(line) =>
			!line.startsWith("GET /api/user_domains/v1/") &&
			!isSaveCounterPath(line.slice("GET ".length)),
	);
}
