import "server-only";
import type { RestoreScope } from "@/lib/case-store";
import {
	assignedLocationUuids,
	ownRecordValue,
	type PersistableDoc,
	personasOf,
} from "@/lib/domain";
import { memberOwnerIds, personaOwnerIds } from "@/lib/organization/ownerSets";
import { readOrganizationTopology } from "@/lib/organization/service";
import type { ResolvedPreviewIdentity } from "./identity";

/**
 * The owner ids seeding this preview's restore.
 *
 * `CouchUser.get_owner_ids` is the worker's own id plus one per case-sharing
 * group, and in Nova every group is a place the persona receives cases from.
 * Previewing as the signed-in member is a worker assigned nowhere, so it is
 * their own id and nothing else — a real answer, not a degraded one.
 *
 * The place tree is read only when a persona could actually reach one. An app
 * with no organization gives every persona its own uuid and nothing more, and
 * that is derivable from the document alone, so the common case adds no query
 * to a case-list render.
 */
export async function resolveRestoreScope(args: {
	readonly appId: string;
	readonly identity: ResolvedPreviewIdentity;
	readonly blueprint: PersistableDoc | undefined;
}): Promise<RestoreScope> {
	const { appId, identity, blueprint } = args;
	const personaUuid = identity.personaUuid;
	if (personaUuid === undefined || blueprint === undefined) {
		return { ownerIds: memberOwnerIds(identity.actorUserId) };
	}
	const persona = ownRecordValue(personasOf(blueprint), personaUuid);
	if (persona === undefined) {
		// Unreachable through `resolveAuthorizedPreviewContext`, which refuses a
		// missing persona above rather than falling back to the member.
		return { ownerIds: memberOwnerIds(identity.actorUserId) };
	}
	if (assignedLocationUuids(persona.locations).length === 0) {
		return { ownerIds: personaOwnerIds(blueprint, persona, []) };
	}
	const { rows } = await readOrganizationTopology(appId);
	return { ownerIds: personaOwnerIds(blueprint, persona, rows) };
}
