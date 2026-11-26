import "server-only";
import { NO_ENTRIES, ownRecordValue } from "@/lib/domain/records";
import {
	type CommCareCredentials,
	hqDomainPath,
	isValidDomainSlug,
} from "./http";
import { giveBackHeld } from "./memoryMeter";
import { isHqObject, readHqCollection } from "./readCollection";
import { readHqJson } from "./readJson";

const validId = (id: unknown): id is string =>
	typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
export interface TargetWorkerGroup {
	id: string;
	name: string;
	users: string[];
	sharesCases: boolean;
	metadata: Record<string, string>;
}
/** v0_5.GroupResource inherits GroupResource's scoped, permission-checked GET.
 * Read membership only on the single selected group. */
export async function readTargetWorkerGroup(
	creds: CommCareCredentials,
	domain: string,
	id: string,
): Promise<TargetWorkerGroup | null> {
	if (!isValidDomainSlug(domain) || !validId(id)) return null;
	const response = await readHqJson(
		creds,
		`${hqDomainPath(domain)}/api/group/v1/${id}/`,
		"selected worker group",
		{ maxBytes: 1024 * 1024 },
	);
	if ("success" in response) return null;
	try {
		const raw = response.data;
		if (
			!isHqObject(raw) ||
			raw.domain !== domain ||
			raw.id !== id ||
			typeof raw.name !== "string" ||
			!raw.name ||
			typeof raw.case_sharing !== "boolean" ||
			!Array.isArray(raw.users) ||
			!raw.users.every(validId)
		)
			return null;
		const metadata = ownRecordValue(raw, "metadata") ?? NO_ENTRIES;
		if (
			!isHqObject(metadata) ||
			!Object.values(metadata).every((x) => typeof x === "string")
		)
			return null;
		return {
			id,
			name: raw.name,
			sharesCases: raw.case_sharing,
			users: raw.users,
			metadata: metadata as Record<string, string>,
		};
	} finally {
		giveBackHeld("text", response.bytes);
	}
}

/** The registered endpoint has no name filter. Discard all unselected names
 * and memberships in the decoder. Equal names are offered as separate IDs. */
export async function searchTargetWorkerGroups(
	creds: CommCareCredentials,
	domain: string,
	name: string,
) {
	if (!isValidDomainSlug(domain)) return null;
	const result = await readHqCollection(creds, {
		label: "selected worker group names",
		firstUrl: `${hqDomainPath(domain)}/api/group/v1/?limit=100`,
		maxBytes: 8 * 1024 * 1024,
		maxRows: 50_000,
		maxPages: 500,
		row(raw) {
			if (
				!isHqObject(raw) ||
				raw.domain !== domain ||
				!validId(raw.id) ||
				typeof raw.name !== "string"
			)
				return null;
			return { id: raw.id, match: raw.name === name };
		},
		identity: (group) => group.id,
	});
	if ("success" in result || "kind" in result) return null;
	try {
		return result.rows
			.filter((row) => row.match)
			.map((row) => ({ id: row.id, name }));
	} finally {
		giveBackHeld("text", result.bytes);
	}
}
