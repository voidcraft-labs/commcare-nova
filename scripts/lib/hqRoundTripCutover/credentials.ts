/**
 * Which members' stored CommCare HQ keys qualify for a deployment, decided
 * from Nova's rows alone, before any request.
 *
 * A member qualifies where `lib/db/settings.ts::resolveUploadTarget`'s three
 * facts hold for the deployment: a stored key (a username and its encrypted
 * key), a stored server that is the deployment's, and approved domains that
 * name the deployment's domain. The order a deployment's reads try them in
 * is its creator while still a current member of the app's Project, then
 * every other current member in the order they joined (`auth_member`'s
 * `createdAt`, then user id). A deployment no member qualifies for has no
 * key to try: it is `unreadable` whatever HQ would answer, and the scan lists
 * it as `no-credential`.
 */

import { isCommCareServer } from "@/lib/commcare/servers";

/** One current member of a Project with what their stored settings hold. */
export interface MemberCredential {
	readonly userId: string;
	readonly joinedAt: Date;
	/** A stored username and encrypted key are both present. */
	readonly hasStoredKey: boolean;
	readonly server: string | null;
	readonly approvedDomains: readonly string[];
}

/** The facts of one deployment the credential order reads. */
export interface CredentialDeployment {
	readonly createdBy: string;
	readonly server: string;
	readonly domain: string;
}

/** Whether one member's stored key may be sent for the deployment. */
export function memberQualifies(
	member: MemberCredential,
	deployment: CredentialDeployment,
): boolean {
	return (
		member.hasStoredKey &&
		member.server !== null &&
		isCommCareServer(member.server) &&
		member.server === deployment.server &&
		member.approvedDomains.includes(deployment.domain)
	);
}

function joinOrder(a: MemberCredential, b: MemberCredential): number {
	const time = a.joinedAt.getTime() - b.joinedAt.getTime();
	if (time !== 0) return time;
	return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
}

/**
 * The user ids whose keys a deployment's reads try, in order: the creator
 * first where they are a current member, then the other members by when they
 * joined; each one whose stored settings do not qualify is left out.
 */
export function credentialOrder(
	deployment: CredentialDeployment,
	members: readonly MemberCredential[],
): readonly string[] {
	const creator = members.find(
		(member) => member.userId === deployment.createdBy,
	);
	const others = members
		.filter((member) => member.userId !== deployment.createdBy)
		.sort(joinOrder);
	return [...(creator === undefined ? [] : [creator]), ...others]
		.filter((member) => memberQualifies(member, deployment))
		.map((member) => member.userId);
}
