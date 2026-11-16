/**
 * The closed genesis owner: every persisted app is born here, through one of
 * three provenances:
 *
 *   - `explicit-blank` (`createExplicitBlankApp`): the canonical minimal
 *     Survey/Form/Question app, created immediately for "Start with a blank
 *     app" in Builder. Its receipt keeps the starter UUIDs because
 *     the blank-builder UX selects/names them.
 *   - `design-slice`: the first valid checkpoint from private agent work, materialized
 *     from a genesis Atomic Change Set by
 *     `lib/agent/change-set/materializeGenesis.ts`, which composes the
 *     transaction-scoped writer here (the replay lives beside the change-set
 *     runtime; the write tail lives beside the canonical commit kernel so
 *     neither package duplicates the other's rules).
 *   - `hq-adoption` (`lib/deployment/reading/birth.ts::adoptHqAppInTransaction`):
 *     an app brought in from CommCare HQ, born `complete` from the reader's
 *     construction batch in the transaction that also writes its Project data
 *     and its adopted deployment.
 *
 * Every provenance shares ONE preparation (`prepareGenesisCandidate`) and ONE
 * write tail (`writePreparedGenesisInTransaction`): exact mutation admission,
 * candidate reduction, the absolute whole-document gate, export readiness,
 * exact lookup/media projections, entity decomposition, the attributed
 * sequence-one `fold-baseline` app change plus the immutable Project-bearing
 * baseline (through the `SECURITY DEFINER` genesis routine), and transactional
 * runtime case-schema admission (`applySchemaChangeInTransaction` at
 * `synced_seq = 1`). Physical case indexes are fixed infrastructure.
 *
 * Preparation may run optimistically outside the retryable transaction (a
 * serialization retry must reuse the same minted identities), but every
 * correctness-bearing external read and verdict repeats inside the
 * transaction before anything is written. Nothing exists if any pre-commit
 * step fails.
 */

import { sql, type Transaction } from "kysely";
import { buildCaseTypeMap, withSchemaContext } from "@/lib/case-store";
import { getAssetsInTransaction } from "@/lib/db/mediaAssets";
import {
	describeCommitFindings,
	evaluatePreparedMutationCandidate,
	exportReadinessFindings,
	type PreparedMutationCandidate,
	prepareMutationCandidate,
} from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	extractLookupReferenceTargets,
	type LookupReferenceTargetSet,
} from "@/lib/doc/lookupReferences";
import {
	type AdmittedMutationBatch,
	admitMutationBatch,
	encodeAdmittedMutationEnvelope,
} from "@/lib/doc/mutationAdmission";
import { canonicalAppGenesis, emptyBlueprintDoc } from "@/lib/doc/scaffolds";
import type { Mutation } from "@/lib/doc/types";
import type { PersistableDoc } from "@/lib/domain/blueprint";
import { collectAssetRefs } from "@/lib/domain/mediaRefs";
import type { Uuid } from "@/lib/domain/uuid";
import {
	builtinAssetRows,
	partitionAssetRefs,
} from "@/lib/media/builtinIconAssets";
import { applyOrganizationCommitIntegrity } from "@/lib/organization/commitIntegrity";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { decomposeBlueprint } from "./blueprintRows";
import {
	admitExactMediaReferences,
	assertProjectCapabilityInTransaction,
	denormalize,
	lookupContextForAuthoritativeWrite,
} from "./canonicalCommitKernel";
import { replaceLookupReferenceEdges } from "./lookupReferenceEdges";
import { type AppDatabase, withAppTx } from "./pg";

// ── Typed rejections ───────────────────────────────────────────────

/**
 * The genesis candidate failed the absolute gate or export readiness: a
 * deterministic content rejection, never an infrastructure fault. For the
 * explicit-blank starter this is a compiler bug (the canonical starter is
 * valid by construction); for a design-slice candidate it is the executor's
 * structured signal to amend the change set. For an `hq-adoption` candidate
 * it is Nova's defect: acceptance passed the same document, and the create
 * answers `check-failed`.
 *
 * `check` names which verdict refused (`gate` for the absolute gate, `export`
 * for export readiness) and `findingCodes` holds the `code` of each finding,
 * so a caller can log what was refused without logging the app's words, which
 * the message quotes.
 */
export class GenesisGateRejectedError extends Error {
	readonly name = "GenesisGateRejectedError";
	readonly check: "gate" | "export";
	readonly findingCodes: readonly string[];

	constructor(
		message: string,
		options: {
			readonly check: "gate" | "export";
			readonly findingCodes: readonly string[];
		},
	) {
		super(message);
		this.check = options.check;
		this.findingCodes = options.findingCodes;
	}
}

// ── Preparation ────────────────────────────────────────────────────

/** One reduced, admitted genesis candidate — everything the write tail
 *  needs that is derivable from the mutations alone. */
export interface PreparedGenesisCandidate {
	readonly appId: string;
	readonly projectId: string;
	readonly admittedMutations: AdmittedMutationBatch;
	readonly prepared: PreparedMutationCandidate;
	readonly persistable: PersistableDoc;
	/** Canonical-JS digest of the persistable candidate — the committed
	 *  snapshot identity a materialization receipt carries. */
	readonly candidateDigest: string;
	readonly lookupTargets: LookupReferenceTargetSet;
}

/**
 * Reduce one genesis mutation batch from the canonical empty Blueprint.
 * Pure and deterministic: safe to run outside the retryable transaction
 * (identities live in the mutations, never minted here) and safe to repeat.
 */
export function prepareGenesisCandidate(args: {
	readonly appId: string;
	readonly projectId: string;
	readonly mutations: readonly Mutation[] | AdmittedMutationBatch;
}): PreparedGenesisCandidate {
	const emptyDoc = emptyBlueprintDoc(args.appId);
	const admitted = admitMutationBatch(args.mutations);
	const prepared = prepareMutationCandidate(emptyDoc, admitted);
	const persistable = toPersistableDoc(prepared.nextDoc);
	return {
		appId: args.appId,
		projectId: args.projectId,
		admittedMutations: admitted,
		prepared,
		persistable,
		candidateDigest: canonicalJsonDigest(persistable),
		lookupTargets: extractLookupReferenceTargets(prepared.nextDoc),
	};
}

// ── The shared write tail ──────────────────────────────────────────

/** Entity rows per insert statement. Each row binds six parameters, and one
 *  statement may bind at most 65,535 (the protocol counts them in 16 bits), so
 *  an app brought in whole, at thousands of menus, forms and fields, is
 *  written in statements of this size inside the one birth transaction. */
const ENTITY_INSERT_CHUNK = 1000;

/** The holder + reservation column groups a design-slice genesis transfers
 *  onto the app row (the exact columns the design session held; §11.5 —
 *  never an interval with two holders or an ownerless reservation). Absent
 *  for a creation that holds no run. */
export interface GenesisHolderTransfer {
	readonly runHolderNonce: string;
	readonly reservation: {
		readonly period: string;
		readonly reserved: number;
		readonly userId: string;
		readonly runId: string;
	};
}

export interface WritePreparedGenesisArgs {
	readonly candidate: PreparedGenesisCandidate;
	/** Creation provenance (`apps.owner`) AND the freshly reauthorized actor. */
	readonly actorUserId: string;
	readonly runId: string;
	readonly status: "generating" | "complete";
	readonly runHolderNonce?: string;
	/** Present exactly when a design-slice materialization transfers the
	 *  session's live hold onto the new app row. */
	readonly holderTransfer?: GenesisHolderTransfer;
	/**
	 * Runs once, after the app row is inserted and before the lookup context is read. A birth that
	 * brings Project data with it writes that data here, so every verdict below reads it on this
	 * transaction. It may lock Project state and the new app's own rows, and no existing app's row.
	 */
	readonly afterAppInsert?: (tx: Transaction<AppDatabase>) => Promise<void>;
}

/**
 * Write one prepared genesis candidate as a complete sequence-1 app, inside
 * the caller's transaction. The caller owns its authority locks (a
 * design-slice materialization holds the actor gate, session row, and
 * change-set row; explicit-blank creation is the shared-gate-first
 * exception; an `hq-adoption` birth holds its HQ app's claim, which may lock
 * one other app's row); this tail owns everything from membership
 * reauthorization to the immutable baseline, with the caller's
 * `afterAppInsert` run inside it. Every verdict here re-runs against the
 * transaction's own locked reads — a prepared candidate is never trusted
 * across the transaction boundary for anything but its deterministic
 * reduction.
 */
export async function writePreparedGenesisInTransaction(
	tx: Transaction<AppDatabase>,
	args: WritePreparedGenesisArgs,
): Promise<void> {
	const { candidate } = args;
	const { appId, projectId } = candidate;
	await assertProjectCapabilityInTransaction(
		tx,
		args.actorUserId,
		projectId,
		"edit",
		"You no longer have edit access to this Project.",
	);
	const transfer = args.holderTransfer;
	const transferredHold = transfer?.reservation;
	await tx
		.insertInto("apps")
		.values({
			id: appId,
			owner: args.actorUserId,
			project_id: projectId,
			...denormalize(candidate.persistable),
			mutation_seq: 1,
			status: args.status,
			awaiting_input: false,
			error_type: null,
			deleted_at: null,
			recoverable_until: null,
			run_id: args.runId,
			run_holder_nonce: transfer?.runHolderNonce ?? args.runHolderNonce ?? null,
			/* A value COPY of the transferred hold, not a liveness read: the
			 * caller (materialization) already proved the exact session holder
			 * through the one lease reader before handing these values over. */
			...(transferredHold !== undefined && {
				res_period: transferredHold.period,
				res_reserved: transferredHold.reserved,
				res_settled: false,
				res_user_id: transferredHold.userId,
				res_run_id: transferredHold.runId,
			}),
		})
		.execute();
	/* After the membership gate (Project state is never taken before it) and
	 * after the app row (a place references it), before the lookup context:
	 * the tables and places this hook writes are what the gate, export
	 * readiness and the organization's integrity read below. */
	if (args.afterAppInsert !== undefined) await args.afterAppInsert(tx);
	const lookupContext = await lookupContextForAuthoritativeWrite(
		tx,
		projectId,
		candidate.lookupTargets,
	);
	const verdict = evaluatePreparedMutationCandidate(
		candidate.prepared,
		lookupContext,
	);
	if (!verdict.ok) {
		throw new GenesisGateRejectedError(
			`The app's first revision must be completely valid, but it is not: ${describeCommitFindings(
				verdict.findings,
			)}`,
			{
				check: "gate",
				findingCodes: verdict.findings.map((finding) => finding.code),
			},
		);
	}
	const { realIds, builtinSlugs } = partitionAssetRefs([
		...collectAssetRefs(verdict.nextDoc),
	]);
	const storedAssets = await getAssetsInTransaction(tx, realIds);
	const mediaAssets = new Map(
		[...storedAssets.values(), ...builtinAssetRows(builtinSlugs)]
			.filter(
				(row) =>
					row.project_id === undefined ||
					row.project_id === candidate.projectId,
			)
			.map((row) => [row.id as string, row]),
	);
	const notExportable = exportReadinessFindings(
		verdict.nextDoc,
		lookupContext,
		mediaAssets,
	);
	if (notExportable.length > 0) {
		throw new GenesisGateRejectedError(
			`The app's first revision must be export-ready, but it could not be exported:\n${notExportable
				.map((error) => `- ${error.message}`)
				.join("\n")}`,
			{
				check: "export",
				findingCodes: notExportable.map((finding) => finding.code),
			},
		);
	}
	await applyOrganizationCommitIntegrity(tx, {
		appId,
		previousDoc: emptyBlueprintDoc(appId),
		candidateDoc: verdict.nextDoc,
	});
	await admitExactMediaReferences(tx, {
		appId,
		projectId,
		candidateDoc: verdict.nextDoc,
	});
	await replaceLookupReferenceEdges(tx, {
		appId,
		projectId,
		targets: candidate.lookupTargets,
	});
	const rows = decomposeBlueprint(candidate.persistable);
	for (let start = 0; start < rows.length; start += ENTITY_INSERT_CHUNK) {
		await tx
			.insertInto("blueprint_entities")
			.values(
				rows.slice(start, start + ENTITY_INSERT_CHUNK).map((r) => ({
					app_id: appId,
					uuid: r.uuid,
					kind: r.kind,
					parent_uuid: r.parent_uuid,
					ordinal: r.ordinal,
					data: JSON.stringify(r.data),
				})),
			)
			.execute();
	}
	const baselineMutations = admitMutationBatch([]);
	await tx
		.insertInto("app_changes")
		.values({
			app_id: appId,
			seq: 1,
			batch_id: genesisBatchId(appId),
			run_id: args.runId,
			actor_id: args.actorUserId,
			kind: "fold-baseline",
			mutations: encodeAdmittedMutationEnvelope(baselineMutations).json,
			from_project_id: null,
			to_project_id: null,
		})
		.execute();
	await sql`SELECT nova_insert_app_change_genesis_fold_baseline(${appId})`.execute(
		tx,
	);
	await admitGenesisRuntimeSchemas(tx, candidate);
}

/** The protected sequence-one batch identity — the only genesis identity the
 *  `SECURITY DEFINER` baseline admit routine accepts beside the frozen
 *  canonical-identity marker. */
export function genesisBatchId(appId: string): string {
	return `genesis:${appId}`;
}

/**
 * Transactional runtime case-schema admission: one `applySchemaChangeInTransaction`
 * per storable case type, including the built-in worker case on survey-only
 * apps, at `synced_seq = 1`. Schema admission and data transitions commit
 * with the app. A deterministic schema-compiler fault throws
 * here and aborts the whole materialization — nothing exists over a
 * permanently-unusable schema.
 */
async function admitGenesisRuntimeSchemas(
	tx: Transaction<AppDatabase>,
	candidate: PreparedGenesisCandidate,
): Promise<void> {
	const store = await withSchemaContext();
	const caseTypeSchemas = buildCaseTypeMap(candidate.persistable);
	for (const caseType of caseTypeSchemas.keys()) {
		await store.applySchemaChangeInTransaction(
			tx as unknown as Parameters<
				typeof store.applySchemaChangeInTransaction
			>[0],
			{
				appId: candidate.appId,
				caseType,
				caseTypeSchemas,
				syncedSeq: 1,
			},
		);
	}
}

// ── Explicit blank ─────────────────────────────────────────────────

/** Optional lifecycle and naming inputs for explicit-blank creation. */
export interface CreateAppOptions {
	/** Initial name authored by the canonical genesis mutation batch. An
	 *  omitted or whitespace-only value becomes the real persisted name
	 *  `Untitled`. */
	name?: string;
	/**
	 * Initial lifecycle status. `"complete"` is the at-rest default — an
	 * explicit-blank app is born with no run behind it. `"generating"` arms
	 * the run-liveness marker and exists for lifecycle fixtures that model a
	 * held mid-build app through the one genesis owner; no product path
	 * passes it. `"error"` is excluded — a fresh app has failed at nothing.
	 */
	status?: "generating" | "complete";
	/** Internal run-lifecycle generation for a `generating` creation. */
	runHolderNonce?: string;
}

/** Exact committed sequence-1 state and identities returned by explicit-blank
 *  genesis. */
export interface CreateAppReceipt {
	appId: string;
	baseSeq: 1;
	blueprint: PersistableDoc;
	/** Canonical-JS digest of `blueprint` — the same identity a
	 * materialization receipt carries, so the one client activation
	 * boundary can digest-verify both birth paths. */
	snapshotDigest: string;
	starter: {
		moduleUuid: Uuid;
		formUuid: Uuid;
		fieldUuid: Uuid;
	};
}

/**
 * Create a new app in its one legal blank birth state: a real nonblank name
 * plus the canonical Survey/Form/Question starter. The batch is prepared and
 * admitted exactly once outside the retryable transaction (a SQL retry may
 * re-run the closure, so UUID minting and the reducer stay out of it); the
 * shared write tail then commits the complete sequence-1 app or nothing.
 */
export async function createExplicitBlankApp(
	owner: string,
	projectId: string,
	runId: string,
	opts?: CreateAppOptions,
): Promise<CreateAppReceipt> {
	const appId = crypto.randomUUID();
	const status = opts?.status ?? "complete";
	const runHolderNonce =
		status === "generating"
			? (opts?.runHolderNonce ?? crypto.randomUUID())
			: undefined;
	const genesis = canonicalAppGenesis(emptyBlueprintDoc(appId), opts?.name);
	const candidate = prepareGenesisCandidate({
		appId,
		projectId,
		mutations: genesis.mutations,
	});
	await withAppTx(async (tx) => {
		await writePreparedGenesisInTransaction(tx, {
			candidate,
			actorUserId: owner,
			runId,
			status,
			...(runHolderNonce !== undefined && { runHolderNonce }),
		});
	});
	return {
		appId,
		baseSeq: 1,
		blueprint: candidate.persistable,
		snapshotDigest: candidate.candidateDigest,
		starter: {
			moduleUuid: genesis.moduleUuid,
			formUuid: genesis.formUuid,
			fieldUuid: genesis.fieldUuid,
		},
	};
}

// ── The materialization receipt ────────────────────────────────────

/**
 * The strict activation receipt every genesis emits (§12.6): the complete
 * server-derived access tuple plus the exact sequence-1 snapshot. A receipt
 * read back after a fold horizon follows the birth carries the saved app at
 * its own sequence, because the birth sequence no longer replays. The
 * explicit-blank variant carries the starter UUIDs (the blank-builder UX
 * selects/names them); a design-slice receipt has no starter. An
 * `hq-adoption` birth sends `AdoptedAppReceipt`, these keys and `adoption`.
 */
export interface AppMaterializationReceipt {
	readonly eventVersion: 1;
	readonly designSessionId: string | null;
	readonly appId: string;
	readonly projectId: string;
	readonly role: string;
	readonly canEdit: boolean;
	readonly seq: number;
	readonly batchId: string;
	readonly changeSetId: string | null;
	readonly snapshotDigest: string;
	readonly blueprint: PersistableDoc;
	readonly starter: {
		readonly moduleUuid: Uuid;
		readonly formUuid: Uuid;
		readonly fieldUuid: Uuid;
	} | null;
}

/** What a brought-in app's receipt says of where it came from. */
export interface AppAdoption {
	/** A `CommCareServer`, as text: this file imports nothing of `lib/commcare`. */
	readonly server: string;
	readonly domain: string;
	readonly remoteAppId: string;
}

/**
 * The activation receipt of an `hq-adoption` birth: the twelve keys of every
 * receipt, and one. Only the bring-in's create sends it, to a client that
 * admits it as a second exact key set; every other birth keeps sending the
 * twelve keys, so a tab running an earlier client still lands those.
 */
export interface AdoptedAppReceipt extends AppMaterializationReceipt {
	readonly designSessionId: null;
	readonly changeSetId: null;
	readonly starter: null;
	readonly adoption: AppAdoption;
}
