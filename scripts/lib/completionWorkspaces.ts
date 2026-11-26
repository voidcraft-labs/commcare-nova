import { produce } from "immer";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import {
	emptyGenesisBase,
	readCanonicalFoldInputs,
} from "@/lib/agent/change-set/baseLoader";
import { rehydrateChangeSet } from "@/lib/agent/change-set/runtime";
import { loadChangeSet } from "@/lib/agent/change-set/store";
import type { DesignChangeSet } from "@/lib/agent/change-set/types";
import { parsePersistedJsonText } from "@/lib/db/persistedJson";
import type { AppDatabase } from "@/lib/db/pg";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import {
	admitMutationBatch,
	encodeAdmittedMutationEnvelope,
} from "@/lib/doc/mutationAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import { blueprintDocSchema, type PersistableDoc } from "@/lib/domain";
import type { readLookupDefinitionsInTransaction } from "@/lib/lookup/definitionSnapshot";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	nextPersistedSequence,
	safePersistedSequence,
} from "@/lib/utils/persistedSequence";
import type { DeploymentFoldMigration } from "./deploymentFoldArtifacts";

type Tx = Transaction<AppDatabase>;
type HistoricalBase =
	| { kind: "genesis"; appId: string; projectId: string }
	| {
			kind: "edit";
			canonical: Awaited<ReturnType<typeof readCanonicalFoldInputs>>;
	  };

export interface CompletionMigration extends DeploymentFoldMigration {
	readonly conversionSettings: z.core.util.JSONType;
	releasedLookups: typeof readLookupDefinitionsInTransaction;
	privateBase(input: HistoricalBase): { snapshot: unknown; projectId: string };
	privateStep(text: string, digest: string): readonly unknown[];
	privateOverlay(base: unknown, mutations: readonly unknown[]): unknown;
}

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const privatePlanEntry = z.strictObject({
	id: z.string().uuid(),
	appId: z.string().min(1),
	projectId: z.string().min(1),
	sourceSeq: z.number().int().nonnegative().nullable(),
	effectiveSeq: z.number().int().nonnegative().nullable(),
	stepCount: z.number().int().nonnegative(),
	sourceDigest: digest,
	sourceBaseDigest: digest,
	baseDigest: digest,
	candidateDigest: digest,
	conversionsDigest: digest,
});
type Entry = z.infer<typeof privatePlanEntry>;

async function readSteps(tx: Tx, id: string) {
	return tx
		.selectFrom("authoring_steps")
		.select(["ordinal", "request_id", "tool_name", "mutation_digest"])
		.select(sql<string>`mutations::text`.as("text"))
		.where("change_set_id", "=", id)
		.orderBy("ordinal")
		.execute();
}

async function originalEvidence(
	tx: Tx,
	work: DesignChangeSet,
	baseSeq: number | null,
	baseDigest: string,
	steps: Awaited<ReturnType<typeof readSteps>>,
) {
	const stages = await tx
		.selectFrom("authoring_step_stages")
		.selectAll()
		.where("change_set_id", "=", work.id)
		.orderBy("step_ordinal")
		.orderBy("stage_ordinal")
		.execute();
	// Retry evidence includes non-staging requests too. Digest the exact
	// stored JSON on the database so unsafe JSON numbers and large receipts
	// never pass through a JavaScript decoder during the source census.
	const requests = await tx
		.selectFrom("authoring_requests")
		.select([
			"request_id",
			"tool_name",
			"input_digest",
			"expected_revision",
			"resulting_revision",
			"status",
			"rejection_code",
		])
		.select(
			sql<string>`encode(sha256(convert_to(receipt::text,'UTF8')),'hex')`.as(
				"receipt_digest",
			),
		)
		.where("change_set_id", "=", work.id)
		.orderBy("request_id")
		.execute();
	return canonicalJsonDigest({
		requests,
		id: work.id,
		kind: work.kind,
		app: work.appId,
		proposed: work.proposedAppId,
		project: work.baseProjectId,
		baseSeq,
		baseDigest,
		author: work.ownerUserId,
		run: work.ownerRunId,
		session: work.authoringSessionId,
		design: work.designSessionId,
		revision: work.revision,
		plan: work.planRevision,
		exclusive: work.exclusiveKind,
		steps: steps.map((row) => [
			safePersistedSequence(row.ordinal),
			row.request_id,
			row.tool_name,
			row.mutation_digest,
		]),
		stages,
	});
}

function reduce(base: PersistableDoc, batch: readonly unknown[]) {
	const admitted = admitMutationBatch(
		JSON.parse(encodeAdmittedMutationEnvelope(batch).json),
	);
	return toPersistableDoc(
		produce(hydratePersistedBlueprint(base), (draft) => {
			applyMutations(draft, admitted);
		}),
	);
}

function matches(
	base: PersistableDoc,
	mutations: readonly unknown[],
	expected: PersistableDoc,
): boolean {
	try {
		return (
			canonicalJsonDigest(reduce(base, mutations)) ===
			canonicalJsonDigest(expected)
		);
	} catch {
		return false;
	}
}

type ConvertedStep = {
	ordinal: number;
	sourceDigest: string;
	mutationDigest: string;
	mutations: readonly unknown[];
	lengths: number[];
};

/** Prefer preserving each exact admitted instruction. Where its carrier changed,
 * compare the converted original prefix to the production reducer on the new
 * base. Prefixes and the final batch each run their own end-of-batch cleanup. */
function convertSteps(
	migration: CompletionMigration,
	oldBase: unknown,
	base: PersistableDoc,
	steps: readonly { batch: readonly unknown[]; digest: string }[],
	convert: (source: unknown) => PersistableDoc,
	expected: PersistableDoc,
): ConvertedStep[] {
	const oldPrefix: unknown[] = [],
		newPrefix: unknown[] = [];
	const changed: ConvertedStep[] = [];
	let before = base;
	for (const [ordinal, step] of steps.entries()) {
		const endOfStep = convert(
			migration.privateOverlay(oldBase, [...oldPrefix, ...step.batch]),
		);
		if (matches(base, [...newPrefix, ...step.batch], endOfStep)) {
			oldPrefix.push(...step.batch);
			newPrefix.push(...step.batch);
			before = endOfStep;
			continue;
		}
		const mutations: unknown[] = [],
			lengths: number[] = [];
		for (const mutation of step.batch) {
			oldPrefix.push(mutation);
			const after = convert(migration.privateOverlay(oldBase, oldPrefix));
			let emitted: readonly unknown[] = [mutation];
			if (!matches(base, [...newPrefix, mutation], after)) {
				if (
					mutation &&
					typeof mutation === "object" &&
					"kind" in mutation &&
					mutation.kind === "renameCaseProperties"
				)
					throw new Error(
						"A private rename would change its recorded saved-case operation.",
					);
				emitted = diffDocsToMutations(
					hydratePersistedBlueprint(before),
					hydratePersistedBlueprint(after),
				);
				if (!matches(base, [...newPrefix, ...emitted], after))
					throw new Error(
						"The converted private instruction does not reproduce its original edit.",
					);
			}
			mutations.push(...emitted);
			newPrefix.push(...emitted);
			lengths.push(emitted.length);
			before = after;
		}
		const mutationDigest = canonicalJsonDigest(mutations);
		if (
			mutationDigest !== step.digest ||
			lengths.some((length) => length !== 1)
		)
			changed.push({
				ordinal,
				sourceDigest: step.digest,
				mutationDigest,
				mutations,
				lengths,
			});
	}
	if (!matches(base, newPrefix, expected))
		throw new Error(
			"The converted private batch differs from its released overlay.",
		);
	return changed;
}

async function prepareWorkspace(
	tx: Tx,
	work: DesignChangeSet,
	heads: ReadonlyMap<string, number>,
	migration: CompletionMigration,
) {
	const appId = work.appId ?? work.proposedAppId,
		projectId = work.baseProjectId;
	if (!appId || work.status !== "open")
		throw new Error(
			"The private workspace lost its app identity or open state.",
		);
	const scope = {
		appId,
		projectId,
		...(work.kind === "genesis" && { purpose: "private-genesis" }),
	};
	const baseInput: HistoricalBase =
		work.kind === "genesis"
			? { kind: "genesis", appId, projectId }
			: {
					kind: "edit",
					canonical: await readCanonicalFoldInputs(tx, {
						appId,
						seq: requireSeq(work.baseSeq),
					}),
				};
	const old = migration.privateBase(baseInput);
	if (
		old.projectId !== projectId ||
		canonicalJsonDigest(old.snapshot) !== work.baseSnapshotDigest
	)
		throw new Error(
			"The released decoder cannot reconstruct the recorded private base.",
		);
	const raw = await readSteps(tx, work.id);
	if (
		raw.length !== work.nextOrdinal ||
		raw.some((row, i) => safePersistedSequence(row.ordinal) !== i)
	)
		throw new Error("The private admitted steps have a gap.");
	const steps = raw.map((row) => ({
		batch: migration.privateStep(row.text, row.mutation_digest),
		digest: row.mutation_digest,
	}));
	const convert = (source: unknown) =>
		blueprintDocSchema.parse(migration.convert(source, scope));
	const base = convert(old.snapshot);
	const effectiveSeq =
		work.baseSeq !== null && heads.get(appId) === work.baseSeq
			? nextPersistedSequence(work.baseSeq)
			: work.baseSeq;
	const snapshot =
		work.baseSeq !== null && work.baseSeq === effectiveSeq ? base : null;
	const baseDigest = canonicalJsonDigest(base);
	if (work.kind === "genesis" && emptyGenesisBase(appId).digest !== baseDigest)
		throw new Error(
			"The converted private genesis base differs from the candidate's empty app.",
		);
	const expected = convert(
		migration.privateOverlay(
			old.snapshot,
			steps.flatMap((s) => [...s.batch]),
		),
	);
	const changed = convertSteps(
		migration,
		old.snapshot,
		base,
		steps,
		convert,
		expected,
	);
	const entry: Entry = {
		id: work.id,
		appId,
		projectId,
		sourceSeq: work.baseSeq,
		effectiveSeq,
		sourceBaseDigest: work.baseSnapshotDigest,
		baseDigest,
		candidateDigest: canonicalJsonDigest(expected),
		stepCount: steps.length,
		sourceDigest: await originalEvidence(
			tx,
			work,
			work.baseSeq,
			work.baseSnapshotDigest,
			raw,
		),
		conversionsDigest: canonicalJsonDigest(changed),
	};
	return { entry, changed, snapshot };
}

function requireSeq(seq: number | null): number {
	if (seq === null)
		throw new Error("An app-edit workspace has no recorded base sequence.");
	return seq;
}

export async function openWorkspaceIds(tx: Tx) {
	return (
		await tx
			.selectFrom("authoring_workspaces")
			.select("id")
			.where("status", "=", "open")
			.orderBy("id")
			.execute()
	).map((row) => row.id);
}
async function readOpen(tx: Tx, id: string) {
	const work = await loadChangeSet(id, tx);
	if (work?.status !== "open")
		throw new Error("An open workspace changed after the scan.");
	return work;
}

export async function scanPrivateWorkspaces(
	tx: Tx,
	heads: ReadonlyMap<string, number>,
	migration: CompletionMigration,
	progress?: (completed: number, total: number) => void,
) {
	const entries: Entry[] = [];
	const ids = await openWorkspaceIds(tx);
	for (const id of ids) {
		entries.push(
			(await prepareWorkspace(tx, await readOpen(tx, id), heads, migration))
				.entry,
		);
		progress?.(entries.length, ids.length);
	}
	return entries;
}

/** Called before app conversion while the immutable historical carriers can
 * still be decoded. Workspace, app horizons and certificates commit together. */
export async function installPrivateWorkspaces(
	tx: Tx,
	plan: readonly Entry[],
	heads: ReadonlyMap<string, number>,
	migration: CompletionMigration,
) {
	for (const item of plan) {
		const { entry, changed, snapshot } = await prepareWorkspace(
			tx,
			await readOpen(tx, item.id),
			heads,
			migration,
		);
		if (canonicalJsonDigest(entry) !== canonicalJsonDigest(item))
			throw new Error("Private work changed after the reviewed scan.");
		await tx
			.insertInto("authoring_workspace_folds")
			.values({
				change_set_id: entry.id,
				project_id: entry.projectId,
				app_id: entry.appId,
				source_base_seq: entry.sourceSeq,
				effective_base_seq: entry.effectiveSeq,
				source_base_digest: entry.sourceBaseDigest,
				effective_base_digest: entry.baseDigest,
				source_digest: entry.sourceDigest,
				candidate_digest: entry.candidateDigest,
				source_step_count: entry.stepCount,
				base_snapshot: snapshot === null ? null : JSON.stringify(snapshot),
			})
			.execute();
		for (const step of changed)
			await tx
				.insertInto("authoring_step_folds")
				.values({
					change_set_id: entry.id,
					ordinal: step.ordinal,
					source_mutation_digest: step.sourceDigest,
					mutation_digest: step.mutationDigest,
					mutations: JSON.stringify(step.mutations),
					mutation_lengths: JSON.stringify(step.lengths),
				})
				.execute();
		// The runtime never assigns base_seq. Only the cutover operator moves
		// a formerly current workspace over the canonical technical horizon.
		const result =
			await sql`UPDATE authoring_workspaces SET base_seq=${entry.effectiveSeq}, base_snapshot_digest=${entry.baseDigest}
			WHERE id=${entry.id} AND status='open' AND base_seq IS NOT DISTINCT FROM ${entry.sourceSeq}::bigint AND base_snapshot_digest=${entry.sourceBaseDigest}`.execute(
				tx,
			);
		if (result.numAffectedRows !== BigInt(1))
			throw new Error("The original private base moved during conversion.");
	}
}

export async function verifyPrivateWorkspaces(
	tx: Tx,
	entries: readonly Entry[],
) {
	for (const entry of entries) {
		const work = await readOpen(tx, entry.id);
		const row = await tx
			.selectFrom("authoring_workspace_folds")
			.selectAll()
			.where("change_set_id", "=", entry.id)
			.executeTakeFirstOrThrow();
		const raw = await readSteps(tx, entry.id);
		if (
			row.app_id !== entry.appId ||
			row.project_id !== entry.projectId ||
			row.source_base_digest !== entry.sourceBaseDigest ||
			row.source_digest !== entry.sourceDigest ||
			row.candidate_digest !== entry.candidateDigest ||
			row.effective_base_digest !== entry.baseDigest ||
			(row.source_base_seq === null
				? null
				: safePersistedSequence(row.source_base_seq)) !== entry.sourceSeq ||
			(row.effective_base_seq === null
				? null
				: safePersistedSequence(row.effective_base_seq)) !==
				entry.effectiveSeq ||
			safePersistedSequence(row.source_step_count) !== entry.stepCount ||
			work.baseSeq !== entry.effectiveSeq ||
			work.baseSnapshotDigest !== entry.baseDigest ||
			work.nextOrdinal !== entry.stepCount ||
			(await originalEvidence(
				tx,
				work,
				entry.sourceSeq,
				entry.sourceBaseDigest,
				raw,
			)) !== entry.sourceDigest
		)
			throw new Error(
				"Private authority, source or base changed during conversion.",
			);
		const conversion = await tx
			.selectFrom("authoring_step_folds")
			.select(["ordinal", "source_mutation_digest", "mutation_digest"])
			.select([
				sql<string>`mutations::text`.as("mutation_text"),
				sql<string>`mutation_lengths::text`.as("lengths_text"),
			])
			.where("change_set_id", "=", entry.id)
			.orderBy("ordinal")
			.execute();
		const changed = conversion.map((s) => ({
			ordinal: safePersistedSequence(s.ordinal),
			sourceDigest: s.source_mutation_digest,
			mutationDigest: s.mutation_digest,
			mutations: parsePersistedJsonText(
				s.mutation_text,
				"converted private step",
			),
			lengths: parsePersistedJsonText(
				s.lengths_text,
				"converted private step lengths",
			),
		}));
		if (
			canonicalJsonDigest(changed) !== entry.conversionsDigest ||
			(await rehydrateChangeSet(work, tx)).overlay.candidateDigest !==
				entry.candidateDigest
		)
			throw new Error(
				"The resumed private workspace differs from the reviewed conversion.",
			);
	}
}
