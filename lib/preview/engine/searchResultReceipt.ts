import "server-only";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import type { QueryExecutorProvider } from "kysely";
import { z } from "zod";
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

async function withCurrentAudience<T>(
	scope: SearchReceiptScope,
	context: Context,
	read: (
		key: Omit<OpeningDataKey, "contentDigest">,
		tx: QueryExecutorProvider,
	) => T | Promise<T>,
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
						"nova.preview.search.response.v1",
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
	const key = await withCurrentAudience(scope, context, (current) => current);
	if (key === undefined) throw new Error("Search response scope is missing.");
	const bytes = await compress(JSON.stringify(instance));
	const contentDigest = bytesDigest(bytes);
	await putFormOpeningData({ ...key, contentDigest }, bytes);
	return contentDigest;
}

export async function readKeptSearchResult(
	scope: SearchReceiptScope,
	context: Context,
	receipt: string | undefined,
): Promise<SearchResultsSnapshot | undefined> {
	const parsed = digestKey.safeParse(receipt);
	if (!parsed.success) return;
	const bytes = await withCurrentAudience(scope, context, (key, tx) =>
		getFormOpeningData({ ...key, contentDigest: parsed.data }, tx),
	);
	if (bytes === undefined || bytesDigest(bytes) !== parsed.data) return;
	return JSON.parse(
		(await decompress(bytes)).toString("utf8"),
	) as SearchResultsSnapshot;
}
