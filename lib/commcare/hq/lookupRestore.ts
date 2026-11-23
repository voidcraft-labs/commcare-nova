import "server-only";

import { createHash } from "node:crypto";
import { SaxesParser, type SaxesTagNS } from "saxes";
import { recordFromEntries } from "@/lib/domain/records";
import type { WorkerGroupRow } from "@/lib/domain/workerGroups";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	HQ_LOOKUP_PROJECTION_BYTES,
	HQ_LOOKUP_RESTORE_WORK_BYTES,
	XML_DOCUMENT_MAX_DEPTH,
	XML_DOCUMENT_MAX_NAMESPACE_DECLARATIONS,
	XML_DOCUMENT_MAX_NODES,
} from "./bounds";
import { withHqRequestDeadline } from "./deadline";
import {
	baseUrl,
	type CommCareApiError,
	type CommCareCredentials,
	HQ_MALFORMED_ANSWER,
	type HqAnswer,
	INVALID_DOMAIN_SLUG,
	isValidDomainSlug,
	sendHq,
	unansweredRead,
} from "./http";
import type { HqLookupTable } from "./lookupTables";

const RESPONSE = "http://openrosa.org/http/response";
const SYNC = "http://commcarehq.org/sync";
const REGISTRATION = "http://openrosa.org/user/registration";
const FIXTURE_PREFIX = "item-list:";
const RESTORE_TOKEN = /^[\w-]{1,150}$/;

/** A row as this worker's phone receives it. It has no HQ row identity. */
export interface WorkerLookupRow {
	readonly attributes: Readonly<Record<string, string>>;
	readonly fields: readonly {
		name: string;
		text: string;
		properties: Readonly<Record<string, string>>;
	}[];
}

export interface LookupWorker {
	readonly username: string;
	/** Required for a known mobile worker. For a web user's own global restore the registration supplies it. */
	readonly userId?: string;
}

export interface LookupWorkerProjection {
	readonly sourceDigest: string;
	readonly workerId: string;
	readonly workerName: string;
	readonly principal: "web" | "commcare";
	readonly observedAt: string;
	readonly baseToken: string;
	readonly continuationToken: string;
	readonly read: "full" | "continuous-delta";
	readonly indexedFields: readonly string[];
	readonly rows: readonly WorkerLookupRow[];
}

class RestoreReadError extends Error {
	constructor(readonly kind: "malformed" | "too-large" = "malformed") {
		super("The selected worker fixture could not be verified.");
	}
}

function plainAttributes(tag: SaxesTagNS) {
	const pairs = Object.values(tag.attributes).filter(
		(attr) => attr.uri !== "http://www.w3.org/2000/xmlns/",
	);
	if (pairs.some((attr) => attr.uri !== "")) throw new RestoreReadError();
	return recordFromEntries(pairs.map((attr) => [attr.local, attr.value]));
}

export function cleanLookupFixtureField(name: string) {
	const escaped = name.replace(/[/\\<>\s]/gu, "_");
	return escaped.startsWith("xml") ? `_${escaped.slice(3)}` : escaped;
}

/** Project a streamed OpenRosaResponse onto the selected worker, tag and schema.
 * Cases, passwords, unrelated fixtures and other registration data are never retained. */
function lookupRestoreReader(
	table: HqLookupTable | null,
	observeRow?: (row: WorkerLookupRow) => void,
) {
	const id = table ? FIXTURE_PREFIX + table.tag : "user-groups";
	const parser = new SaxesParser({
		xmlns: true,
		defaultXMLVersion: "1.0",
		forceXMLVersion: true,
	});
	const names: string[] = [];
	let nodes = 0,
		declarations = 0,
		selectedBytes = 0;
	let block:
		| "groups"
		| "fixture"
		| "schema"
		| "sync"
		| "registration"
		| "ignored" = "ignored";
	let registrationCount = 0,
		syncCount = 0,
		successSeen = false;
	let fixtureId: string | undefined,
		fixtureIndexed = false,
		containerSeen = false,
		indexContainerSeen = false,
		schemaSeen = false;
	const indices: string[] = [];
	const metadata = new Map<string, string>();
	let scalar: { key: string; depth: number; value: string } | undefined;
	let row:
		| {
				attributes: Record<string, string>;
				fields: {
					name: string;
					text: string;
					properties: Record<string, string>;
				}[];
		  }
		| undefined;
	const rows: WorkerLookupRow[] = [];
	const groups: WorkerGroupRow[] = [];
	let group:
		| {
				id: string;
				name?: string;
				details: { key: string; value: string }[];
				dataSeen: boolean;
		  }
		| undefined;
	let detailKey: string | undefined;

	function countBytes(text: string) {
		selectedBytes += Buffer.byteLength(text);
		if (selectedBytes > HQ_LOOKUP_PROJECTION_BYTES)
			throw new RestoreReadError("too-large");
	}
	const fieldNames = new Map(
		(table?.fields ?? []).map((field, index) => [
			cleanLookupFixtureField(field),
			index,
		]),
	);
	if (fieldNames.size !== (table?.fields.length ?? 0))
		throw new RestoreReadError();
	let lastFieldIndex = -1;
	parser.on("doctype", () => {
		throw new RestoreReadError();
	});
	parser.on("xmldecl", (decl) => {
		if (decl.version !== "1.0") throw new RestoreReadError();
	});
	parser.on("opentag", (tag) => {
		names.push(tag.local);
		const depth = names.length;
		const attrs = Object.values(tag.attributes);
		nodes += 1 + attrs.length;
		declarations += attrs.filter(
			(attr) => attr.uri === "http://www.w3.org/2000/xmlns/",
		).length;
		if (
			depth > XML_DOCUMENT_MAX_DEPTH ||
			nodes >
				(observeRow ? HQ_LOOKUP_RESTORE_WORK_BYTES : XML_DOCUMENT_MAX_NODES) ||
			declarations > XML_DOCUMENT_MAX_NAMESPACE_DECLARATIONS
		)
			throw new RestoreReadError("too-large");
		if (scalar) throw new RestoreReadError();
		if (depth === 1) {
			if (tag.local !== "OpenRosaResponse" || tag.uri !== RESPONSE)
				throw new RestoreReadError();
		} else if (depth === 2) {
			if (tag.uri === SYNC && tag.local === "Sync") {
				if (++syncCount !== 1) throw new RestoreReadError();
				block = "sync";
			} else if (tag.uri === REGISTRATION && tag.local === "Registration") {
				if (++registrationCount !== 1) throw new RestoreReadError();
				block = "registration";
			} else if (
				tag.uri === RESPONSE &&
				tag.local === "message" &&
				tag.attributes.nature?.value === "ota_restore_success"
			) {
				successSeen = true;
			} else if (
				tag.uri === RESPONSE &&
				tag.local === "fixture" &&
				tag.attributes.id?.value === id
			) {
				if (fixtureId !== undefined || !tag.attributes.user_id?.value)
					throw new RestoreReadError();
				fixtureId = tag.attributes.user_id.value;
				if (tag.attributes.indexed && tag.attributes.indexed.value !== "true")
					throw new RestoreReadError();
				fixtureIndexed = tag.attributes.indexed?.value === "true";
				block = table ? "fixture" : "groups";
			} else if (
				tag.uri === RESPONSE &&
				tag.local === "schema" &&
				tag.attributes.id?.value === id
			) {
				if (schemaSeen || !table) throw new RestoreReadError();
				schemaSeen = true;
				block = "schema";
			}
		} else if (block === "groups") {
			if (tag.uri !== RESPONSE) throw new RestoreReadError();
			const attributes = plainAttributes(tag),
				keys = Object.keys(attributes);
			countBytes(tag.name);
			for (const key of keys) countBytes(key + attributes[key]);
			if (
				depth === 3 &&
				tag.local === "groups" &&
				!keys.length &&
				!containerSeen
			)
				containerSeen = true;
			else if (
				depth === 4 &&
				tag.local === "group" &&
				containerSeen &&
				keys.length === 1 &&
				attributes.id
			)
				group = { id: attributes.id, details: [], dataSeen: false };
			else if (
				depth === 5 &&
				group &&
				tag.local === "name" &&
				!keys.length &&
				group.name === undefined &&
				!group.dataSeen
			)
				scalar = { key: "group-name", depth, value: "" };
			else if (
				depth === 5 &&
				group &&
				tag.local === "group_data" &&
				!keys.length &&
				group.name !== undefined &&
				!group.dataSeen
			)
				group.dataSeen = true;
			else if (
				depth === 6 &&
				group?.dataSeen &&
				names[depth - 2] === "group_data" &&
				tag.local === "data" &&
				keys.length === 1 &&
				Object.hasOwn(attributes, "key")
			) {
				detailKey = attributes.key;
				scalar = { key: "group-detail", depth, value: "" };
			} else throw new RestoreReadError();
		} else if (block === "fixture" && table) {
			if (tag.uri !== RESPONSE) throw new RestoreReadError();
			countBytes(tag.name);
			for (const attr of attrs) countBytes(attr.name + attr.value);
			if (depth === 3 && tag.local === `${table.tag}_list` && !containerSeen)
				containerSeen = true;
			else if (depth === 4 && tag.local === table.tag && containerSeen) {
				const attributes = plainAttributes(tag);
				if (
					Object.keys(attributes).length !== table.itemAttributes.length ||
					table.itemAttributes.some((name) => !Object.hasOwn(attributes, name))
				)
					throw new RestoreReadError();
				row = { attributes, fields: [] };
				lastFieldIndex = -1;
			} else if (depth === 5 && fieldNames.has(tag.local) && row) {
				const position = fieldNames.get(tag.local) ?? -1;
				if (position < lastFieldIndex) throw new RestoreReadError();
				lastFieldIndex = position;
				row.fields.push({
					name: tag.local,
					text: "",
					properties: plainAttributes(tag),
				});
				scalar = { key: "field", depth, value: "" };
			} else throw new RestoreReadError();
		} else if (block === "schema") {
			if (tag.uri !== RESPONSE) throw new RestoreReadError();
			if (depth === 3 && tag.local === "indices" && !indexContainerSeen)
				indexContainerSeen = true;
			else if (depth === 4 && tag.local === "index" && indexContainerSeen)
				scalar = { key: "index", depth, value: "" };
			else throw new RestoreReadError();
		} else if (
			block === "sync" &&
			tag.uri === SYNC &&
			depth === 3 &&
			tag.local === "restore_id"
		)
			scalar = { key: "token", depth, value: "" };
		else if (block === "registration" && tag.uri === REGISTRATION) {
			if (depth === 3 && (tag.local === "uuid" || tag.local === "username"))
				scalar = { key: tag.local, depth, value: "" };
			else if (
				depth === 4 &&
				names[2] === "user_data" &&
				tag.local === "data"
			) {
				const key = tag.attributes.key?.value;
				if (key === "commcare_project" || key === "commcare_user_type")
					scalar = { key, depth, value: "" };
			}
		}
	});
	const text = (value: string) => {
		if (scalar) {
			countBytes(value);
			scalar.value += value;
		} else if (
			(block === "groups" || block === "fixture" || block === "schema") &&
			value.trim() !== ""
		)
			throw new RestoreReadError();
	};
	parser.on("text", text);
	parser.on("cdata", text);
	parser.on("closetag", () => {
		const depth = names.length;
		if (scalar && scalar.depth === depth) {
			if (scalar.key === "group-name" && group) group.name = scalar.value;
			else if (
				scalar.key === "group-detail" &&
				group &&
				detailKey !== undefined
			) {
				group.details.push({ key: detailKey, value: scalar.value });
				detailKey = undefined;
			} else if (scalar.key === "field" && row)
				row.fields[row.fields.length - 1].text = scalar.value;
			else if (scalar.key === "index") {
				if (indices.length >= (table?.fields.length ?? 0))
					throw new RestoreReadError();
				indices.push(scalar.value);
			} else {
				if (metadata.has(scalar.key)) throw new RestoreReadError();
				metadata.set(scalar.key, scalar.value);
			}
			scalar = undefined;
		}
		if (block === "groups" && depth === 4 && group) {
			if (group.name === undefined) throw new RestoreReadError();
			groups.push({ id: group.id, name: group.name, details: group.details });
			group = undefined;
		}
		if (block === "fixture" && depth === 4 && row) {
			if (observeRow) {
				observeRow(row);
				selectedBytes = 0;
			} else rows.push(row);
			row = undefined;
		}
		if (depth === 2) block = "ignored";
		names.pop();
	});
	const decoder = new TextDecoder("utf-8", { fatal: true });
	return {
		chunk(bytes: Uint8Array) {
			parser.write(decoder.decode(bytes, { stream: true }));
		},
		finish() {
			parser.write(decoder.decode()).close();
			const token = metadata.get("token"),
				workerId = metadata.get("uuid"),
				workerName = metadata.get("username");
			const domain = metadata.get("commcare_project"),
				principal = metadata.get("commcare_user_type");
			if (
				!successSeen ||
				!token ||
				!RESTORE_TOKEN.test(token) ||
				!workerId ||
				!workerName ||
				!domain ||
				(principal !== "web" && principal !== "commcare")
			)
				throw new RestoreReadError();
			if (
				fixtureId !== undefined &&
				(fixtureId !== workerId ||
					!containerSeen ||
					fixtureIndexed !== schemaSeen)
			)
				throw new RestoreReadError();
			if (
				schemaSeen &&
				(!fixtureId ||
					!indexContainerSeen ||
					!indices.length ||
					new Set(indices).size !== indices.length ||
					indices.some((field) => !table?.fields.includes(field)))
			)
				throw new RestoreReadError();
			return {
				token,
				workerId,
				workerName,
				domain,
				principal: principal as "web" | "commcare",
				hasFixture: fixtureId !== undefined,
				groups,
				rows,
				indices,
			};
		},
	};
}

/** The application stores verified checkpoints server-side. Ordinary worker actions
 * always request a full observation; an omitted fixture in a continuous delta can
 * recover historical state but cannot attest current assignments. */
let restoresInFlight = 0;

async function readRestore(
	creds: CommCareCredentials,
	domain: string,
	table: HqLookupTable | null,
	worker: LookupWorker,
	options: {
		cancel?: AbortSignal;
		previous?: LookupWorkerProjection;
		binding: string;
	},
	observeRow?: (row: WorkerLookupRow) => void,
): Promise<
	| (LookupWorkerProjection & { groups: readonly WorkerGroupRow[] })
	| CommCareApiError
> {
	if (
		!isValidDomainSlug(domain) ||
		!worker.username.trim() ||
		worker.username.length > 255 ||
		!options.binding
	)
		return INVALID_DOMAIN_SLUG;
	const sourceDigest = canonicalJsonDigest([
		"lookup-worker-v1",
		options.binding,
		creds.server,
		domain,
		creds.username,
		table,
		worker,
	]);
	const previous =
		options.previous?.sourceDigest === sourceDigest
			? options.previous
			: undefined;
	const url = new URL(`${baseUrl(creds)}/a/${domain}/phone/restore/`);
	if (worker.username !== creds.username)
		url.searchParams.set("as", worker.username);
	url.searchParams.set("overwrite_cache", "true");
	if (previous) url.searchParams.set("since", previous.continuationToken);
	// Each decoder retains up to one complete selected worker projection.
	// Concurrent full restores must also fit the process memory allowance.
	if (restoresInFlight >= 2) return { success: false, status: 503 };
	restoresInFlight++;
	try {
		return await withHqRequestDeadline(
			async (signal) => {
				let answer: HqAnswer;
				try {
					answer = await sendHq(creds, url.toString(), {
						accept: "application/xml",
						noStore: true,
						signal,
					});
				} catch {
					return unansweredRead("selected lookup restore", signal);
				}
				if (!answer.ok) {
					await answer.discard();
					return { success: false, status: answer.status } as const;
				}
				let parsed: ReturnType<
					ReturnType<typeof lookupRestoreReader>["finish"]
				>;
				try {
					const reader = lookupRestoreReader(table, observeRow);
					const result = await answer.consume(
						HQ_LOOKUP_RESTORE_WORK_BYTES,
						reader.chunk,
					);
					if (result !== "read")
						return result === "too-long"
							? ({ success: false, status: 502, cause: "too-large" } as const)
							: unansweredRead("selected lookup restore", signal);
					parsed = reader.finish();
				} catch (error) {
					await answer.discard();
					if (signal.aborted)
						return unansweredRead("selected lookup restore", signal);
					return error instanceof RestoreReadError && error.kind === "too-large"
						? ({ success: false, status: 502, cause: "too-large" } as const)
						: HQ_MALFORMED_ANSWER;
				}
				const { token, workerId, workerName, principal, hasFixture } = parsed;
				const expectedName =
					principal === "web" ? worker.username : worker.username.split("@")[0];
				if (
					parsed.domain !== domain ||
					workerName !== expectedName ||
					(worker.userId !== undefined && worker.userId !== workerId) ||
					(principal === "web" &&
						(creds.username !== worker.username ||
							(table && !table.isGlobal && parsed.rows.length > 0)))
				)
					return HQ_MALFORMED_ANSWER;
				if (!hasFixture && !previous) return HQ_MALFORMED_ANSWER;
				if (
					previous &&
					(previous.workerId !== workerId ||
						previous.continuationToken === token)
				)
					return HQ_MALFORMED_ANSWER;
				return {
					sourceDigest,
					workerId,
					workerName,
					principal,
					observedAt: new Date().toISOString(),
					baseToken: previous?.baseToken ?? token,
					continuationToken: token,
					read: previous ? ("continuous-delta" as const) : ("full" as const),
					groups: parsed.groups,
					rows: hasFixture ? parsed.rows : (previous?.rows ?? []),
					indexedFields: hasFixture
						? parsed.indices
						: (previous?.indexedFields ?? []),
				};
			},
			60_000,
			options.cancel,
		);
	} finally {
		restoresInFlight--;
	}
}

export function readLookupWorkerRestore(
	creds: CommCareCredentials,
	domain: string,
	table: HqLookupTable,
	worker: LookupWorker,
	options: {
		cancel?: AbortSignal;
		previous?: LookupWorkerProjection;
		binding: string;
	},
) {
	return readRestore(creds, domain, table, worker, options).then((result) => {
		if ("success" in result) return result;
		const { groups: _, ...lookup } = result;
		return lookup;
	});
}

/** Ordered length-framed hashes of complete rows. Row counts alone cannot distinguish
 * drift, duplicate-visible rows or a projection that drops a repeated field. */
export function lookupDeviceWitness() {
	const hash = createHash("sha256");
	let count = 0;
	return {
		observe(row: WorkerLookupRow) {
			hash.update(canonicalJsonDigest(row));
			count++;
		},
		finish() {
			return { digest: hash.digest("hex"), count };
		},
	};
}

/** Only disclose the comparison evidence after the entire restore, selected fixture,
 * registration and credential have verified. Bound heap by one row during parsing. */
export async function readGlobalLookupRestoreWitness(
	creds: CommCareCredentials,
	domain: string,
	table: HqLookupTable,
	options: { binding: string; cancel?: AbortSignal },
) {
	if (!table.isGlobal) return HQ_MALFORMED_ANSWER;
	const witness = lookupDeviceWitness();
	const result = await readRestore(
		creds,
		domain,
		table,
		{ username: creds.username },
		options,
		witness.observe,
	);
	if ("success" in result) return result;
	return {
		...witness.finish(),
		workerId: result.workerId,
		indexedFields: result.indexedFields,
	};
}

/** A full worker restore verifies identity and scope even for an empty groups
 * container. Missing fixtures and partial deltas cannot stand for no groups. */
export async function readWorkerGroupsRestore(
	creds: CommCareCredentials,
	domain: string,
	worker: LookupWorker,
	binding: string,
	cancel?: AbortSignal,
) {
	const result = await readRestore(creds, domain, null, worker, {
		binding,
		cancel,
	});
	if ("success" in result) return result;
	return {
		groups: result.groups,
		workerId: result.workerId,
		workerName: result.workerName,
		principal: result.principal,
		observedAt: result.observedAt,
	};
}
