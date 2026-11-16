import "server-only";

/**
 * One create of an app brought in from CommCare HQ: the app is read and
 * checked again exactly as a read does, goes on only where the digest is the
 * one the person reviewed and their answers are ones that review offers,
 * publishes the app's files to the Project, checks once more over exactly
 * what will be born, and creates the app, its tables, its places, its
 * adopted deployment and its claim in one transaction.
 *
 * Nothing the client sends is trusted to say what CommCare HQ holds, and
 * nothing is added to the Project until the create knows it will create.
 * Before any answer but `created` it looks for this reading's app once more,
 * so a create that overlaps another create of the same reading answers that
 * app wherever the other committed. No log line holds a word of the app.
 */

import { randomUUID } from "node:crypto";
import { mintingResolver } from "@/lib/commcare/reader/identity";
import { AppAccessError } from "@/lib/db/appAccess";
import {
	GenesisGateRejectedError,
	prepareGenesisCandidate,
} from "@/lib/db/appGenesis";
import {
	BlueprintCommitRejectedError,
	CommitReauthError,
} from "@/lib/db/commitGuard";
import { HqAppAlreadyClaimedError } from "@/lib/db/hqAppClaims";
import { loadAssetsByIds } from "@/lib/db/mediaAssets";
import { getAppDb, withAppTx } from "@/lib/db/pg";
import type { Mutation } from "@/lib/doc/types";
import type { MediaAssetId } from "@/lib/domain/multimedia";
import { log } from "@/lib/logger";
import { LookupError } from "@/lib/lookup/errors";
import { MediaPublishPermissionError } from "@/lib/media/publishReadyMedia";
import {
	type CircumstanceFinding,
	circumstanceFinding,
	type ReadCircumstance,
} from "@/lib/publish/hqFindings";
import { readHqAppClaims } from "../store";
import { broughtInAppId } from "./appId";
import {
	adoptedAppReceipt,
	adoptedDeploymentWrite,
	adoptHqAppInTransaction,
	readBackAdoptedAppReceipt,
} from "./birth";
import {
	checkFetched,
	type Gathered,
	type GatherFacts,
	gatherReading,
	KEY_IN_ANOTHER_PROJECT,
} from "./gather";
import {
	type ReaderProjectDataReads,
	type ReadingProjectData,
	readingProjectDataWrite,
	resolveTableChoices,
	underTableChoices,
} from "./projectData";
import { BroughtInTableChangedError } from "./projectData/lookupTableStore";
import { publishKeptReadingMedia } from "./projectData/mediaStore";
import type { BringInActor } from "./read";
import type {
	BringInInput,
	CreateAnswer,
	ReadingAnswer,
	ReadingEvent,
	ReadingKey,
	ReadingRefusal,
} from "./types";

// ---------------------------------------------------------------------------
// Developer messages (thrown or logged; none holds a word of an app)
// ---------------------------------------------------------------------------

function formWithNoRealId(appId: string): string {
	return `The reading ${appId} holds a form that has no real CommCare HQ id. A reading with a menu CommCare HQ could not summarize should have ended as an account. Look at gather.ts, step 4.`;
}

function bindingsMoved(appId: string, count: number): string {
	return `The reading ${appId} bound ${count} of its lookup tables one way before the person answered and another way after. No answer the review offers may move a binding the reader read. Look at lib/deployment/reading/projectData/lookupTables.ts::resolveLookupBindings.`;
}

function lookupWriteRefused(appId: string, code: string): string {
	return `The reading ${appId} could not write its lookup tables at the birth: the lookup store refused the write with ${code}. The review passed a table, or offered an answer for one, that the birth cannot keep. Look at lib/deployment/reading/projectData/lookupTables.ts::lookupTableStanding.`;
}

// ---------------------------------------------------------------------------
// The bindings under the person's answers
// ---------------------------------------------------------------------------

type GatheredTables = ReadingProjectData["gathered"]["tables"];

/**
 * How many `choice` tags hold, under the answers, another table id than as
 * read, or another column for a field the reader read. A column of a field
 * the reader did not read is not compared. 0 where no answer moved a
 * binding. Pure.
 */
export function movedBindingCount(
	read: GatheredTables,
	answered: GatheredTables,
	lookupFields: ReaderProjectDataReads["lookupFields"],
): number {
	const answeredByTag = new Map(
		answered.map((table) => [table.read.table.tag, table]),
	);
	let moved = 0;
	for (const table of read) {
		if (table.standing?.kind !== "choice") continue;
		const tag = table.read.table.tag;
		const before = table.binding;
		const after = answeredByTag.get(tag)?.binding ?? null;
		if (before === null || after === null) {
			if (before !== after) moved += 1;
			continue;
		}
		if (before.tableId !== after.tableId) {
			moved += 1;
			continue;
		}
		const fields = Object.hasOwn(lookupFields, tag)
			? (lookupFields[tag] ?? [])
			: [];
		const columnOf = (
			columns: typeof before.columns,
			field: string,
		): string | undefined =>
			Object.hasOwn(columns, field) ? columns[field] : undefined;
		if (
			fields.some(
				(field) =>
					columnOf(before.columns, field) !== columnOf(after.columns, field),
			)
		)
			moved += 1;
	}
	return moved;
}

// ---------------------------------------------------------------------------
// The create
// ---------------------------------------------------------------------------

/** A stop that is a fact about the HQ app: a create answers it `changed`, never `held`. */
const FACTS_ABOUT_THE_APP: ReadonlySet<string> = new Set<ReadCircumstance>([
	"app-gone",
	"app-deleted",
	"linked-app",
	"remote-app",
	"already-in-nova",
]);

/** The checks of the birth whose refusal is Nova's own defect. */
type BirthCheck = "gate" | "export" | "integrity" | "identity" | "bindings";

const NO_FACTS: GatherFacts = {
	sourceBytes: null,
	checkMs: 0,
	longestPieceMs: 0,
	mediaTotal: 0,
	expressionRounds: null,
};

/** Whether a Postgres error is a primary-key conflict on `apps`. */
function isAppIdConflict(error: unknown): boolean {
	const candidate = error as { code?: unknown; constraint?: unknown } | null;
	return candidate?.code === "23505" && candidate.constraint === "apps_pkey";
}

/** Each held file the plan published, by the asset it became. */
function publishedAssetIds(gathered: Gathered): readonly MediaAssetId[] {
	return [...new Set(Object.values(gathered.media.published))];
}

/** How many held files a plan has: the ones a create publishes. */
function heldFileCount(gathered: Gathered): number {
	const { media } = gathered;
	return media.files.filter(
		(file) =>
			Object.hasOwn(media.verdicts, file.key) &&
			media.verdicts[file.key]?.kind === "held",
	).length;
}

/** One create. It takes no `cancel`: once asked, it runs to its end. */
export async function createFromReview(
	actor: BringInActor,
	input: BringInInput,
	options: { readonly onEvent: (event: ReadingEvent) => void },
): Promise<CreateAnswer> {
	if (input.projectId !== actor.projectId)
		throw new Error(KEY_IN_ANOTHER_PROJECT);
	const started = performance.now();
	const { onEvent } = options;
	const key: ReadingKey = {
		projectId: input.projectId,
		server: input.server,
		domain: input.domain,
		remoteAppId: input.remoteAppId,
	};

	/* 1. The app's id. */
	const appId = broughtInAppId(actor.userId, key, input.readingId);
	const identity = {
		appId,
		projectId: key.projectId,
		userId: actor.userId,
		operation: "create",
	};
	let facts = NO_FACTS;

	const answered = (answer: CreateAnswer): CreateAnswer => {
		const stop = stopOf(answer);
		if (stop !== null)
			log.warn("[reading] stopped", { ...identity, phase: stop.code });
		log.info("[reading] answered", {
			...identity,
			phase: answer.kind,
			elapsedMs: Math.round(performance.now() - started),
			checkMs: Math.round(facts.checkMs),
			longestPieceMs: Math.round(facts.longestPieceMs),
			sourceBytes: facts.sourceBytes,
			mediaTotal: facts.mediaTotal,
			...(answer.kind === "changed" &&
				answer.now.kind === "account" && {
					findingCount: answer.now.findings.length + answer.now.more,
					codeCount: new Set(answer.now.findings.map((one) => one.code)).size,
					notYet: answer.now.counts.notYet,
					never: answer.now.counts.never,
					fixInHq: answer.now.counts.fixInHq,
				}),
			...(facts.expressionRounds !== null && {
				expressionRounds: facts.expressionRounds,
			}),
		});
		return answer;
	};

	/** The app this reading created, read back: `created`, or `app_unavailable` where the person
	 *  can no longer open it. */
	const readBack = async (): Promise<CreateAnswer> => {
		try {
			return {
				kind: "created",
				receipt: await readBackAdoptedAppReceipt(appId, key, actor.userId),
			};
		} catch (error) {
			if (error instanceof AppAccessError)
				return { kind: "refused", refusal: "app_unavailable" };
			throw error;
		}
	};

	/** 10. Before any answer but `created`, one more look for this reading's app. */
	const settle = async (
		answer: Exclude<CreateAnswer, { kind: "created" }>,
	): Promise<CreateAnswer> =>
		answered((await appRowExists(appId)) ? await readBack() : answer);

	const refused = (refusal: ReadingRefusal) =>
		settle({ kind: "refused", refusal });

	const checkFailed = (
		check: BirthCheck,
		findingCodes: readonly string[],
		why?: string,
	) => {
		log.error(`[reading] could not create: ${check}`, undefined, {
			...identity,
			phase: check,
			findingCodes,
			...(why !== undefined && { why }),
		});
		return settle({
			kind: "check-failed",
			finding: circumstanceFinding(
				"read-back-differs",
				{ kind: "app" },
				{ name: `birth-${check}` },
			),
		});
	};

	/* 2. Has this create already happened? */
	if (await appRowExists(appId)) return answered(await readBack());

	/* 3. The name. */
	const appName = input.appName.trim();
	if (appName.length < 1 || appName.length > 255)
		return refused("name_missing");

	/* 4. The read, again, keeping the bytes of each held file. */
	const gathering = await gatherReading({
		actor,
		key,
		readingId: input.readingId,
		appId,
		keepMedia: true,
		onEvent,
	});
	facts = gathering.facts;
	const { result } = gathering;

	/* 5. By its result. */
	if (result.kind === "stop")
		return settle(
			FACTS_ABOUT_THE_APP.has(result.finding.code)
				? { kind: "changed", now: result }
				: { kind: "held", finding: result.finding },
		);
	if (result.kind === "account")
		return settle({ kind: "changed", now: result.account });
	const gathered = result.gathered;
	if (gathered.reviewDigest !== input.reviewDigest)
		return settle({
			kind: "changed",
			now: {
				kind: "review",
				readingId: input.readingId,
				reviewDigest: gathered.reviewDigest,
				review: gathered.review,
			},
		});

	/* 6. The person's answers, against the fresh review. */
	const { review } = gathered;
	if (
		!review.runsOn.some(
			(choice) =>
				choice.runsOnlyOn === input.runsOnlyOn &&
				choice.splitDatetime === input.splitDatetime,
		)
	)
		return refused("choice_not_offered");
	const tableChoices = resolveTableChoices(review.tables, input.tableChoices);
	if (!tableChoices.ok)
		return refused(
			tableChoices.unknown.length > 0 || tableChoices.notOffered.length > 0
				? "choice_not_offered"
				: "choice_missing",
		);
	const answeredData = underTableChoices(
		gathered.fetched.data,
		tableChoices.choices,
	);
	const moved = movedBindingCount(
		gathered.fetched.data.gathered.tables,
		answeredData.gathered.tables,
		gathered.reads.lookupFields,
	);
	if (moved > 0)
		return checkFailed("bindings", [], bindingsMoved(appId, moved));

	/* 7. Publish. */
	let plan = gathered.media;
	const held = heldFileCount(gathered);
	if (held > 0) {
		onEvent({ type: "stage", stage: "bringing-in-media" });
		onEvent({ type: "files", done: 0, total: held });
		try {
			plan = await publishKeptReadingMedia({
				projectId: key.projectId,
				actorUserId: actor.userId,
				plan,
				onProgress: (done, total) => onEvent({ type: "files", done, total }),
			});
		} catch (error) {
			if (error instanceof MediaPublishPermissionError)
				return refused("no_project_access");
			throw error;
		}
	}

	/* 8. The check once more, over exactly what will be born. */
	onEvent({ type: "stage", stage: "creating" });
	const keepsProjectTable = Object.values(tableChoices.choices).includes(
		"use-project",
	);
	let born: Gathered = {
		...gathered,
		fetched: { ...gathered.fetched, data: answeredData },
		media: plan,
	};
	if (gathered.media.files.length > 0 || keepsProjectTable) {
		const checked = await checkFetched({
			appId,
			key,
			fetched: { ...gathered.fetched, data: answeredData },
			media: plan,
			actorUserId: actor.userId,
		});
		facts = {
			...facts,
			checkMs: facts.checkMs + checked.facts.checkMs,
			longestPieceMs: Math.max(
				facts.longestPieceMs,
				checked.facts.longestPieceMs,
			),
		};
		if (
			checked.result.kind !== "clean" ||
			checked.result.gathered.reviewDigest !== input.reviewDigest
		)
			return checkFailed("integrity", []);
		born = checked.result.gathered;
	}

	/* 9. The birth. */
	const chosen = born.accepted.declarations.find(
		(declaration) =>
			declaration.runsOnlyOn === input.runsOnlyOn &&
			declaration.splitDatetime === input.splitDatetime,
	);
	if (chosen === undefined) return checkFailed("integrity", []);
	const batch: Mutation[] = [...born.draft.batch, ...chosen.mutations];
	if (appName !== born.draft.doc.appName)
		batch.push({ kind: "setAppName", name: appName });
	const candidate = prepareGenesisCandidate({
		appId,
		projectId: key.projectId,
		mutations: batch,
	});
	const deployment = adoptedDeploymentWrite({
		appId,
		key,
		actorUserId: actor.userId,
		gathered: born,
		chosen,
		candidate,
	});
	if (!deployment.ok)
		return checkFailed("identity", [], formWithNoRealId(appId));
	const projectData = readingProjectDataWrite(
		born.fetched.data,
		born.reads,
		born.draft.doc,
		mintingResolver(appId),
	);
	const runId = randomUUID();
	const at = new Date();
	const birthStarted = performance.now();
	let outcome: Awaited<ReturnType<typeof adoptHqAppInTransaction>>;
	try {
		outcome = await withAppTx((tx) =>
			adoptHqAppInTransaction(tx, {
				actorUserId: actor.userId,
				runId,
				candidate,
				hqApp: {
					server: key.server,
					domain: key.domain,
					remoteAppId: key.remoteAppId,
				},
				projectData,
				deployment: deployment.write,
				at,
			}),
		);
	} catch (error) {
		if (isAppIdConflict(error)) return answered(await readBack());
		if (error instanceof HqAppAlreadyClaimedError)
			return settle({ kind: "changed", now: await claimedNow(actor, key) });
		if (
			error instanceof BroughtInTableChangedError ||
			(error instanceof LookupError &&
				(error.code === "tag_taken" || error.code === "conflict"))
		)
			return settle({ kind: "read-again" });
		/* Every other refusal of the lookup store names a table by its tag, so it is answered
		 * here, logged by its code alone, and never reaches the route's failed line. */
		if (error instanceof LookupError)
			return checkFailed(
				"integrity",
				[],
				lookupWriteRefused(appId, error.code),
			);
		if (error instanceof CommitReauthError) return refused("no_project_access");
		/* Export readiness and the tail's media admission each refuse a file that left the
		 * Project's library, and neither error says so: ask whether every published file is
		 * still there. */
		if (
			(error instanceof GenesisGateRejectedError && error.check === "export") ||
			error instanceof BlueprintCommitRejectedError
		) {
			const published = publishedAssetIds(born);
			const ready = (await loadAssetsByIds(published, key.projectId)).filter(
				(asset) => asset.status === "ready",
			);
			if (ready.length < published.length) return refused("project_changed");
		}
		if (error instanceof GenesisGateRejectedError)
			return checkFailed(error.check, error.findingCodes);
		if (error instanceof BlueprintCommitRejectedError)
			return checkFailed("integrity", error.findingCodes);
		throw error;
	}
	if (outcome.kind === "replay") return answered(await readBack());
	log.info("[reading] created", {
		...identity,
		elapsedMs: Math.round(performance.now() - birthStarted),
		tables: projectData.tables.length,
		places: projectData.places?.places.length ?? 0,
		mediaFiles: new Set(born.mediaFiles.map((file) => file.assetId)).size,
		identityRows: deployment.write.identities.length,
	});
	return answered({
		kind: "created",
		receipt: adoptedAppReceipt(candidate, key, outcome.role),
	});
}

/** Whether `apps` holds a row of this id, deleted or not. */
async function appRowExists(appId: string): Promise<boolean> {
	const db = await getAppDb();
	const row = await db
		.selectFrom("apps")
		.select("id")
		.where("id", "=", appId)
		.executeTakeFirst();
	return row !== undefined;
}

/** The stop `already-in-nova` as it stands now, its holder from a fresh read of the claims. */
async function claimedNow(
	actor: BringInActor,
	key: ReadingKey,
): Promise<Extract<ReadingAnswer, { kind: "stop" }>> {
	const [holder] = await readHqAppClaims({
		viewerUserId: actor.userId,
		server: key.server,
		domain: key.domain,
		remoteAppIds: [key.remoteAppId],
	});
	const detail =
		holder === undefined
			? {}
			: (({ remoteAppId: _remoteAppId, ...claim }) => ({ claim }))(holder);
	return {
		kind: "stop",
		finding: circumstanceFinding("already-in-nova", { kind: "app" }, detail),
	};
}

/** The circumstance an answer stops at, where it carries one. */
function stopOf(answer: CreateAnswer): CircumstanceFinding | null {
	if (answer.kind === "held") return answer.finding;
	if (answer.kind === "changed" && answer.now.kind === "stop")
		return answer.now.finding;
	return null;
}
