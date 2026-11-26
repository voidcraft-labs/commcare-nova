/**
 * Acceptance's input over a reading, as the bring-in builds it: CommCare
 * HQ's retained answers for `navigation-base` (its application resource with
 * HQ's own question summary, its source and its version read, one bracketed
 * read), or any source a test serves, read by the production reader with a
 * fresh minting resolver, and the reading's project data where it has none:
 * no table, no file, no hand-off.
 */

import { withHttpPeer } from "@/__tests__/helpers/httpPeer";
import {
	type RetainedHqAnswer,
	replyRetained,
	retainedBodyJson,
	retainedGroupRead,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import type { HqAlignedModule } from "@/lib/commcare/hq/appReading";
import { readHqAppForReading } from "@/lib/commcare/hq/appReading";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import { type ReaderInput, readHqApp } from "@/lib/commcare/reader";
import { mintingResolver } from "@/lib/commcare/reader/identity";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import type {
	LookupFixtureDataSnapshot,
	LookupRevision,
} from "@/lib/lookup/types";
import type { AcceptReadingInput } from "../acceptance";
import { readingAppStrings } from "../appStrings";
import { narrowDeclarationsByMedia } from "../projectData/media";

const CREDS = { username: "account", apiKey: "key", server: "india" } as const;
export const HOST = "https://india.commcarehq.org";
export const DOMAIN = "clinic";
export const APP_ID = "acceptance-app";

/** The empty Project data of a reading that reads no table. */
export const NO_TABLES: LookupFixtureDataSnapshot = {
	projectId: "project-1",
	projectRevision: "0" as LookupRevision,
	definitions: [],
	rowsByTable: new Map(),
};

const NO_TABLES_CONTEXT: LookupValidationContext = {
	kind: "available",
	projectId: NO_TABLES.projectId,
	projectRevision: NO_TABLES.projectRevision,
	definitions: [],
};

/**
 * CommCare HQ's bracketed read of `navigation-base` after Nova's first
 * publish: its source and its menus aligned with HQ's own summary, from
 * `reading/<application>.json`, `navigation-base/app-source.json` and
 * `reading/current-version.json`. `body` changes the source HQ serves and
 * `summary` the application resource's body, each as a test doctors it.
 */
export async function navigationBaseRead(
	options: {
		readonly application?: "application" | "application-error-module";
		readonly body?: (body: Record<string, unknown>) => Record<string, unknown>;
		readonly summary?: (
			body: Record<string, unknown>,
		) => Record<string, unknown>;
	} = {},
): Promise<{
	readonly source: HqAppSource;
	readonly modules: readonly HqAlignedModule[];
}> {
	const retained = retainedReadingRead("application");
	const appId = retainedBodyJson(retained).id as string;
	const asJson = (
		answer: RetainedHqAnswer,
		change:
			| ((body: Record<string, unknown>) => Record<string, unknown>)
			| undefined,
	): RetainedHqAnswer =>
		change === undefined
			? answer
			: { ...answer, body: JSON.stringify(change(retainedBodyJson(answer))) };
	const application = retainedReadingRead(options.application ?? "application");
	const answers: readonly [string, RetainedHqAnswer][] = [
		[
			`/a/${DOMAIN}/api/application/v1/${appId}/`,
			asJson(
				{
					...application,
					body: JSON.stringify({ ...retainedBodyJson(application), id: appId }),
				},
				options.summary,
			),
		],
		[
			`/a/${DOMAIN}/apps/source/${appId}/`,
			asJson(retainedGroupRead("navigation-base/app-source"), options.body),
		],
		[
			`/a/${DOMAIN}/apps/view/${appId}/current_version/`,
			retainedReadingRead("current-version"),
		],
	];
	const reading = await withHttpPeer(async (peer) => {
		for (const [path, answer] of answers)
			replyRetained(peer.get(HOST).intercept({ path, method: "GET" }), answer);
		return readHqAppForReading(CREDS, DOMAIN, appId);
	});
	if (reading.kind !== "read")
		throw new Error(`The retained answers are no reading: ${reading.kind}`);
	return { source: reading.source, modules: reading.modules };
}

/** The reader's input of a first reading of `source`, as a bring-in reads it. */
export function readingInput(
	source: HqAppSource,
	modules: readonly HqAlignedModule[],
	overrides: Partial<ReaderInput> = {},
): ReaderInput {
	return {
		appId: APP_ID,
		target: { origin: HOST, domain: DOMAIN },
		source,
		modules,
		resolver: mintingResolver(APP_ID),
		lookup: { table: () => undefined, definitions: new Map() },
		organization: { levelCodes: [], levels: [] },
		media: { resolve: () => ({ kind: "no-entry" }) },
		appStrings: readingAppStrings(NO_TABLES_CONTEXT),
		recordDialect: recordDialectRoundTrip,
		...overrides,
	};
}

/** The reading of `reader`, which the test holds to read clean. */
export function readClean(
	reader: ReaderInput,
): Extract<ReturnType<typeof readHqApp>, { readonly kind: "read" }> {
	const outcome = readHqApp(reader);
	if (outcome.kind !== "read")
		throw new Error(
			`The source read to an account: ${outcome.findings.map((one) => `${one.code} ${one.detail.name ?? ""}`).join(", ")}`,
		);
	return outcome;
}

/**
 * Acceptance's input over a clean reading with no table, no file and no
 * hand-off: the choices the draft offers, every one of them played by the
 * files (there are none).
 */
export function acceptanceInput(
	reader: ReaderInput,
	outcome: AcceptReadingInput["outcome"],
	overrides: Partial<AcceptReadingInput> = {},
): AcceptReadingInput {
	const choices = narrowDeclarationsByMedia(outcome.draft.declaration, [
		"web-apps",
		"android",
	]);
	if (choices.kind !== "choices")
		throw new Error("The reading offers no declaration.");
	return {
		appId: reader.appId,
		target: { server: "india", domain: reader.target.domain },
		source: reader.source,
		modules: reader.modules,
		outcome,
		reader: {
			target: reader.target,
			lookup: reader.lookup,
			organization: reader.organization,
			media: reader.media,
			appStrings: reader.appStrings,
			recordDialect: reader.recordDialect,
			...(reader.saveOnlyEditedApplied !== undefined && {
				saveOnlyEditedApplied: reader.saveOnlyEditedApplied,
			}),
			...(reader.caseListActionsApplied !== undefined && {
				caseListActionsApplied: reader.caseListActionsApplied,
			}),
		},
		choices,
		settlements: [],
		lookup: NO_TABLES,
		mediaClaims: [],
		media: { files: [], rows: new Map() },
		...overrides,
	};
}
