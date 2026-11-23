"use server";

// Server Action loading the lookup fixture data the running preview
// evaluates carriers against: definitions plus complete ordered rows
// for the doc's referenced tables, in ONE consistent snapshot
// (`getLookupFixtureData`'s REPEATABLE READ read). Authorization is
// the standard preview shape — the identity resolves server-side and
// membership is proven against the APP's own Project via the light
// `resolveAppScope`, so a foreign app collapses to the IDOR-safe
// "App not found.". Missing and foreign-Project table ids are
// silently absent from the result (the reader's contract) — the
// client's coverage guards then hold the affected surfaces in their
// loading state.
//
// The result crosses as plain JSON (`rowsByTable` as a Record) per
// the case-data wire rules; the client hook rebuilds the Map and
// derives the evaluation projection.

import { z } from "zod";
import { AppAccessError, resolveAppScope } from "@/lib/db/appAccess";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";
import { DEVICE_FIXTURE_MAX_TABLES } from "@/lib/lookup/constants";
import { LookupError } from "@/lib/lookup/errors";
import type {
	LookupFixtureRow,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import { reportUnexpectedActionError } from "./caseDataBindingTelemetry";
import { resolvePreviewIdentity } from "./previewAuthorization";
import { readPreviewLookup } from "./workerLookupScope";

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
	// The doc-derived referenced set — bounded far above any real doc;
	// the byte ceiling below is the real resource bound.
	tableIds: z.array(lookupTableIdSchema).max(DEVICE_FIXTURE_MAX_TABLES),
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
					"The lookup data request was malformed. Reload the builder and try again.",
			};
		}
		/* `resolveAppScope` is the light membership proof the sibling
		 * case-data actions use (a project_id column read) — never the
		 * blueprint-assembling `resolveAppAccess`, which this refetch-heavy
		 * path would pay on every Project lookup edit. */
		const { projectId, role } = await resolveAppScope(
			parsed.data.appId,
			identity.actorUserId,
			"view",
		);
		const scope = { projectId, actorId: identity.actorUserId, role };
		const snapshot = await readPreviewLookup(scope, parsed.data.tableIds);
		return {
			kind: "data",
			data: {
				projectRevision: snapshot.projectRevision,
				definitions: snapshot.definitions,
				rowsByTable: Object.fromEntries(snapshot.rowsByTable),
			},
		};
	} catch (err) {
		if (err instanceof LookupError && err.code === "storage_limit")
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
