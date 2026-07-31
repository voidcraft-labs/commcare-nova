/**
 * Server Action for the builder's app-wide case-property rename review.
 *
 * This is explanatory only. It returns the current authoritative mutation
 * sequence plus complete storage counts, never a write token. The eventual
 * exclusive save re-runs admission, authorization, the commit verdict, and
 * every storage collision check inside its write transaction.
 */

"use server";

import { getSession } from "@/lib/auth-utils";
import { readCasePropertyRenameStoragePreflightInTransaction } from "@/lib/case-store";
import {
	AppAccessError,
	resolveAppScopeInTransaction,
} from "@/lib/db/appAccess";
import { loadAppInTransaction } from "@/lib/db/apps";
import { withAppTx } from "@/lib/db/pg";
import {
	evaluatePreparedMutationCandidate,
	mutationWireCanonicalityRejection,
	prepareMutationCandidate,
} from "@/lib/doc/commitVerdicts";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import {
	extractLookupReferenceTargets,
	unionLookupReferenceTargetSets,
} from "@/lib/doc/lookupReferences";
import {
	type AdmittedMutationBatch,
	admitMutationBatch,
	MutationWireCanonicalityError,
} from "@/lib/doc/mutationAdmission";
import { log } from "@/lib/logger";
import { readLookupDefinitionsInTransaction } from "@/lib/lookup/definitionSnapshot";
import type {
	CasePropertyRenameInput,
	CasePropertyRenamePreflightResult,
} from "./casePropertyRenamePreflightTypes";

function appIdFromInput(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const appId = (input as { readonly appId?: unknown }).appId;
	return typeof appId === "string" &&
		appId.length > 0 &&
		appId.length <= 255 &&
		!appId.includes("\0")
		? appId
		: undefined;
}

function renamesFromInput(input: unknown): unknown {
	return typeof input === "object" && input !== null
		? (input as { readonly renames?: unknown }).renames
		: undefined;
}

export async function preflightCasePropertyRenamesAction(input: {
	readonly appId: string;
	readonly renames: readonly CasePropertyRenameInput[];
}): Promise<CasePropertyRenamePreflightResult> {
	const session = await getSession();
	if (!session) return { kind: "unauthenticated" };

	const appId = appIdFromInput(input);
	if (appId === undefined) return { kind: "not-found" };

	try {
		return await withAppTx(async (tx) => {
			const scope = await resolveAppScopeInTransaction(
				tx,
				appId,
				session.user.id,
				"view",
			);
			const app = await loadAppInTransaction(tx, appId);
			if (app === null) throw new AppAccessError("not_found");
			if (
				app.project_id !== scope.projectId ||
				app.mutation_seq !== scope.baseSeq
			) {
				throw new Error(
					"Case-property rename preflight snapshot crossed an app commit.",
				);
			}

			const doc = hydratePersistedBlueprint(app.blueprint);
			let admitted: AdmittedMutationBatch;
			try {
				admitted = admitMutationBatch([
					{
						kind: "renameCaseProperties",
						renames: renamesFromInput(input),
					},
				]);
			} catch (error) {
				if (!(error instanceof MutationWireCanonicalityError)) throw error;
				const rejection = mutationWireCanonicalityRejection(doc, error);
				if (rejection.ok) {
					throw new Error(
						"Mutation wire rejection unexpectedly admitted a rename.",
					);
				}
				return {
					kind: "invalid",
					mutationSeq: scope.baseSeq,
					messages: rejection.findings.map((finding) => finding.message),
				};
			}

			const prepared = prepareMutationCandidate(doc, admitted);
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
			if (!verdict.ok) {
				return {
					kind: "invalid",
					mutationSeq: scope.baseSeq,
					messages: verdict.findings.map((finding) => finding.message),
				};
			}

			const plan = verdict.prepared.casePropertyRenamePlan;
			if (plan === undefined) {
				throw new Error(
					"An admitted case-property rename omitted its canonical plan.",
				);
			}
			const storage = await readCasePropertyRenameStoragePreflightInTransaction(
				tx as unknown as Parameters<
					typeof readCasePropertyRenameStoragePreflightInTransaction
				>[0],
				{
					appId,
					entries: plan.entries,
				},
			);
			if (storage.conflicts.length > 0) {
				return {
					kind: "conflict",
					mutationSeq: scope.baseSeq,
					conflicts: storage.conflicts,
				};
			}
			return {
				kind: "ok",
				mutationSeq: scope.baseSeq,
				report: {
					renamedRows: storage.renamedRows,
					renamedParkedValues: storage.renamedParkedValues,
					byRename: storage.byRename,
				},
			};
		});
	} catch (error) {
		if (error instanceof AppAccessError) {
			return error.reason === "not_found"
				? { kind: "not-found" }
				: { kind: "forbidden" };
		}
		log.error("[case-property-rename/preflight] unhandled", error, { appId });
		throw error;
	}
}
