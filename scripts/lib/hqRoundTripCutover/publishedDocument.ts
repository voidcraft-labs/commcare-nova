/**
 * The document a deployment was last published from.
 *
 * A deployment's live `app` mapping holds `pushed_revision`, the app sequence
 * its last recorded publish was compiled at. Every committed document change
 * appends an `app_changes` row and moves `apps.mutation_seq` to its sequence,
 * so the document at that sequence is exactly what that publish sent:
 *
 *   - at the app's present sequence, it is the stored document itself, and
 *     nothing is folded;
 *   - below it, and at or above the app's greatest fold baseline, it is that
 *     baseline's snapshot with every later row through `pushed_revision`
 *     reduced in order, by the frozen pre-step fold (`./prestep/`), because
 *     the rows are in the pre-step dialect that only the reducer that wrote
 *     them can replay. The fold is run on to the app's head as well, and a
 *     fold that does not end at the stored document is not trusted at the
 *     earlier sequence either;
 *   - below the greatest baseline it is nothing: rows behind a fold horizon
 *     are opaque audit history, so no earlier baseline is read.
 */

import { sql, type Transaction } from "kysely";
import type { AppDatabase } from "@/lib/db/pg";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";
import {
	type Json,
	type JsonRecord,
	RAW_FLAT_COLLECTIONS,
	type RawDocument,
	rawDocumentDigest,
} from "./oldShape";
import {
	foldCanonicalAppChangeSuffixBounded,
	type PrestepFoldSuffixRow,
} from "./prestep/prestepFold.generated.mjs";

export type PublishedDocumentGap =
	| "before-horizon"
	| "fold-refused"
	| "fold-diverges";

export type PublishedDocument =
	| {
			readonly kind: "document";
			readonly source: "stored" | "folded";
			readonly document: RawDocument;
	  }
	| { readonly kind: "none"; readonly reason: PublishedDocumentGap };

function record(value: unknown): Record<string, JsonRecord> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, JsonRecord>)
		: {};
}

function list(value: unknown): readonly string[] {
	return Array.isArray(value) ? (value as string[]) : [];
}

/**
 * A folded pre-step snapshot as a `RawDocument`: the persistable document's
 * own keys, with the slots the stored carriers spell as absent spelled the
 * same way (`localization` and `logo` as null, a flat collection as empty).
 */
export function rawDocumentFromSnapshot(snapshot: unknown): RawDocument {
	const doc = snapshot as Readonly<Record<string, unknown>>;
	const flat = Object.fromEntries(
		RAW_FLAT_COLLECTIONS.flatMap(([, slot, orderSlot]) => [
			[slot, record(doc[slot])],
			[orderSlot, list(doc[orderSlot])],
		]),
	);
	return {
		appName: doc.appName as string,
		connectType: (doc.connectType ?? null) as string | null,
		caseTypes: (doc.caseTypes ?? null) as Json,
		localization: (doc.localization ?? null) as Json,
		logo: (doc.logo ?? null) as string | null,
		...(doc.appSettings !== undefined && {
			appSettings: doc.appSettings as JsonRecord,
		}),
		modules: record(doc.modules),
		forms: record(doc.forms),
		fields: record(doc.fields),
		moduleOrder: list(doc.moduleOrder),
		formOrder: doc.formOrder as RawDocument["formOrder"],
		fieldOrder: doc.fieldOrder as RawDocument["fieldOrder"],
		...flat,
	} as RawDocument;
}

/**
 * The document one deployment was last published from, read lock-free on the
 * plan's transaction: fold baselines and the rows at or below the app's
 * sequence are immutable.
 */
export async function readPublishedDocument(
	tx: Transaction<AppDatabase>,
	args: {
		readonly appId: string;
		/** The live `app` mapping's `pushed_revision`. */
		readonly pushedRevision: number;
		/** The app's `mutation_seq` as the plan read it. */
		readonly baseSeq: number;
		/** The stored document as the plan read it. */
		readonly stored: RawDocument;
	},
): Promise<PublishedDocument> {
	if (args.pushedRevision === args.baseSeq) {
		return { kind: "document", source: "stored", document: args.stored };
	}
	const baseline = await tx
		.selectFrom("app_change_fold_baselines")
		.select(["seq", "project_id"])
		.select(
			sql<string>`${sql.ref("app_change_fold_baselines.snapshot")}::text`.as(
				"snapshot_text",
			),
		)
		.where("app_id", "=", args.appId)
		.orderBy("seq", "desc")
		.limit(1)
		.executeTakeFirst();
	if (baseline === undefined) return { kind: "none", reason: "fold-refused" };
	const baselineSeq = safePersistedSequence(
		baseline.seq,
		`app_change_fold_baselines.seq for app ${args.appId}`,
	);
	if (args.pushedRevision < baselineSeq) {
		return { kind: "none", reason: "before-horizon" };
	}
	if (args.pushedRevision > args.baseSeq) {
		return { kind: "none", reason: "fold-refused" };
	}
	const rows = await tx
		.selectFrom("app_changes")
		.select([
			"seq",
			"batch_id",
			"run_id",
			"actor_id",
			"kind",
			"from_project_id",
			"to_project_id",
		])
		.select(
			sql<string>`${sql.ref("app_changes.mutations")}::text`.as(
				"mutations_text",
			),
		)
		.where("app_id", "=", args.appId)
		.where("seq", ">", baselineSeq)
		.where("seq", "<=", args.baseSeq)
		.orderBy("seq", "asc")
		.execute();
	const suffix: PrestepFoldSuffixRow[] = rows.map((row) => ({
		seq: row.seq,
		batch_id: row.batch_id,
		run_id: row.run_id,
		actor_id: row.actor_id,
		kind: row.kind,
		mutationsText: row.mutations_text,
		from_project_id: row.from_project_id,
		to_project_id: row.to_project_id,
	}));
	const fold = (targetSeq: number) =>
		foldCanonicalAppChangeSuffixBounded({
			baselineSnapshotText: baseline.snapshot_text,
			baselineSeq,
			baselineProjectId: baseline.project_id,
			targetSeq,
			suffix: suffix.filter(
				(row) => safePersistedSequence(row.seq, "app_changes.seq") <= targetSeq,
			),
		});
	let published: RawDocument;
	let head: RawDocument;
	try {
		published = rawDocumentFromSnapshot(fold(args.pushedRevision).snapshot);
		head = rawDocumentFromSnapshot(fold(args.baseSeq).snapshot);
	} catch {
		return { kind: "none", reason: "fold-refused" };
	}
	if (rawDocumentDigest(head) !== rawDocumentDigest(args.stored)) {
		return { kind: "none", reason: "fold-diverges" };
	}
	return { kind: "document", source: "folded", document: published };
}
