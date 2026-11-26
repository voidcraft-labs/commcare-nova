"use server";

import { z } from "zod";
import { getSession } from "@/lib/auth-utils";
import {
	AppAccessError,
	resolveAuthorizedAppSnapshot,
} from "@/lib/db/appAccess";
import { readWorkerLookupProjection } from "@/lib/deployment/workerLookupProjection";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import { uuidSchema } from "@/lib/domain/uuid";
import { LookupError } from "@/lib/lookup/errors";
import type {
	LookupFixtureRow,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import { reportUnexpectedActionError } from "./caseDataBindingTelemetry";

export interface LookupFixtureDataWire {
	readonly projectRevision: string;
	readonly definitions: readonly LookupTableDefinition[];
	readonly rowsByTable: Readonly<Record<string, readonly LookupFixtureRow[]>>;
}

export type LoadLookupFixtureDataResult =
	| { kind: "unauthenticated" }
	| { kind: "data"; data: LookupFixtureDataWire }
	| { kind: "error"; message: string };

const argsSchema = z.object({
	appId: z.string().min(1),
	personaUuid: uuidSchema.optional(),
	// The doc-derived referenced set — bounded far above any real doc;
	// the byte ceiling below is the real resource bound.
	tableIds: z.array(lookupTableIdSchema).max(500),
});

export async function loadLookupFixtureDataAction(
	appId: string,
	tableIds: readonly string[],
	personaUuid?: string,
): Promise<LoadLookupFixtureDataResult> {
	try {
		const session = await getSession();
		if (!session) return { kind: "unauthenticated" };
		const parsed = argsSchema.safeParse({ appId, tableIds, personaUuid });
		if (!parsed.success) {
			return {
				kind: "error",
				message:
					"The lookup data request was malformed. Reload the builder and try again.",
			};
		}
		const authorized = await resolveAuthorizedAppSnapshot(
			appId,
			session.user.id,
			"view",
		);
		const referenced = new Set(
			extractLookupReferenceTargets(
				hydratePersistedBlueprint(authorized.app.blueprint),
			).tableIds,
		);
		if (parsed.data.tableIds.some((id) => !referenced.has(id)))
			return {
				kind: "error",
				message:
					"The app’s data tables changed. You can reload Preview to read its current choices.",
			};
		const snapshot = await readWorkerLookupProjection(
			{
				scope: {
					appId,
					projectId: authorized.projectId,
					actorUserId: session.user.id,
				},
				grant: { kind: "session", sessionId: session.session.id },
				personaUuid: parsed.data.personaUuid,
			},
			parsed.data.tableIds,
		);
		return {
			kind: "data",
			data: {
				projectRevision: snapshot.projectRevision,
				definitions: snapshot.definitions,
				rowsByTable: Object.fromEntries(snapshot.rowsByTable),
			},
		};
	} catch (err) {
		if (err instanceof LookupError)
			return { kind: "error", message: err.message };
		if (err instanceof AppAccessError) {
			return { kind: "error", message: "App not found." };
		}
		reportUnexpectedActionError("loadLookupFixtureData", err, { appId });
		return {
			kind: "error",
			message: "We couldn't load the lookup data. Try again.",
		};
	}
}
