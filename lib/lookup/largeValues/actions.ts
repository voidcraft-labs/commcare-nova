"use server";

import { lockProjectDataGrant } from "@/lib/auth/dataGrant";
import { getSession } from "@/lib/auth-utils";
import { AppAccessError, resolveProjectAccess } from "@/lib/db/appAccess";
import { withAppTx } from "@/lib/db/pg";
import { LookupError } from "../errors";
import { lookupStorageRefusal } from "../generations/budget";
import { authorizeLookupWriteInTransaction } from "../writerTransaction";
import {
	type LookupValueEditRequest,
	type LookupValueReadRequest,
	lookupValueEditRequestSchema,
	lookupValueReadRequestSchema,
} from "./input";
import {
	applyLookupValueEditInTransaction,
	readLookupValueInTransaction,
} from "./service";

const unavailable = {
	ok: false as const,
	message: "This lookup value is unavailable with this connection.",
};
async function authenticated<T>(
	projectId: string,
	mode: "view" | "edit",
	work: (
		scope: { projectId: string; actorId: string; role: string },
		sessionId: string,
	) => Promise<T>,
) {
	if (typeof projectId !== "string" || !projectId || projectId.length > 255)
		return unavailable;
	const session = await getSession();
	if (!session) return unavailable;
	try {
		const project = await resolveProjectAccess(
			session.user.id,
			projectId,
			mode,
		);
		return {
			ok: true as const,
			...(await work(
				{
					projectId: project.projectId,
					actorId: session.user.id,
					role: project.role,
				},
				session.session.id,
			)),
		};
	} catch (error) {
		if (error instanceof AppAccessError) return unavailable;
		const failure =
			error instanceof LookupError ? error : lookupStorageRefusal(error);
		if (failure) return { ok: false as const, message: failure.message };
		throw error;
	}
}
export async function readLookupValueAction(
	projectId: string,
	input: LookupValueReadRequest,
) {
	const request = lookupValueReadRequestSchema.safeParse(input);
	if (!request.success) return unavailable;
	return authenticated(projectId, "view", (scope, sessionId) =>
		withAppTx(async (tx) => {
			await lockProjectDataGrant(
				tx,
				scope.actorId,
				{ kind: "session", sessionId },
				[],
			);
			return readLookupValueInTransaction(tx, scope, request.data);
		}),
	);
}
export async function editLookupValueAction(
	projectId: string,
	input: LookupValueEditRequest,
) {
	const request = lookupValueEditRequestSchema.safeParse(input);
	if (!request.success)
		return {
			ok: false as const,
			message: "The edit doesn't describe a complete lookup value or chunk.",
		};
	return authenticated(projectId, "edit", (scope, sessionId) =>
		withAppTx(async (tx) => {
			const authority = await authorizeLookupWriteInTransaction(
				tx,
				scope,
				"edit",
			);
			await lockProjectDataGrant(
				tx,
				scope.actorId,
				{ kind: "session", sessionId },
				[],
			);
			return applyLookupValueEditInTransaction(
				tx,
				authority,
				request.data,
				sessionId,
			);
		}),
	);
}
