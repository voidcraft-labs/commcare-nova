/**
 * ONE-OFF: the repair of an app brought in from CommCare HQ while Nova's reader folded a generated
 * key's override into the text the key's output is based on (a form's name, a menu's, a column's
 * header). Run once at the cutover that ships the reading which holds such an override as the
 * output's own wording, then remove this file, `scan-translation-folds.ts`,
 * `migrate-translation-folds.ts` and their tests.
 *
 * Every judgement reads the stored baseline with the reader Nova now runs, offline: the Project's
 * data as none (no lookup table, no place) and every file the baseline names unjudged. A reading
 * that this leaves short is not exact, so its app is named and nothing of it changes.
 *
 * A fold, for one generated output and one language: the baseline, read now, holds the output's
 * own wording there; the reference document (what the baseline described when Nova recorded it)
 * words the output's base otherwise than the baseline; and the head still words that base as the
 * reference does, so no edit in Nova made the difference. Its repair moves the wording into the
 * output and gives the base back CommCare HQ's text, so the next publish changes nothing there.
 */

import { type Kysely, sql, type Transaction } from "kysely";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import {
	knownCaseTypesOf,
	knownLanguageCodesOf,
	readHqApp,
} from "@/lib/commcare/reader";
import { matchingResolver } from "@/lib/commcare/reader/identity";
import { externalIdentityMap } from "@/lib/commcare/reader/identityMap";
import { COMMCARE_SERVERS } from "@/lib/commcare/servers";
import { targetWireIdentity } from "@/lib/commcare/wireIdentity";
import { lockActorGenerationGateForAppHolder } from "@/lib/db/actorGenerationGate";
import { appendSyntheticBatchInTransaction } from "@/lib/db/apps";
import { LEASE_COLUMNS, leaseView } from "@/lib/db/leaseView";
import { type AppDatabase, getAppDb, withAppTx } from "@/lib/db/pg";
import { designSessionLeaseState, runLeaseState } from "@/lib/db/runLiveness";
import {
	alignedFromSource,
	sourceFromBaseline,
} from "@/lib/deployment/hqChanges/baselineSource";
import { loadReferenceDocument } from "@/lib/deployment/hqChanges/reference";
import { readingAppStrings } from "@/lib/deployment/reading/appStrings";
import { readingMediaIndex } from "@/lib/deployment/reading/projectData/media";
import {
	readFoldOperatorBaseline,
	readTargetIdentityRows,
} from "@/lib/deployment/store";
import { deepEqual } from "@/lib/doc/deepEqual";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { sourceSlotWriter } from "@/lib/doc/sourceLanguage";
import type {
	BlueprintDoc,
	LanguageTag,
	TranslationEntry,
	TranslationUnitId,
} from "@/lib/domain";
import {
	editableLanguageEntries,
	effectiveAppLocalization,
	languageEntries,
} from "@/lib/domain/localization";
import {
	defaultWording,
	snapshotTranslationUnits,
} from "@/lib/domain/translationUnits";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";
import {
	loadPersistedBlueprintInTransaction,
	loadPersistedBlueprintReadOnly,
} from "./loadPersistedBlueprint";

const ACTOR = "system:translation-fold-repair";
/** The id an earlier reading listed a fold under, which no list of this release holds. */
const RETIRED_ID = "translation-overrides-folded";

/** What the repair finds of one adoption. */
export type FoldStanding =
	/** Every fold it holds moves back exactly. */
	| "unfolds"
	/** The baseline does not read whole offline: it needs data only CommCare HQ can give. */
	| "needs-hq-data"
	/** It holds no fold: CommCare HQ already holds what the head writes, a publish since
	 *  carried the fold there, or the override never folded. */
	| "nothing-to-unfold"
	/** Every fold it holds has a base an author edited in Nova since, which stays. */
	| "author-edited";

export interface AdoptionFolds {
	readonly appId: string;
	readonly deploymentId: string;
	readonly standing: FoldStanding;
	/** The outputs and languages the repair moves, `unfolds` only. */
	readonly unfolds: number;
	/** The outputs and languages whose base an author edited, which stay as they are. */
	readonly edited: number;
	/** Whether the deployment's stored list names the retired id. */
	readonly listsRetiredId: boolean;
}

interface Fold {
	readonly language: LanguageTag;
	readonly output: TranslationUnitId;
	readonly base: TranslationUnitId;
	readonly wording: TranslationEntry;
	/** The base's text CommCare HQ holds in the language: the source text in the source language,
	 *  else its translation there (undefined: none). */
	readonly baseText: unknown;
}

/** Every adoption of `appId` (each deployment whose live app mapping Nova adopted). */
async function adoptionsOf(
	db: Kysely<AppDatabase> | Transaction<AppDatabase>,
	appId: string,
) {
	return db
		.selectFrom("app_deployments as d")
		.innerJoin("app_deployment_resources as r", (join) =>
			join
				.onRef("r.deployment_id", "=", "d.id")
				.on("r.kind", "=", "app")
				.on("r.superseded_at", "is", null),
		)
		.innerJoin("app_deployment_baselines as b", "b.deployment_id", "d.id")
		.select([
			"d.id",
			"d.project_id",
			"d.server",
			"d.domain",
			"b.first_publish_changes",
		])
		.where("d.app_id", "=", appId)
		.where("r.ownership", "=", "adopted")
		.execute();
}

/** The baseline's source read now, offline, under the reference's identities. */
function readOffline(input: {
	readonly appId: string;
	readonly server: string;
	readonly domain: string;
	readonly baselineSource: unknown;
	readonly reference: BlueprintDoc;
	readonly identityDoc: BlueprintDoc;
	readonly overrides: Parameters<typeof targetWireIdentity>[0];
}): BlueprintDoc | null {
	const source = sourceFromBaseline(input.baselineSource);
	const origin =
		COMMCARE_SERVERS[input.server as keyof typeof COMMCARE_SERVERS]?.baseUrl;
	if (origin === undefined) return null;
	const outcome = readHqApp({
		appId: input.appId,
		target: { origin, domain: input.domain },
		resolver: matchingResolver(
			input.appId,
			externalIdentityMap(
				input.identityDoc,
				targetWireIdentity(input.overrides),
			),
		),
		lookup: { table: () => undefined, definitions: new Map() },
		organization: { levelCodes: [], levels: [] },
		appStrings: readingAppStrings(LOOKUP_CONTEXT_UNAVAILABLE),
		recordDialect: recordDialectRoundTrip,
		knownCaseTypes: knownCaseTypesOf(input.reference),
		knownLanguageCodes: knownLanguageCodesOf(input.reference),
		source,
		modules: alignedFromSource(source),
		media: readingMediaIndex({ source, appId: input.appId, plan: null }),
	});
	return outcome.kind === "read" ? outcome.draft.doc : null;
}

/** The folds the head holds against `read`, and the ones an author's edit of the base keeps. */
function foldsOf(
	reference: BlueprintDoc,
	read: BlueprintDoc,
	head: BlueprintDoc,
): { readonly folds: readonly Fold[]; readonly edited: number } {
	const localization = effectiveAppLocalization(read.localization);
	const readUnits = snapshotTranslationUnits(read);
	const referenceUnits = snapshotTranslationUnits(reference);
	const headUnits = snapshotTranslationUnits(head);
	const held = effectiveAppLocalization(head.localization);
	const folds: Fold[] = [];
	let edited = 0;
	for (const language of localization.languageOrder) {
		for (const [id, wording] of Object.entries(
			languageEntries(localization, language) ?? {},
		)) {
			const output = id as TranslationUnitId;
			const unit = readUnits.get(output);
			const base = unit?.generated?.base;
			const was = referenceUnits.get(output);
			const now = headUnits.get(output);
			if (
				wording === undefined ||
				unit === undefined ||
				base === undefined ||
				!was ||
				!now
			)
				continue;
			if (languageEntries(held, language)?.[output] !== undefined) continue;
			const shown = defaultWording(reference, language, was);
			if (deepEqual(shown, defaultWording(read, language, unit))) continue;
			if (!deepEqual(shown, defaultWording(head, language, now))) {
				edited += 1;
				continue;
			}
			const baseUnit = readUnits.get(base);
			folds.push({
				language,
				output,
				base,
				wording,
				baseText:
					language === localization.sourceLanguage
						? baseUnit?.source
						: languageEntries(localization, language)?.[base],
			});
		}
	}
	return { folds, edited };
}

/** `head` with each fold moved back: the wording on the output, the base at CommCare HQ's text. */
export function unfolded(
	head: BlueprintDoc,
	folds: readonly Fold[],
): BlueprintDoc {
	const draft = hydratePersistedBlueprint(
		structuredClone(toPersistableDoc(head)),
	);
	const units = snapshotTranslationUnits(head);
	const source = effectiveAppLocalization(head.localization).sourceLanguage;
	// An app of one language holds no stored root until it holds a wording.
	if (folds.length > 0 && draft.localization === undefined)
		draft.localization = structuredClone(
			effectiveAppLocalization(undefined),
		) as NonNullable<BlueprintDoc["localization"]>;
	for (const fold of folds) {
		const localization = draft.localization;
		if (localization === undefined)
			throw new Error("A fold names a language the app does not hold.");
		const outputs = editableLanguageEntries(localization, fold.language, true);
		if (outputs === undefined)
			throw new Error("A fold names a language the app does not hold.");
		outputs[fold.output] = fold.wording;
		if (fold.language === source) {
			const unit = units.get(fold.base);
			const write = unit && sourceSlotWriter(unit);
			if (write === undefined || fold.baseText === undefined)
				throw new Error("A fold's base holds no text Nova can write back.");
			write(draft, fold.baseText as never);
		} else {
			const bases = editableLanguageEntries(localization, fold.language, true);
			if (bases === undefined)
				throw new Error("A fold names a language the app does not hold.");
			if (fold.baseText === undefined) delete bases[fold.base];
			else bases[fold.base] = fold.baseText as TranslationEntry;
		}
	}
	return draft;
}

/** What the repair finds of one adoption, in one snapshot of `db`. */
async function judge(
	db: Transaction<AppDatabase>,
	appId: string,
	head: { readonly doc: BlueprintDoc; readonly seq: number },
	adoption: Awaited<ReturnType<typeof adoptionsOf>>[number],
): Promise<AdoptionFolds & { readonly folds: readonly Fold[] }> {
	const listsRetiredId =
		(
			adoption.first_publish_changes as { ids?: readonly string[] } | null
		)?.ids?.includes(RETIRED_ID) === true;
	const answer = (
		standing: FoldStanding,
		folds: readonly Fold[] = [],
		edited = 0,
	) => ({
		appId,
		deploymentId: adoption.id,
		standing,
		unfolds: folds.length,
		edited,
		listsRetiredId,
		folds,
	});
	const target = { server: adoption.server, domain: adoption.domain } as never;
	const baseline = await readFoldOperatorBaseline(
		db,
		{ appId, projectId: adoption.project_id },
		target,
		"certificates",
	);
	if (
		baseline === null ||
		baseline.origin === "unread" ||
		baseline.novaRevision === null
	)
		return answer("nothing-to-unfold");
	const reference = await loadReferenceDocument({
		db,
		appId,
		novaRevision: baseline.novaRevision,
		head,
		...(baseline.foldBinding && { binding: baseline.foldBinding }),
	});
	if (reference.kind !== "ok") return answer("needs-hq-data");
	const identity = await readTargetIdentityRows(db, adoption.id, {
		appId,
		server: adoption.server,
	});
	const read = readOffline({
		appId,
		server: adoption.server,
		domain: adoption.domain,
		baselineSource: baseline.source,
		reference: reference.doc,
		identityDoc: reference.identityDoc,
		overrides: identity.entities,
	});
	if (read === null) return answer("needs-hq-data");
	const { folds, edited } = foldsOf(reference.doc, read, head.doc);
	if (folds.length > 0) return answer("unfolds", folds, edited);
	return answer(edited > 0 ? "author-edited" : "nothing-to-unfold", [], edited);
}

/** Every adoption of `appId` and what the repair finds of it, read only. */
export async function scanTranslationFolds(
	appId: string,
): Promise<readonly AdoptionFolds[]> {
	const db = await getAppDb();
	return db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(async (tx) => {
			const adoptions = await adoptionsOf(tx, appId);
			if (adoptions.length === 0) return [];
			const app = await tx
				.selectFrom("apps")
				.select("mutation_seq")
				.where("id", "=", appId)
				.executeTakeFirstOrThrow();
			const blueprint = await loadPersistedBlueprintReadOnly(tx, appId);
			if (blueprint === null) return [];
			const head = {
				doc: hydratePersistedBlueprint(blueprint),
				seq: safePersistedSequence(app.mutation_seq),
			};
			const found: AdoptionFolds[] = [];
			for (const adoption of adoptions) {
				const { folds: _folds, ...judged } = await judge(
					tx,
					appId,
					head,
					adoption,
				);
				found.push(judged);
			}
			return found;
		});
}

/**
 * Moves back every fold of `appId`'s adoptions in one transaction, with the document's reload
 * boundary, and takes the retired id off each stored list. A dry run (`execute` false) reads and
 * answers what it would do. Running it again finds nothing: the head then holds each wording.
 */
export async function migrateTranslationFolds(
	appId: string,
	execute: boolean,
): Promise<{
	readonly appId: string;
	readonly status: "unchanged" | "would-change" | "changed";
	readonly adoptions: readonly AdoptionFolds[];
}> {
	return withAppTx(async (tx) => {
		await lockActorGenerationGateForAppHolder(tx, appId);
		const app = await tx
			.selectFrom("apps")
			.select(["mutation_seq", ...LEASE_COLUMNS])
			.where("id", "=", appId)
			.forUpdate()
			.executeTakeFirstOrThrow();
		const sessions = await tx
			.selectFrom("design_sessions")
			.selectAll()
			.where("app_id", "=", appId)
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
			throw new Error(
				`A run or an unsettled reservation still holds app ${appId}. Run the migration again once it ends.`,
			);
		const blueprint = await loadPersistedBlueprintInTransaction(tx, appId);
		if (blueprint === null) throw new Error(`App ${appId} has no document.`);
		const seq = safePersistedSequence(app.mutation_seq);
		const head = { doc: hydratePersistedBlueprint(blueprint), seq };
		const judged = [];
		for (const adoption of await adoptionsOf(tx, appId))
			judged.push(await judge(tx, appId, head, adoption));
		const adoptions = judged.map(({ folds: _folds, ...one }) => one);
		const folds = judged.flatMap((one) =>
			one.standing === "unfolds" ? one.folds : [],
		);
		const lists = judged.filter((one) => one.listsRetiredId);
		if (folds.length === 0 && lists.length === 0)
			return { appId, status: "unchanged", adoptions };
		if (!execute) return { appId, status: "would-change", adoptions };
		if (folds.length > 0) {
			const targetDoc = toPersistableDoc(unfolded(head.doc, folds));
			await appendSyntheticBatchInTransaction(tx, {
				appId,
				expectedBaseSeq: seq,
				targetDoc,
				batchId: `translation-fold-repair:${canonicalJsonDigest(targetDoc)}`,
				authority: {
					kind: "system",
					actorId: ACTOR,
					reason:
						"Moves a generated key's override that an earlier reading folded into its base back to the output's own wording.",
				},
			});
		}
		for (const one of lists)
			await sql`UPDATE app_deployment_baselines
				SET first_publish_changes = jsonb_set(
					first_publish_changes,
					'{ids}',
					(first_publish_changes -> 'ids') - ${RETIRED_ID}::text
				)
				WHERE deployment_id = ${one.deploymentId}`.execute(tx);
		return { appId, status: "changed", adoptions };
	});
}

/** Every app with a deployment whose live app mapping Nova adopted, in id order. */
export async function adoptedAppIds(): Promise<readonly string[]> {
	const db = await getAppDb();
	const rows = await db
		.selectFrom("app_deployments as d")
		.innerJoin("app_deployment_resources as r", (join) =>
			join
				.onRef("r.deployment_id", "=", "d.id")
				.on("r.kind", "=", "app")
				.on("r.superseded_at", "is", null),
		)
		.select("d.app_id")
		.distinct()
		.where("r.ownership", "=", "adopted")
		.orderBy("d.app_id")
		.execute();
	return rows.map((row) => row.app_id);
}
