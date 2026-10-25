/**
 * The body of the platform change preflight
 * (`platformChangePreflight.ts::platformChangePreflightAction`), kept out of
 * the `"use server"` module because every export of one is a Server Action a
 * client can call.
 *
 * It answers one question before the builder commits a change of
 * `appSettings.runsOnlyOn` that adds a platform: what in the committed app,
 * content and media alike, would the new declaration refuse? Everything is
 * read in one `repeatable read` transaction, so the content check and the
 * media rows come from one snapshot on one pool connection. It is
 * explanatory only and returns no write token: the commit that follows runs
 * the client gate again, and the commit kernel's media admission stays the
 * authority on the server.
 */

import "server-only";

import {
	AppAccessError,
	resolveAppScopeInTransaction,
} from "@/lib/db/appAccess";
import { loadAppInTransaction } from "@/lib/db/apps";
import { withAppTx } from "@/lib/db/pg";
import {
	evaluatePreparedMutationCandidate,
	prepareMutationCandidate,
} from "@/lib/doc/commitVerdicts";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import {
	extractLookupReferenceTargets,
	unionLookupReferenceTargetSets,
} from "@/lib/doc/lookupReferences";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import { PLATFORMS, type Platform } from "@/lib/domain/platforms";
import { readLookupDefinitionsInTransaction } from "@/lib/lookup/definitionSnapshot";
import { mediaDeclarationVerdict } from "@/lib/media/attachVerdicts";
import { describeUnplayableReferences } from "@/lib/media/platformPlayback";
import type { StructuredCommitFinding } from "./hooks/useBlueprintMutations";
import type {
	PlatformChangePreflightInput,
	PlatformChangePreflightResult,
} from "./platformChangePreflightTypes";

/** The input's two fields, or `undefined` when either is not what the
 * builder sends. */
function readInput(
	input: unknown,
): { appId: string; runsOnlyOn: Platform | null } | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const { appId, runsOnlyOn } = input as Partial<PlatformChangePreflightInput>;
	if (
		typeof appId !== "string" ||
		appId.length === 0 ||
		appId.length > 255 ||
		appId.includes("\0")
	)
		return undefined;
	if (
		runsOnlyOn !== null &&
		!(PLATFORMS as readonly unknown[]).includes(runsOnlyOn)
	)
		return undefined;
	return { appId, runsOnlyOn: runsOnlyOn ?? null };
}

/** The finding as the builder reads it: plain JSON, no validator types. */
function structuredFinding(finding: {
	readonly code: string;
	readonly scope: StructuredCommitFinding["scope"];
	readonly location: StructuredCommitFinding["location"];
	readonly details?: Readonly<Record<string, string>>;
}): StructuredCommitFinding {
	const { moduleUuid, moduleName, formUuid, formName, fieldUuid, fieldId } =
		finding.location;
	return {
		code: finding.code,
		scope: finding.scope,
		location: {
			...(moduleUuid !== undefined && { moduleUuid }),
			...(moduleName !== undefined && { moduleName }),
			...(formUuid !== undefined && { formUuid }),
			...(formName !== undefined && { formName }),
			...(fieldUuid !== undefined && { fieldUuid }),
			...(fieldId !== undefined && { fieldId }),
		},
		...(finding.details !== undefined && { details: { ...finding.details } }),
	};
}

export async function readPlatformChangePreflight(
	input: PlatformChangePreflightInput,
	userId: string,
): Promise<PlatformChangePreflightResult> {
	const read = readInput(input);
	if (read === undefined) return { kind: "not-found" };
	const { appId, runsOnlyOn } = read;
	try {
		return await withAppTx(
			async (tx) => {
				// Edit, because only an editor can act on the answer.
				const scope = await resolveAppScopeInTransaction(
					tx,
					appId,
					userId,
					"edit",
				);
				const app = await loadAppInTransaction(tx, appId);
				if (app === null) throw new AppAccessError("not_found");
				if (
					app.project_id !== scope.projectId ||
					app.mutation_seq !== scope.baseSeq
				) {
					throw new Error(
						"Platform change preflight snapshot crossed an app commit.",
					);
				}
				const doc = hydratePersistedBlueprint(app.blueprint);
				const prepared = prepareMutationCandidate(
					doc,
					admitMutationBatch([
						{ kind: "setAppSettings", settings: { runsOnlyOn } },
					]),
				);
				const lookupTargets = unionLookupReferenceTargetSets(
					extractLookupReferenceTargets(doc),
					extractLookupReferenceTargets(prepared.nextDoc),
				);
				const lookupSnapshot = await readLookupDefinitionsInTransaction(
					tx,
					scope.projectId,
					lookupTargets.tableIds,
				);
				const verdict = evaluatePreparedMutationCandidate(prepared, {
					kind: "available",
					...lookupSnapshot,
				});
				const findings = verdict.ok
					? []
					: verdict.findings.map((finding) => ({
							line: userFacingError(finding),
							finding: structuredFinding(finding),
						}));
				const media = await mediaDeclarationVerdict({
					projectId: scope.projectId,
					doc: prepared.nextDoc,
					db: tx,
				});
				const mediaRows = media.ok
					? []
					: media.references.map((reference) => ({
							line: describeUnplayableReferences([reference]),
							location: reference.ref.location,
						}));
				return findings.length === 0 && mediaRows.length === 0
					? { kind: "ok" as const, mutationSeq: scope.baseSeq }
					: {
							kind: "refused" as const,
							mutationSeq: scope.baseSeq,
							findings,
							media: mediaRows,
						};
			},
			{ isolationLevel: "repeatable read" },
		);
	} catch (error) {
		// A member who may only view is told so; anyone outside the Project
		// learns nothing about whether the app exists.
		if (error instanceof AppAccessError) {
			return error.reason === "insufficient_role"
				? { kind: "forbidden" }
				: { kind: "not-found" };
		}
		throw error;
	}
}
