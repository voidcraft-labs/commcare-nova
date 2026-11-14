/**
 * The own close of a form whose menu selects several cases, closing under a
 * condition, stands in a condition group of each selected case's row
 * (`caseOps.ts::saveToCaseBlockShape`). A document published before that
 * shape recorded the block one segment short of it, with no condition group
 * (`Form.ownClosePlacement`). The plan keeps no hold whose length differs from
 * its shape (`placement.ts::planPlacements`, reason `block-shape`), so the
 * gate refuses such a document (`HELD_PLACEMENT_INEXPRESSIBLE`), and every
 * export with it. This repair writes each such held path at its shape: the
 * recorded segments keep their places, and the condition group takes the name the form's plan of generated nodes gives it
 * (`generatedNodes.ts::planGeneratedNodes`, `conditionClose`), suffixed by the
 * planner's own rule where a sibling already holds the name.
 *
 * The transform is pure and idempotent. The scan reads one snapshot of each
 * app, judges its repair with the commit gate, and writes the reviewed plan:
 * per app, the sequence and digest it read, the forms the repair moves, and
 * the digest of the repaired document. The migrate writes a plan entry only
 * where the app still holds exactly that basis, through the synthetic commit
 * path and its gate, so a document the repair cannot make valid is reported
 * and left unchanged.
 */
import type { Transaction } from "kysely";
import { z } from "zod";
import { loadCanonicalBlueprintAtSequence } from "@/lib/agent/change-set/baseLoader";
import { saveToCaseBlockShape } from "@/lib/commcare/xform/caseOps";
import { planGeneratedNodes } from "@/lib/commcare/xform/generatedNodes";
import { lockActorGenerationGateForAppHolder } from "@/lib/db/actorGenerationGate";
import { appendSyntheticBatchInTransaction } from "@/lib/db/apps";
import { BlueprintCommitRejectedError } from "@/lib/db/commitGuard";
import { LEASE_COLUMNS, leaseView } from "@/lib/db/leaseView";
import { type AppDatabase, getAppDb, withAppTx } from "@/lib/db/pg";
import { designSessionLeaseState, runLeaseState } from "@/lib/db/runLiveness";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { diffDocsToMutations } from "@/lib/doc/diffDocsToMutations";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { extractLookupReferenceTargets } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, PersistableDoc, Uuid } from "@/lib/domain";
import type { OwnClosePlacement } from "@/lib/domain/placements";
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

const TASK = "several-case-close-places";
const ACTOR = `system:${TASK}`;
const REASON =
	"Keep the own close of a several-case form under its condition group";

/** One form whose held own close is one segment short of its shape. */
export interface SeveralCaseClosePlace {
	readonly formUuid: Uuid;
	readonly held: OwnClosePlacement["path"];
	readonly migrated: OwnClosePlacement["path"];
}

/**
 * Every form of `doc`, in menu and form order, whose held own close is the
 * several-case shape without its condition group: the shape the emitter
 * gives the own close holds `selected-cases` and `condition`, and the held
 * path has every segment of it but the condition's.
 */
export function severalCaseClosePlaces(
	doc: BlueprintDoc,
): readonly SeveralCaseClosePlace[] {
	const places: SeveralCaseClosePlace[] = [];
	for (const moduleUuid of doc.moduleOrder)
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			const held = doc.forms[formUuid]?.ownClosePlacement;
			if (held === undefined) continue;
			const shape = saveToCaseBlockShape(doc, formUuid, { kind: "own-close" });
			const at = shape.indexOf("condition");
			if (
				at < 0 ||
				!shape.includes("selected-cases") ||
				held.path.length !== shape.length - 1
			)
				continue;
			const condition = planGeneratedNodes(doc, formUuid).conditionClose();
			const [first, ...rest] = [
				...held.path.slice(0, at),
				condition,
				...held.path.slice(at),
			];
			if (first === undefined) continue;
			places.push({ formUuid, held: held.path, migrated: [first, ...rest] });
		}
	return places;
}

/**
 * `before` with every held own close `severalCaseClosePlaces` finds written
 * at its shape. A document with none comes back unchanged, so a second run
 * changes nothing.
 */
export function withSeveralCaseClosePlaces(before: PersistableDoc): {
	readonly target: PersistableDoc;
	readonly places: readonly SeveralCaseClosePlace[];
} {
	const doc = hydratePersistedBlueprint(before);
	const places = severalCaseClosePlaces(doc);
	if (places.length === 0) return { target: before, places };
	for (const place of places)
		doc.forms[place.formUuid] = {
			...doc.forms[place.formUuid],
			ownClosePlacement: { kind: "save-to-case", path: place.migrated },
		};
	return { target: toPersistableDoc(doc), places };
}

/** One app's reviewed repair: the basis the scan read and what it moves. */
export const severalCaseClosePlaceRepairSchema = z.strictObject({
	appId: z.string().min(1),
	expectedBaseSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	baseDigest: z.string().min(1),
	targetDigest: z.string().min(1),
	formUuids: z.array(uuidSchema).min(1),
});
export type SeveralCaseClosePlaceRepair = z.infer<
	typeof severalCaseClosePlaceRepairSchema
>;

/** What the scan found in one app. Ids, counts and finding codes only; the
 *  plan entry goes to the private plan file, never to the console. */
export type SeveralCaseClosePlaceInspection =
	| { readonly appId: string; readonly status: "unchanged" }
	| { readonly appId: string; readonly status: "held"; readonly forms: number }
	| {
			readonly appId: string;
			readonly status: "refused";
			readonly forms: number;
			readonly findingCodes: readonly string[];
	  }
	| {
			readonly appId: string;
			readonly status: "planned";
			readonly forms: number;
			readonly repair: SeveralCaseClosePlaceRepair;
	  };

/** Every app id, or the one asked for, in id order. */
export async function appIdsToScan(appId?: string): Promise<string[]> {
	const db = await getAppDb();
	let query = db.selectFrom("apps").select("id").orderBy("id");
	if (appId !== undefined) query = query.where("id", "=", appId);
	return (await query.execute()).map((row) => row.id);
}

async function heldByRun(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<boolean> {
	const app = await tx
		.selectFrom("apps")
		.select(LEASE_COLUMNS)
		.where("id", "=", appId)
		.executeTakeFirstOrThrow();
	const sessions = await tx
		.selectFrom("design_sessions")
		.selectAll()
		.where("app_id", "=", appId)
		.execute();
	const lease = runLeaseState(leaseView(app));
	return (
		lease.present ||
		lease.markerSettleable ||
		sessions.some((session) => {
			const state = designSessionLeaseState(session);
			return state.present || state.markerSettleable;
		})
	);
}

/** The commit gate's finding codes for writing `target` over `before`, empty
 *  when the gate accepts it. */
async function gateFindingCodes(
	tx: Transaction<AppDatabase>,
	appId: string,
	before: PersistableDoc,
	target: PersistableDoc,
): Promise<readonly string[]> {
	const app = await tx
		.selectFrom("apps")
		.select("project_id")
		.where("id", "=", appId)
		.executeTakeFirstOrThrow();
	const doc = hydratePersistedBlueprint(before);
	const next = hydratePersistedBlueprint(target);
	const definitions = await readLookupDefinitionsInTransaction(
		tx,
		app.project_id,
		extractLookupReferenceTargets(next).tableIds,
	);
	const verdict = mutationCommitVerdict(doc, diffDocsToMutations(doc, next), {
		kind: "available",
		...definitions,
	});
	return verdict.ok ? [] : verdict.findings.map((finding) => finding.code);
}

function readOnlySnapshot<T>(
	work: (tx: Transaction<AppDatabase>) => Promise<T>,
): Promise<T> {
	return getAppDb().then((db) =>
		db
			.transaction()
			.setIsolationLevel("repeatable read")
			.setAccessMode("read only")
			.execute(work),
	);
}

/**
 * Read one app from one read-only snapshot and judge its repair with the
 * commit gate: unchanged when it holds no such close, held when a run or an
 * unsettled reservation holds the app, refused with the gate's finding codes,
 * or planned with the reviewed entry the migrate takes.
 */
export function inspectSeveralCaseClosePlaces(
	appId: string,
): Promise<SeveralCaseClosePlaceInspection> {
	return readOnlySnapshot(async (tx) => {
		const app = await tx
			.selectFrom("apps")
			.select("mutation_seq")
			.where("id", "=", appId)
			.executeTakeFirstOrThrow();
		const before = await loadPersistedBlueprintReadOnly(tx, appId);
		if (before === null) return { appId, status: "unchanged" };
		const { target, places } = withSeveralCaseClosePlaces(before);
		const forms = places.length;
		if (forms === 0) return { appId, status: "unchanged" };
		if (await heldByRun(tx, appId)) return { appId, status: "held", forms };
		const findingCodes = await gateFindingCodes(tx, appId, before, target);
		if (findingCodes.length > 0)
			return { appId, status: "refused", forms, findingCodes };
		return {
			appId,
			status: "planned",
			forms,
			repair: {
				appId,
				expectedBaseSeq: safePersistedSequence(
					app.mutation_seq,
					`apps.mutation_seq for app ${appId}`,
				),
				baseDigest: canonicalJsonDigest(before),
				targetDigest: canonicalJsonDigest(target),
				formUuids: places.map((place) => place.formUuid),
			},
		};
	});
}

/**
 * The document the app holds now and its repair under a reviewed entry. It
 * throws unless the app still holds the entry's exact basis and the repair
 * moves the same forms to the same target the review saw.
 */
function reviewedRepair(
	plan: SeveralCaseClosePlaceRepair,
	seq: number,
	before: PersistableDoc | null,
): { readonly before: PersistableDoc; readonly target: PersistableDoc } {
	if (
		before === null ||
		seq !== plan.expectedBaseSeq ||
		canonicalJsonDigest(before) !== plan.baseDigest
	)
		throw new Error(
			`App ${plan.appId} has changed since its repair was reviewed. Scan it again and review the new plan.`,
		);
	const { target, places } = withSeveralCaseClosePlaces(before);
	const moved = places.map((place) => place.formUuid);
	if (
		canonicalJsonDigest(target) !== plan.targetDigest ||
		moved.length !== plan.formUuids.length ||
		moved.some((formUuid, at) => formUuid !== plan.formUuids[at])
	)
		throw new Error(
			`The repair of app ${plan.appId} no longer produces the reviewed document. Scan it again and review the new plan.`,
		);
	return { before, target };
}

/** What the migrate did with one reviewed entry. */
export type SeveralCaseClosePlaceOutcome =
	| {
			readonly appId: string;
			readonly status: "would-migrate" | "migrated" | "already-applied";
			readonly forms: number;
			readonly seq?: number;
	  }
	| {
			readonly appId: string;
			readonly status: "refused";
			readonly forms: number;
			readonly findingCodes: readonly string[];
	  };

/**
 * The migrate's dry run for one reviewed entry, from one read-only snapshot:
 * the basis fence, the holder check and the commit gate, with nothing written.
 */
export function previewSeveralCaseClosePlaceRepair(
	plan: SeveralCaseClosePlaceRepair,
): Promise<SeveralCaseClosePlaceOutcome> {
	return readOnlySnapshot(async (tx): Promise<SeveralCaseClosePlaceOutcome> => {
		const app = await tx
			.selectFrom("apps")
			.select("mutation_seq")
			.where("id", "=", plan.appId)
			.executeTakeFirstOrThrow();
		const { before, target } = reviewedRepair(
			plan,
			safePersistedSequence(
				app.mutation_seq,
				`apps.mutation_seq for app ${plan.appId}`,
			),
			await loadPersistedBlueprintReadOnly(tx, plan.appId),
		);
		if (await heldByRun(tx, plan.appId))
			throw new Error(
				`A run or an unsettled reservation still holds app ${plan.appId}. Run the repair again once it is free.`,
			);
		const forms = plan.formUuids.length;
		const findingCodes = await gateFindingCodes(tx, plan.appId, before, target);
		return findingCodes.length > 0
			? { appId: plan.appId, status: "refused", forms, findingCodes }
			: { appId: plan.appId, status: "would-migrate", forms };
	});
}

async function migrateInTransaction(
	tx: Transaction<AppDatabase>,
	plan: SeveralCaseClosePlaceRepair,
): Promise<SeveralCaseClosePlaceOutcome> {
	await lockActorGenerationGateForAppHolder(tx, plan.appId);
	const app = await tx
		.selectFrom("apps")
		.select("mutation_seq")
		.where("id", "=", plan.appId)
		.forUpdate()
		.executeTakeFirstOrThrow();
	await tx
		.selectFrom("design_sessions")
		.select("id")
		.where("app_id", "=", plan.appId)
		.orderBy("id")
		.forUpdate()
		.execute();
	if (await heldByRun(tx, plan.appId))
		throw new Error(
			`A run or an unsettled reservation still holds app ${plan.appId}. Run the repair again once it is free.`,
		);
	const forms = plan.formUuids.length;
	const batchId = `${TASK}:${canonicalJsonDigest(plan)}`;
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
			throw new Error(
				`App ${plan.appId} holds a change under this repair's batch id that this plan did not write.`,
			);
		const seq = safePersistedSequence(receipt.seq);
		await loadCanonicalBlueprintAtSequence(tx, {
			appId: plan.appId,
			seq,
			expectedDigest: plan.targetDigest,
		});
		return { appId: plan.appId, status: "already-applied", forms, seq };
	}
	const { target } = reviewedRepair(
		plan,
		safePersistedSequence(
			app.mutation_seq,
			`apps.mutation_seq for app ${plan.appId}`,
		),
		await loadPersistedBlueprintInTransaction(tx, plan.appId),
	);
	const result = await appendSyntheticBatchInTransaction(tx, {
		appId: plan.appId,
		expectedBaseSeq: plan.expectedBaseSeq,
		targetDoc: target,
		batchId,
		authority: { kind: "system", actorId: ACTOR, reason: REASON },
	});
	await loadCanonicalBlueprintAtSequence(tx, {
		appId: plan.appId,
		seq: result.seq,
		expectedDigest: plan.targetDigest,
	});
	return { appId: plan.appId, status: "migrated", forms, seq: result.seq };
}

/**
 * Write one reviewed entry as a `blueprint-migration` change, through the
 * synthetic commit path and its gate. The app must still hold the entry's
 * sequence and digest and no run may hold it; a rerun finds its receipt and
 * verifies it. A target the gate refuses is reported with its finding codes
 * and nothing is written.
 */
export async function migrateSeveralCaseClosePlaces(
	plan: SeveralCaseClosePlaceRepair,
): Promise<SeveralCaseClosePlaceOutcome> {
	try {
		return await withAppTx((tx) => migrateInTransaction(tx, plan));
	} catch (error) {
		if (!(error instanceof BlueprintCommitRejectedError)) throw error;
		return {
			appId: plan.appId,
			status: "refused",
			forms: plan.formUuids.length,
			findingCodes: error.findingCodes,
		};
	}
}
