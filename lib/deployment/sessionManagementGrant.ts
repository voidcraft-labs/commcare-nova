import "server-only";
import type { Transaction } from "kysely";
import { lockCurrentProjectGrant } from "@/lib/auth/dataGrant";
import { type AppDatabase, withAppTx } from "@/lib/db/pg";
import { DeploymentCredentialInactiveError } from "./errors";

export class DeploymentSessionEndedError extends DeploymentCredentialInactiveError {
	constructor() {
		super("Your sign-in has ended. Sign in again to continue.");
	}
}

/** The browser authenticated this particular session. A later HQ request or
 * review can outlive it even while its user remains a Project member. */
export function sessionManagementGrant(actorUserId: string, sessionId: string) {
	const check = async (tx: Transaction<AppDatabase>) => {
		const current = await lockCurrentProjectGrant(
			tx,
			actorUserId,
			{ kind: "session", sessionId },
			[],
		);
		if (current === null) {
			throw new DeploymentSessionEndedError();
		}
	};
	return (tx?: Transaction<AppDatabase>) => (tx ? check(tx) : withAppTx(check));
}
