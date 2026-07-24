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
import { getLookupFixtureData, getLookupManifest } from "@/lib/lookup/service";
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

/** Aggregate stored-row-bytes ceiling per fixture request — 2x the
 *  16 MiB CCZ export budget, far under instance memory. */
const PREVIEW_FIXTURE_BYTE_CEILING = 32 * 1024 * 1024;

const argsSchema = z.object({
	appId: z.string().min(1),
	// The doc-derived referenced set — bounded far above any real doc;
	// the byte ceiling below is the real resource bound.
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
		/* `resolveAppScope` is the light membership proof the sibling
		 * case-data actions use (a project_id column read) — never the
		 * blueprint-assembling `resolveAppAccess`, which this refetch-heavy
		 * path would pay on every Project lookup edit. */
		const { projectId, role } = await resolveAppScope(
			parsed.data.appId,
			identity.ownerId,
			"view",
		);
		const scope = { projectId, actorId: identity.ownerId, role };
		/* Bound the MATERIALIZED bytes, not just the id count: per-table
		 * caps allow 8 MiB of rows each, so an id list alone doesn't bound
		 * the response. Any exportable doc fits the 16 MiB CCZ fixture
		 * budget with room to spare; a request past the ceiling is either
		 * abuse or a doc no export could ever accept. */
		const manifest = await getLookupManifest(scope);
		const requested = new Set<string>(parsed.data.tableIds);
		const requestedBytes = manifest.tables
			.filter((table) => requested.has(table.id as string))
			.reduce((sum, table) => sum + table.dataBytes, 0);
		if (requestedBytes > PREVIEW_FIXTURE_BYTE_CEILING) {
			return {
				kind: "error",
				message:
					"This app references more lookup data than the preview can load at once. Reduce the referenced tables' stored size and try again.",
			};
		}
		const snapshot = await getLookupFixtureData(scope, parsed.data.tableIds);
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
