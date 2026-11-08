/** Exact, reviewed field repairs; never infer a replacement answer from data. */
import { z } from "zod";
import { loadCanonicalBlueprintAtSequence } from "@/lib/agent/change-set/baseLoader";
import { runValidation } from "@/lib/commcare/validator/runner";
import { lockActorGenerationGateForAppHolder } from "@/lib/db/actorGenerationGate";
import { appendSyntheticBatchInTransaction } from "@/lib/db/apps";
import { LEASE_COLUMNS, leaseView } from "@/lib/db/leaseView";
import { getAppDb, withAppTx } from "@/lib/db/pg";
import { designSessionLeaseState, runLeaseState } from "@/lib/db/runLiveness";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import type { PersistableDoc } from "@/lib/domain";
import { selectOptionSchema } from "@/lib/domain/fields";
import { uuidSchema } from "@/lib/domain/uuid";
import { readLookupDefinitionsInTransaction } from "@/lib/lookup/definitionSnapshot";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	nextPersistedSequence,
	safePersistedSequence,
} from "@/lib/utils/persistedSequence";
import {
	loadPersistedBlueprintInTransaction,
	loadPersistedBlueprintReadOnly,
} from "./loadPersistedBlueprint";

const patchSchema = z.strictObject({
	fieldUuid: uuidSchema,
	beforeDigest: z.string().min(1),
	change: z.discriminatedUnion("kind", [
		z.strictObject({ kind: z.literal("remove-starting-value") }),
		z.strictObject({
			kind: z.literal("add-choice"),
			option: selectOptionSchema,
		}),
	]),
});
export const selectStartingValueRepairSchema = z.strictObject({
	appId: z.string().min(1),
	expectedBaseSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	baseDigest: z.string().min(1),
	targetDigest: z.string().min(1),
	reason: z.string().min(1),
	patches: z.array(patchSchema).min(1),
});
export type SelectStartingValueRepair = z.infer<
	typeof selectStartingValueRepairSchema
>;
const ACTOR = "system:select-starting-values";

export function repairedSelectStartingValues(
	before: PersistableDoc,
	patches: SelectStartingValueRepair["patches"],
): PersistableDoc {
	const target = hydratePersistedBlueprint(structuredClone(before));
	const seen = new Set<string>();
	for (const patch of patches) {
		if (seen.has(patch.fieldUuid))
			throw new Error("A repair repeats a question.");
		seen.add(patch.fieldUuid);
		const field = target.fields[patch.fieldUuid];
		if (
			canonicalJsonDigest(before.fields[patch.fieldUuid]) !==
				patch.beforeDigest ||
			(field?.kind !== "single_select" && field?.kind !== "multi_select") ||
			field.optionsSource.kind !== "inline"
		)
			throw new Error("The question differs from its reviewed repair basis.");
		if (patch.change.kind === "remove-starting-value") {
			delete field.default_value;
		} else {
			field.optionsSource.options.push(patch.change.option);
		}
	}
	return toPersistableDoc(target);
}

export async function migrateSelectStartingValues(
	plan: SelectStartingValueRepair,
) {
	return withAppTx(async (tx) => {
		await lockActorGenerationGateForAppHolder(tx, plan.appId);
		const app = await tx
			.selectFrom("apps")
			.select(["id", "mutation_seq", ...LEASE_COLUMNS])
			.where("id", "=", plan.appId)
			.forUpdate()
			.executeTakeFirstOrThrow();
		const sessions = await tx
			.selectFrom("design_sessions")
			.selectAll()
			.where("app_id", "=", plan.appId)
			.orderBy("id")
			.forUpdate()
			.execute();
		const lease = runLeaseState(leaseView(app));
		if (
			lease.present ||
			lease.markerSettleable ||
			sessions.some((session) => {
				const state = designSessionLeaseState(session);
				return state.present || state.markerSettleable;
			})
		)
			throw new Error("A run or unsettled reservation still holds this app.");
		const batchId = `select-starting-values:${canonicalJsonDigest(plan)}`;
		const receipt = await tx
			.selectFrom("app_changes")
			.select(["seq", "actor_id", "kind"])
			.where("app_id", "=", plan.appId)
			.where("batch_id", "=", batchId)
			.executeTakeFirst();
		if (receipt) {
			if (
				receipt.actor_id !== ACTOR ||
				receipt.kind !== "blueprint-migration" ||
				safePersistedSequence(receipt.seq) !==
					nextPersistedSequence(plan.expectedBaseSeq)
			)
				throw new Error("Repair receipt does not match its plan.");
			await loadCanonicalBlueprintAtSequence(tx, {
				appId: plan.appId,
				seq: safePersistedSequence(receipt.seq),
				expectedDigest: plan.targetDigest,
			});
			return { appId: plan.appId, status: "already-applied" };
		}
		const before = await loadPersistedBlueprintInTransaction(tx, plan.appId);
		if (
			before === null ||
			safePersistedSequence(app.mutation_seq) !== plan.expectedBaseSeq ||
			canonicalJsonDigest(before) !== plan.baseDigest
		)
			throw new Error(
				"App differs from its reviewed repair basis. Scan and review it again.",
			);
		const targetDoc = repairedSelectStartingValues(before, plan.patches);
		if (canonicalJsonDigest(targetDoc) !== plan.targetDigest)
			throw new Error("Repair target does not match its plan.");
		const result = await appendSyntheticBatchInTransaction(tx, {
			appId: plan.appId,
			expectedBaseSeq: plan.expectedBaseSeq,
			targetDoc,
			batchId,
			authority: { kind: "system", actorId: ACTOR, reason: plan.reason },
		});
		await loadCanonicalBlueprintAtSequence(tx, {
			appId: plan.appId,
			seq: result.seq,
			expectedDigest: plan.targetDigest,
		});
		return { appId: plan.appId, status: result.kind, seq: result.seq };
	});
}

/** Read the document, sequence and its lookup definitions from one snapshot. */
export async function inspectSelectStartingValues(appId: string) {
	const db = await getAppDb();
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(async (tx) => {
			const app = await tx
				.selectFrom("apps")
				.select(["id", "project_id", "mutation_seq"])
				.where("id", "=", appId)
				.executeTakeFirstOrThrow();
			const blueprint = await loadPersistedBlueprintReadOnly(tx, appId);
			if (!blueprint) throw new Error("App disappeared.");
			const doc = hydratePersistedBlueprint(blueprint);
			const targets = extractLookupReferenceTargets(doc);
			const lookup = await readLookupDefinitionsInTransaction(
				tx,
				app.project_id,
				targets.tableIds,
			);
			const lookupContext = {
				kind: "available" as const,
				...lookup,
			};
			const verdict = runValidation(doc, lookupContext);
			if (
				verdict.some((finding) =>
					[
						"LOOKUP_CONTEXT_UNAVAILABLE",
						"LOOKUP_TABLE_NOT_AVAILABLE",
						"LOOKUP_COLUMN_NOT_AVAILABLE",
					].includes(finding.code),
				)
			)
				throw new Error(
					"Lookup definitions are incomplete; starting-value analysis cannot be certified.",
				);
			const findings = verdict.filter((finding) =>
				[
					"SELECT_DEFAULT_NOT_AN_OPTION",
					"SELECT_DEFAULT_VALUES_UNBOUNDED",
					"SELECT_PRELOAD_WRITE_NOT_AN_OPTION",
				].includes(finding.code),
			);
			return {
				appId,
				expectedBaseSeq: safePersistedSequence(app.mutation_seq),
				baseDigest: canonicalJsonDigest(blueprint),
				blueprint,
				lookupContext,
				findings,
			};
		});
}
