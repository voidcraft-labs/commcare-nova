import "server-only";

/**
 * The two readings a change made in CommCare HQ is the difference of: the
 * baseline's stored source, CommCare HQ's own answer when Nova last left the
 * app there, and CommCare HQ's app as it is now. One reader, one identity
 * map and one set of the Project's data serve both, so whatever CommCare HQ
 * and the reader do to an app is in both and cancels.
 *
 * They differ in three inputs: the source, its aligned menus, and the media
 * index. Both sources are read in the key order a baseline stores, so a map
 * the reader reads in its key order reads alike on both sides. Both take one `matchingResolver` over the reference
 * document's identities under the identity a publish to this deployment
 * sends, which holds nothing a reading claims, so an entity CommCare HQ still
 * holds under the key Nova published it with carries Nova's UUID in both, and
 * one CommCare HQ added is minted the same in both.
 *
 * Both passes share the request's held emissions (`ReaderOptions.heldExpansions`), so a later
 * reading of the request that emits a document either pass emitted under the same inputs (the
 * fixed point's re-read of the reading now) is answered with that emission.
 *
 * Pure: it reads its arguments and nothing else.
 */

import { isDeepStrictEqual } from "node:util";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import type { HqAlignedModule } from "@/lib/commcare/hq/appReading";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import { lookupWireNaming } from "@/lib/commcare/lookup/naming";
import {
	knownCaseTypesOf,
	knownFormOpenings,
	knownLanguageCodesOf,
	type ReadDraft,
	type ReaderInput,
	type ReaderMediaIndex,
	type ReadOutcome,
	readHqAppSteps,
} from "@/lib/commcare/reader";
import type { HeldExpansions } from "@/lib/commcare/reader/heldExpansions";
import { matchingResolver } from "@/lib/commcare/reader/identity";
import { externalIdentityMap } from "@/lib/commcare/reader/identityMap";
import {
	targetWireIdentity,
	type WireIdentityOverride,
} from "@/lib/commcare/wireIdentity";
import type { FormParseIssueCode } from "@/lib/commcare/xpath/formParseIssues";
import type { CheckErrorCode } from "@/lib/domain/expression/typeChecker";
import { knownFormEntryChoicesOf } from "@/lib/domain/formEntryCases";
import { isMediaKind } from "@/lib/domain/multimedia";
import { PLATFORMS, type Platform } from "@/lib/domain/platforms";
import type { Finding } from "@/lib/publish/hqFindings";
import type { HqMediaPath } from "../hqMedia";
import { normalizedHqAppSource } from "../hqSourceBaseline";
import { readingAppStrings } from "../reading/appStrings";
import { readerLookupContext } from "../reading/gather";
import {
	projectDataReadsOf,
	type ReadingProjectData,
	readingProjectDataFindingsFor,
} from "../reading/projectData";
import {
	type HqMediaClaim,
	hqMediaReferencesOf,
	mediaFindings,
	planReadingMedia,
	type ReadingMediaPlan,
	readingMediaIndex,
} from "../reading/projectData/media";
import {
	alignedFromSource,
	inStoredKeyOrder,
	sourceFromBaseline,
} from "./baselineSource";
import type { ReferenceDocument } from "./reference";

export interface HqChangeReadings {
	/** The reading of the baseline's source. */
	readonly base: Extract<ReadOutcome, { readonly kind: "read" }>;
	/** The reading of CommCare HQ's app now. */
	readonly now: ReadOutcome;
	/** The reader's input of each reading, for acceptance of the reading now and for the
	 *  first-publish register over each. */
	readonly inputs: { readonly base: ReaderInput; readonly now: ReaderInput };
	/** Media references with no file the base reading leaves out where the app runs: the
	 *  base's side of the register's `mediaClaims`. */
	readonly baseMediaClaims: readonly HqMediaClaim[];
}

/** Why there is no base: the Project's data changed under the base source (it reads a table,
 *  a column or a level the Project's data no longer has, or what it reads has a finding of its
 *  own now: a table CommCare HQ no longer lists, a table or places Nova cannot hold), its
 *  reading passed the work limit Nova gives a reading of its size (`reader/work.ts`), or
 *  nothing says so, which is Nova's to fix. */
export type HqChangeBaseUnavailable =
	| "base-needs-project-data"
	| "comparison-too-intricate"
	| "base-unreadable";

export type HqChangeReadingsResult =
	| { readonly kind: "readings"; readonly readings: HqChangeReadings }
	| { readonly kind: "no-base"; readonly reason: HqChangeBaseUnavailable };

export interface HqChangeReadingsInput {
	/** The Nova app's id. */
	readonly appId: string;
	/** The project space the deployment publishes to, as a reading names it. */
	readonly target: { readonly origin: string; readonly domain: string };
	/** The baseline's normalized source (`AppBaseline.source`), verified by `readAppBaseline`. */
	readonly baselineSource: unknown;
	/** CommCare HQ's app now, as a bring-in's bracketed read gives it. */
	readonly now: {
		readonly source: HqAppSource;
		readonly modules: readonly HqAlignedModule[];
	};
	/** The Project's data, read once for the request, as a bring-in reads it. */
	readonly data: ReadingProjectData;
	/** The flag answer where the source now holds a write saved only if changed. */
	readonly saveOnlyEditedApplied?: boolean;
	readonly caseListActionsApplied?: boolean;
	readonly reference: Extract<ReferenceDocument, { readonly kind: "ok" }>;
	/** The entities of the deployment's target-identity record (`store.ts::readTargetIdentity`). */
	readonly overrides: readonly WireIdentityOverride[];
	readonly media: {
		/** Every file the reference publishes to the deployment, settled against the source now
		 *  (`hqMediaStandings`, then `settleHqMedia`): no path `moved` or `unrecorded`. */
		readonly published: readonly HqMediaPath[];
		/** The verdicts of the files each source's map names, judged as a bring-in judges a file;
		 *  null before any is fetched. */
		readonly base: ReadingMediaPlan | null;
		readonly now: ReadingMediaPlan | null;
	};
	/** Nova's emissions the readings of the request share; absent, every emission is made afresh. */
	readonly heldExpansions?: HeldExpansions;
}

const JR_FILE = "jr://file/";

/** Plan the HQ file reads while retaining the app's full set of slots for Android content verification. */
export function planChangeReadingMedia(
	source: HqAppSource,
	appId: string,
	draft: ReadDraft,
	own: ReadonlySet<string>,
	runsOn: readonly Platform[],
) {
	return planReadingMedia({
		source,
		appId,
		references: hqMediaReferencesOf(draft.facts),
		ownPaths: own,
		runsOn,
	});
}

/** Every path the reference publishes, which the base reading names Nova's own file by. */
export function ownPathsBase(
	published: readonly HqMediaPath[],
): ReadonlySet<string> {
	return new Set(published.map((path) => `${JR_FILE}${path.wirePath}`));
}

/** The asset of each published path a reading names Nova's own file by, keyed by its path
 *  as a source's map keys it. */
function publishedAssets(
	paths: readonly HqMediaPath[],
	take: (path: HqMediaPath) => boolean,
): ReadonlyMap<string, HqMediaPath> {
	const byPath = new Map<string, HqMediaPath>();
	for (const path of paths)
		if (take(path)) byPath.set(`${JR_FILE}${path.wirePath}`, path);
	return byPath;
}

/**
 * A media index that answers a published path with Nova's own asset where
 * `own` holds it, and every other path as `rest` answers it.
 */
function withOwnFiles(
	own: ReadonlyMap<string, HqMediaPath>,
	rest: ReaderMediaIndex,
): ReaderMediaIndex {
	return {
		resolve(path) {
			const file = own.get(path);
			if (file === undefined) return rest.resolve(path);
			return isMediaKind(file.kind)
				? { kind: "asset", assetId: file.assetId, mediaKind: file.kind }
				: { kind: "unreadable" };
		},
	};
}

/**
 * The base reading's index: every path the reference publishes is its own
 * file; any other path the baseline's map names is the file it names there,
 * and one CommCare HQ no longer serves reads as no entry.
 */
function baseIndex(
	source: HqAppSource,
	appId: string,
	published: readonly HqMediaPath[],
	plan: ReadingMediaPlan | null,
): ReaderMediaIndex {
	const byPath = new Map(
		(source.multimediaMap ?? []).map((item) => [item.path, item]),
	);
	const rest = readingMediaIndex({ source, appId, plan });
	return withOwnFiles(
		publishedAssets(published, () => true),
		{
			resolve(path) {
				const resolution = rest.resolve(path);
				const item = byPath.get(path);
				// An entry that names a file Nova can ask for reads as unreadable here only where its
				// verdict is `missing`: CommCare HQ no longer serves the file the baseline named.
				const readable =
					item !== undefined &&
					!item.unreadable &&
					item.multimediaId !== null &&
					item.mediaType !== null &&
					item.mediaType !== "CommCareMultimedia";
				return resolution.kind === "unreadable" && readable
					? { kind: "no-entry" }
					: resolution;
			},
		},
	);
}

/**
 * The reading now's index: a published path whose file stands `recorded`
 * or `absent` is Nova's own file, so neither a map that lags Nova's upload
 * nor an upload that failed reads as a change; a `replaced` one, and every
 * other path, is CommCare HQ's file there now.
 */
function nowIndex(
	source: HqAppSource,
	appId: string,
	published: readonly HqMediaPath[],
	plan: ReadingMediaPlan | null,
): ReaderMediaIndex {
	return withOwnFiles(
		publishedAssets(
			published,
			(path) => path.standing === "recorded" || path.standing === "absent",
		),
		readingMediaIndex({ source, appId, plan }),
	);
}

/** The form parser's reasons for a read of the Project's data the reading was not given: a
 *  table, a column of a table it holds, an organization level. The reader gives an itemset
 *  naming a column its table lacks the same reason (`xform/options.ts`, `search/prompts.ts`). */
const PROJECT_DATA_PARSE_REASONS: ReadonlySet<string> = new Set(
	(
		[
			"unknown-table",
			"unknown-column",
			"unknown-level",
		] as const satisfies readonly FormParseIssueCode[]
	).map((code) => `parse:${code}`),
);

/** The checker's codes for a read of a table or a column the Project's catalog lacks, as the
 *  reader writes them into a finding's reason (`<code>` or `<code>:<reason>`). */
const PROJECT_DATA_CHECK_CODES: ReadonlySet<string> = new Set([
	"unknown-lookup-table",
	"unknown-lookup-column",
] as const satisfies readonly CheckErrorCode[]);

/**
 * Whether the reader refused a read of the Project's data that is not there
 * now: a table, a column or a level the published app read, renamed or
 * removed since, in Nova or in CommCare HQ. Such a base would read again once
 * the Project's data reads as it did when Nova published.
 */
function readsProjectDataNotThere(finding: Finding): boolean {
	const reason = finding.detail.reason;
	if (reason === undefined) return false;
	if (PROJECT_DATA_PARSE_REASONS.has(reason)) return true;
	const colon = reason.indexOf(":");
	return PROJECT_DATA_CHECK_CODES.has(
		colon < 0 ? reason : reason.slice(0, colon),
	);
}

function declaredBy(runsOnlyOn: Platform | undefined): readonly Platform[] {
	return runsOnlyOn === undefined ? PLATFORMS : [runsOnlyOn];
}

/** Both readings, over the inputs they share, or why the base reading is no base. */
export function makeHqChangeReadings(
	input: HqChangeReadingsInput,
): HqChangeReadingsResult {
	const steps = makeHqChangeReadingsSteps(input);
	for (;;) {
		const step = steps.next();
		if (step.done) return step.value;
	}
}

/**
 * `makeHqChangeReadings` one stage at a time: it stops after each source is
 * parsed and after each stage of each reader pass, so a caller can let the
 * event loop turn between them.
 */
export function* makeHqChangeReadingsSteps(
	input: HqChangeReadingsInput,
): Generator<void, HqChangeReadingsResult, void> {
	const { appId, reference, data } = input;
	const lookup = readerLookupContext(data);
	const identity = targetWireIdentity(input.overrides);
	const resolver = matchingResolver(
		appId,
		externalIdentityMap(
			reference.identityDoc,
			targetWireIdentity(input.overrides),
			lookupWireNaming(lookup.definitions),
		),
	);
	const baseSource = sourceFromBaseline(input.baselineSource);
	const shared = {
		knownOpenings: knownFormOpenings(reference.doc, baseSource),
		appId,
		target: input.target,
		resolver,
		lookup: data.lookups,
		organization: data.organization,
		sourceProjectFactories: data.sourceProjectFactories,
		appStrings: readingAppStrings(lookup),
		recordDialect: recordDialectRoundTrip,
		knownCaseTypes: knownCaseTypesOf(reference.doc),
		knownFormEntryChoices: knownFormEntryChoicesOf(reference.doc),
		knownLanguageCodes: knownLanguageCodesOf(reference.doc),
		...(input.saveOnlyEditedApplied !== undefined && {
			saveOnlyEditedApplied: input.saveOnlyEditedApplied,
		}),
		...(input.caseListActionsApplied !== undefined && {
			caseListActionsApplied: input.caseListActionsApplied,
		}),
	} satisfies Omit<ReaderInput, "source" | "modules" | "media">;

	yield;
	const current =
		data.suiteDetails && normalizedHqAppSource(input.now.source.raw);
	const baseInput: ReaderInput = {
		...shared,
		suiteDetails:
			current &&
			"normalized" in current &&
			isDeepStrictEqual(current.normalized, input.baselineSource)
				? data.suiteDetails
				: undefined,
		source: baseSource,
		modules: alignedFromSource(baseSource, {
			doc: reference.identityDoc,
			identity,
		}),
		media: baseIndex(
			baseSource,
			appId,
			input.media.published,
			input.media.base,
		),
	};
	const nowSource = inStoredKeyOrder(input.now.source);
	yield;
	const nowInput: ReaderInput = {
		...shared,
		suiteDetails: data.suiteDetails,
		source: nowSource,
		modules: input.now.modules,
		media: nowIndex(nowSource, appId, input.media.published, input.media.now),
	};

	const options =
		input.heldExpansions === undefined
			? {}
			: { heldExpansions: input.heldExpansions };
	/* A reference that holds no level was read with none: its reading read no places, so Nova
	 * holds no level for it. The base is read as it was then, so the levels CommCare HQ's change
	 * newly reads come in as that change's own, beside the rule that reads them. A base that
	 * reads a level all the same is read with the Project's levels, as before. */
	const levelless =
		(reference.doc.organizationLevelOrder ?? []).length === 0 &&
		data.organization.levels.length > 0;
	let base = yield* readHqAppSteps(
		levelless
			? { ...baseInput, organization: { levelCodes: [], levels: [] } }
			: baseInput,
		options,
	);
	if (levelless && base.kind === "account")
		base = yield* readHqAppSteps(baseInput, options);
	if (base.kind === "account")
		return {
			kind: "no-base",
			reason: base.findings.some((finding) => finding.code === "too-intricate")
				? "comparison-too-intricate"
				: base.findings.some(readsProjectDataNotThere) ||
						readingProjectDataFindingsFor(
							data,
							projectDataReadsOf(data, base),
							null,
							resolver,
						).length > 0
					? "base-needs-project-data"
					: "base-unreadable",
		};
	const now = yield* readHqAppSteps(nowInput, options);
	yield;
	const runsOn = declaredBy(reference.doc.appSettings.runsOnlyOn);
	const { media } = planChangeReadingMedia(
		baseSource,
		appId,
		base.draft,
		ownPathsBase(input.media.published),
		runsOn,
	);
	// A read or bring-in can record a source that already points at a missing
	// HQ file. A later edit compares the same file verdict on both sides.
	const baseMediaClaims =
		input.media.base === null
			? media.claims
			: [
					...media.claims,
					...mediaFindings({
						plan: media,
						verdicts: input.media.base.verdicts,
						runsOn,
					}).claims,
				];
	return {
		kind: "readings",
		readings: {
			base,
			now,
			inputs: { base: baseInput, now: nowInput },
			baseMediaClaims,
		},
	};
}
