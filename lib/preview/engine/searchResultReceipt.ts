import "server-only";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import type { QueryExecutorProvider } from "kysely";
import { z } from "zod";
import { lockCurrentProjectGrant } from "@/lib/auth/dataGrant";
import { CaseSearchUnavailableError } from "@/lib/case-store/searchRequest";
import {
	AppAccessError,
	resolveAppScopeInTransaction,
} from "@/lib/db/appAccess";
import {
	getFormOpeningData,
	type OpeningDataKey,
	putFormOpeningData,
} from "@/lib/db/formOpeningData";
import { withAppTx } from "@/lib/db/pg";
import { previewSearchCatalogIn } from "@/lib/deployment/previewSearchSettings";
import type { Uuid } from "@/lib/domain/uuid";
import {
	previewSearchTargetKey,
	resolvePreviewSearchFacts,
} from "@/lib/preview/searchSettings";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import type { AuthorizedPreviewContext } from "./previewAuthorization";
import type { SearchResultsSnapshot } from "./xpathInstances";

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const submissionKey = z.uuid();
const digestKey = z.string().regex(/^[a-f0-9]{64}$/);

type Context = Extract<AuthorizedPreviewContext, { kind: "ready" }>;

interface SearchReceiptScope {
	readonly appId: string;
	readonly moduleUuid: string;
	readonly caseType: string;
	readonly submission: string;
}

/** The visible prompt identities this Search actually offered and their
 * submitted values. Null is an offered but unanswered optional prompt. */
export interface SearchResultDetailAnswer {
	readonly inputUuid: Uuid;
	readonly answer: string | null;
}

/** Only a case actually offered for selection by this response can reopen
 * its Details. The primary roster includes matches the device filtered out. */
export interface SearchResultDetailFrame {
	readonly visibleCaseIds: readonly string[];
	readonly answers: readonly SearchResultDetailAnswer[];
}

type ReceiptKind = "form" | "detail";

async function withCurrentAudience<T>(
	scope: SearchReceiptScope,
	context: Context,
	read: (
		key: Omit<OpeningDataKey, "contentDigest">,
		tx: QueryExecutorProvider,
	) => T | Promise<T>,
	kind: ReceiptKind,
): Promise<T | undefined> {
	const { appId, moduleUuid, caseType, submission } = scope;
	const { device, identity, sessionId } = context;
	const { projectId } = context.scope;
	if (!sessionId || !submissionKey.safeParse(submission).success) return;
	return withAppTx(
		async (tx) => {
			const access = await resolveAppScopeInTransaction(
				tx,
				appId,
				identity.actorUserId,
				"view",
			);
			if (access.projectId !== projectId) throw new AppAccessError("not_found");
			if (
				kind === "detail" &&
				(await lockCurrentProjectGrant(
					tx,
					identity.actorUserId,
					{ kind: "session", sessionId },
					[],
				)) === null
			)
				return;
			const selection = device.searchConfiguration;
			const catalog = await previewSearchCatalogIn(tx, { appId, projectId });
			const facts = resolvePreviewSearchFacts(catalog, selection?.target);
			const targetKey =
				selection?.target && previewSearchTargetKey(selection.target);
			if (
				(selection && selection.revision !== facts.revision) ||
				(targetKey &&
					!catalog.profiles.some(
						({ target }) => previewSearchTargetKey(target) === targetKey,
					))
			)
				throw new CaseSearchUnavailableError({
					kind: "search-settings-changed",
				});
			return read(
				{
					audienceDigest: canonicalJsonDigest([
						kind === "detail"
							? "nova.preview.search.detail.v1"
							: "nova.preview.search.response.v1",
						appId,
						projectId,
						identity.actorUserId,
						identity.ownerId,
						identity.personaUuid ?? null,
						sessionId,
						device.platform,
						device.androidDeviceId,
						device.appLanguage,
						facts.revision,
						moduleUuid,
						caseType,
						submission,
					]),
					app: appId,
					project: projectId,
					session: sessionId,
				},
				tx,
			);
		},
		{ isolationLevel: "repeatable read" },
	);
}

function bytesDigest(bytes: Buffer) {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Recent Search responses use the same server-owned storage and expiry as
 * large form openings. Only the scoped content digest leaves the server. */
export async function keepSearchResult(
	scope: SearchReceiptScope,
	context: Context,
	instance: SearchResultsSnapshot,
): Promise<string> {
	return keepSearchResponse(scope, context, instance, "form");
}

/** A result Detail keeps only the offered case IDs and the referenced prompts. */
export async function keepSearchResultDetail(
	scope: SearchReceiptScope,
	context: Context,
	frame: SearchResultDetailFrame,
): Promise<string> {
	return keepSearchResponse(scope, context, frame, "detail");
}

async function keepSearchResponse(
	scope: SearchReceiptScope,
	context: Context,
	value: SearchResultsSnapshot | SearchResultDetailFrame,
	kind: ReceiptKind,
): Promise<string> {
	const key = await withCurrentAudience(
		scope,
		context,
		(current) => current,
		kind,
	);
	if (key === undefined) throw new Error("Search response scope is missing.");
	const bytes = await compress(JSON.stringify(value));
	const contentDigest = bytesDigest(bytes);
	await putFormOpeningData({ ...key, contentDigest }, bytes);
	return contentDigest;
}

export async function readKeptSearchResult(
	scope: SearchReceiptScope,
	context: Context,
	receipt: string | undefined,
): Promise<SearchResultsSnapshot | undefined> {
	return (await readKeptSearchResponse(scope, context, receipt, "form")) as
		| SearchResultsSnapshot
		| undefined;
}

/** Open only the prompt and primary result named by the originating response.
 * A direct case lookup, an old rows-only receipt and an unoffered prompt hold
 * no such read. */
export async function readKeptSearchResultDetail(
	scope: SearchReceiptScope,
	context: Context,
	receipt: string | undefined,
	caseId: string,
	inputUuid: Uuid,
): Promise<{ readonly answer: string | null } | undefined> {
	const answers = await readKeptSearchResultDetails(
		scope,
		context,
		receipt,
		caseId,
	);
	const offered = answers?.find((row) => row.inputUuid === inputUuid);
	return offered === undefined ? undefined : { answer: offered.answer };
}

/** One authenticated read for all the prompts a selected Detail uses. */
export async function readKeptSearchResultDetails(
	scope: SearchReceiptScope,
	context: Context,
	receipt: string | undefined,
	caseId: string,
): Promise<readonly SearchResultDetailAnswer[] | undefined> {
	const frame = (await readKeptSearchResponse(
		scope,
		context,
		receipt,
		"detail",
	)) as SearchResultDetailFrame | undefined;
	return frame?.visibleCaseIds.includes(caseId) ? frame.answers : undefined;
}

async function readKeptSearchResponse(
	scope: SearchReceiptScope,
	context: Context,
	receipt: string | undefined,
	kind: ReceiptKind,
): Promise<unknown> {
	const parsed = digestKey.safeParse(receipt);
	if (!parsed.success) return;
	const bytes = await withCurrentAudience(
		scope,
		context,
		(key, tx) => getFormOpeningData({ ...key, contentDigest: parsed.data }, tx),
		kind,
	);
	if (bytes === undefined || bytesDigest(bytes) !== parsed.data) return;
	return JSON.parse((await decompress(bytes)).toString("utf8"));
}
