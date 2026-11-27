import "server-only";

import { createHmac } from "node:crypto";
import {
	AppAccessError,
	resolveAppScopeInTransaction,
} from "@/lib/db/appAccess";
import { withAppTx } from "@/lib/db/pg";
import {
	initializeWebActivityRestore,
	recordWebFormActivity,
} from "@/lib/db/previewWebActivity";
import type { BlueprintDoc } from "@/lib/domain";
import { formContentUuid } from "@/lib/domain/formEntryCases";
import { effectiveAppLocalization } from "@/lib/domain/localization";
import {
	type WebFormActivityEntry,
	webFormActivityWindow,
} from "@/lib/domain/webFormActivity";
import { previewPlatformRules } from "../platform";
import type { EntrySessionData } from "./entrySessionData";
import { evaluateAuthorizedFormOpeningSnapshot } from "./evaluateFormSnapshot";
import type { FormOpeningAudience } from "./formOpeningSnapshot";
import type { ResolvedPreviewIdentity } from "./identity";
import type { PreviewLookupData } from "./lookupEvaluation";
import { previewAppLanguage } from "./previewDevice";
import type { CaseDatabaseSnapshot } from "./xpathInstances";

/** Formplayer computes volatility before a worker answers the form and
 * keeps that key on submission. A shadow uses its ordinary form's namespace. */
export async function evaluateFormOpeningActions(input: {
	readonly secret: string;
	readonly doc: BlueprintDoc;
	readonly audience: FormOpeningAudience;
	readonly identity: ResolvedPreviewIdentity;
	readonly reached: EntrySessionData;
	readonly caseIds: readonly string[];
	readonly cases: CaseDatabaseSnapshot;
	readonly lookup: PreviewLookupData;
}): Promise<
	| {
			readonly activity?: WebFormActivityEntry;
			readonly caseCreateIds?: Readonly<Record<string, string>>;
	  }
	| undefined
> {
	const { audience, doc, reached, identity } = input;
	const content = formContentUuid(doc, audience.form);
	const language = effectiveAppLocalization(
		doc.localization,
	).languageOrder.find(
		(tag) =>
			previewAppLanguage(doc.localization, tag) === audience.device.appLanguage,
	);
	const form = doc.forms[content];
	const includeActivity =
		previewPlatformRules(audience.device.platform).recentFormActivity &&
		form?.activityKeyText !== undefined;
	const exactRoot = form?.caseOperations?.some(
		(operation) =>
			operation.action === "create" &&
			operation.forEach === undefined &&
			operation.target.kind === "new" &&
			operation.target.expr !== undefined,
	);
	if (!includeActivity && !exactRoot) return undefined;
	const { activity, caseCreateIds } =
		await evaluateAuthorizedFormOpeningSnapshot(
			doc,
			{
				formUuid: audience.form,
				caseIds: input.caseIds,
				answers: [],
				language,
			},
			{
				identity,
				device: audience.device,
				cases: input.cases,
				lookup: input.lookup,
				searchResults: reached.searchResults,
			},
			{ entryKey: audience.entry, session: reached, includeActivity },
		);
	if (!activity) return { caseCreateIds };
	const windowSeconds = webFormActivityWindow(activity.window);
	if (windowSeconds <= 0) throw new InvalidWebActivityWindowError();
	const digest = createHmac("sha256", input.secret)
		.update(
			JSON.stringify([
				"nova:web-form-activity:v1",
				audience.project,
				audience.app,
				content,
				activity.key,
			]),
		)
		.digest("hex");
	return {
		caseCreateIds,
		activity: {
			digest,
			workerName: (identity.session.context.username ?? identity.ownerId).split(
				"@",
			)[0],
			title:
				activity.title !== null && Buffer.byteLength(activity.title) <= 4096
					? activity.title
					: null,
			caseIds: [
				...new Set([...input.caseIds, ...reached.reachedCaseIds.values()]),
			],
			windowSeconds,
		},
	};
}

export class InvalidWebActivityWindowError extends Error {
	constructor() {
		super("The activity notice needs a time window greater than zero seconds.");
	}
}

/** A complete, current opening is the only event the notice store accepts
 * from the open action. Its authorized device snapshot gates prior titles. */
export async function recordWebActivityOpening(
	audience: FormOpeningAudience,
	entry: WebFormActivityEntry,
	cases: CaseDatabaseSnapshot,
	restoreStartedAt: number,
) {
	const result = await withAppTx(async (tx) => {
		const current = await resolveAppScopeInTransaction(
			tx,
			audience.app,
			audience.actor,
		);
		if (
			current.projectId !== audience.project ||
			current.baseSeq !== audience.revision
		)
			throw new AppAccessError("not_found");
		const scope = {
			appId: audience.app,
			projectId: audience.project,
			actorId: audience.actor,
			workerId: audience.worker,
		};
		await initializeWebActivityRestore(tx, scope, new Date(restoreStartedAt));
		return recordWebFormActivity(tx, scope, audience.entry, entry, "opened");
	});
	if (!result) return undefined;
	const present = new Set(cases.rows.map((row) => row.case_id));
	return result.caseIds.every((id) => present.has(id))
		? result.notice
		: undefined;
}
