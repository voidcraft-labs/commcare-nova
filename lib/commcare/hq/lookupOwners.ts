import "server-only";

import { type CommCareCredentials, hqDomainPath } from "./http";
import {
	LookupWorkbookMismatch,
	lookupOwnerKinds,
	type ResolvedLookupPrincipal,
	type WorkbookRowOwners,
} from "./lookupWorkbook";
import { giveBackHeld } from "./memoryMeter";
import { isHqObject, readHqCollection } from "./readCollection";
import { findHqMobileWorkers } from "./workers";

/** Resolve only names on the submitted selected-table sheet. HQ's group API
 * has no name selector: the editor authorizes checking its directory explicitly.
 * Group memberships and unselected names never leave the response decoder.
 * A selected export uses exact location site codes (download.py::OwnerNames). */
export async function lookupWorkbookPrincipals(
	creds: CommCareCredentials,
	domain: string,
	rows: readonly WorkbookRowOwners[],
	cancel?: AbortSignal,
) {
	const principals: ResolvedLookupPrincipal[] = [];
	for (const kind of lookupOwnerKinds) {
		const names = new Set(rows.flatMap((row) => row.owners[kind]));
		if (!names.size) continue;
		if (kind === "user") {
			const wanted = [...names];
			if (wanted.some((name) => !/^[\w.+-]{1,128}$/.test(name)))
				throw new LookupWorkbookMismatch();
			for (let i = 0; i < wanted.length; i += 100) {
				cancel?.throwIfAborted();
				const batch = wanted.slice(i, i + 100);
				const full = new Map(
					batch.map((name) => [`${name}@${domain}.commcarehq.org`, name]),
				);
				const result = await findHqMobileWorkers(creds, domain, [
					...full.keys(),
				]);
				if ("success" in result) throw new LookupWorkbookMismatch();
				for (const worker of result) {
					const name = full.get(worker.username);
					if (name) principals.push({ kind, id: worker.userId, name });
				}
			}
			continue;
		}
		// Location and group responses are bounded and compared across passes. Keep
		// the stable identity for the paging check, and only the selected name.
		const list = await readHqCollection(creds, {
			label: "lookup assignment directory",
			firstUrl:
				hqDomainPath(domain) +
				"/api/" +
				(kind === "group" ? "group/v1" : "location/v2") +
				"/?limit=100",
			maxBytes: 8 * 1024 * 1024,
			maxRows: 50_000,
			maxPages: 500,
			cancel,
			row(raw) {
				if (!isHqObject(raw)) return null;
				const id = kind === "group" ? raw.id : raw.location_id;
				const name = kind === "group" ? raw.name : raw.site_code;
				if (
					typeof id !== "string" ||
					!id ||
					typeof name !== "string" ||
					(raw.domain !== undefined && raw.domain !== domain)
				)
					return null;
				return { id, name: names.has(name) ? name : null };
			},
			identity: (row) => row.id,
		});
		if ("success" in list || "kind" in list) throw new LookupWorkbookMismatch();
		try {
			for (const row of list.rows)
				if (row.name !== null)
					principals.push({ kind, id: row.id, name: row.name });
		} finally {
			giveBackHeld("text", list.bytes);
		}
	}
	return principals;
}
