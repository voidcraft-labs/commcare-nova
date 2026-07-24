"use server";

// Server Action loading the lookup fixture data the running preview
// evaluates carriers against: definitions plus complete ordered rows
// for the doc's referenced tables, in ONE consistent snapshot
// (`getLookupFixtureData`'s REPEATABLE READ read). Authorization is
// the standard preview shape — the identity resolves server-side and
// membership is proven against the APP's own Project, so a foreign or
// deleted app collapses to the IDOR-safe "App not found.". Missing
// and foreign-Project table ids are silently absent from the result
// (the reader's contract) — the client's requireTable invariant owns
// the loud failure if a doc references one.
//
// The result crosses as plain JSON (`rowsByTable` as a Record) per
// the case-data wire rules; the client hook rebuilds the Map and
// derives the evaluation projection.

import { z } from "zod";
import { AppAccessError, resolveAppAccess } from "@/lib/db/appAccess";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import { getLookupFixtureData } from "@/lib/lookup/service";
import type {
	LookupFixtureRow,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import { resolvePreviewIdentity } from "./caseDataBindingHelpers";
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
	// The doc-derived referenced set — bounded far above any real doc,
	// far below abuse territory.
	tableIds: z.array(lookupTableIdSchema).max(500),
});

export async function loadLookupFixtureDataAction(
	appId: string,
	tableIds: readonly string[],
): Promise<LoadLookupFixtureDataResult> {
	try {
		const identity = await resolvePreviewIdentity();
		if (!identity) return { kind: "unauthenticated" };
		const parsed = argsSchema.safeParse({ appId, tableIds });
		if (!parsed.success) {
			return {
				kind: "error",
				message:
					"The lookup data request was malformed — reload the builder and try again.",
			};
		}
		const { projectId, role } = await resolveAppAccess(
			parsed.data.appId,
			identity.ownerId,
			"view",
		);
		const snapshot = await getLookupFixtureData(
			{ projectId, actorId: identity.ownerId, role },
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
		if (err instanceof AppAccessError) {
			return { kind: "error", message: "App not found." };
		}
		reportUnexpectedActionError("loadLookupFixtureData", err, { appId });
		return {
			kind: "error",
			message:
				err instanceof Error ? err.message : "Failed to load lookup data.",
		};
	}
}
