import "server-only";

/**
 * The one function both bring-in requests call: read one app of CommCare HQ
 * under the bracketed read, read the Project's data it may read, run the
 * reader, judge every file it references and accept what it read. A create
 * passes one argument a read does not, `keepMedia`, which keeps the bytes of
 * each held file for the publish that follows. So an equal digest at the
 * create means every check that passed at the review passed again, on the
 * same content.
 *
 * Everything but the files is judged before a file is fetched, and a review
 * is never answered before every file is judged: where the app can run
 * depends on where its files play.
 *
 * Nothing here writes. What one request reads stays in memory until the
 * request answers. No log line holds a word of the app: a finding's name, a
 * difference's detail and CommCare HQ's own text reach no line.
 */

import { setImmediate as nextTurn } from "node:timers/promises";
import { recordDialectRoundTrip } from "@/lib/agent/authoring/recordRoundTrip";
import { readHqSaveOnlyEditedAnswers } from "@/lib/commcare/client";
import {
	type HqAlignedModule,
	notSummarizedMenus,
	readHqAppForReading,
} from "@/lib/commcare/hq/appReading";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import { type HqFailure, hqReadCircumstance } from "@/lib/commcare/hq/failure";
import type { CommCareCredentials } from "@/lib/commcare/hq/http";
import {
	publishedCaseBlocks,
	sourceHoldsEditMode,
} from "@/lib/commcare/hq/publishedCaseBlocks";
import {
	type ReadDraft,
	type ReaderInput,
	type ReadOutcome,
	readHqAppSteps,
} from "@/lib/commcare/reader";
import {
	type ClaimLog,
	type ClaimRecord,
	serializeClaimLog,
} from "@/lib/commcare/reader/accounting";
import { HeldExpansions } from "@/lib/commcare/reader/heldExpansions";
import { mintingResolver } from "@/lib/commcare/reader/identity";
import { placeOrder } from "@/lib/commcare/reader/place";
import { COMMCARE_SERVERS } from "@/lib/commcare/servers";
import { inventoryIndex } from "@/lib/commcare/surface/inventory";
import { isDeclaredSurfaceKey } from "@/lib/commcare/surface/revision";
import { targetFactsFromSource } from "@/lib/commcare/targetFacts";
import { targetWireIdentity } from "@/lib/commcare/wireIdentity";
import { getHqCredentials } from "@/lib/db/settings";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import type {
	DeclarationChoice,
	DeclarationChoices,
} from "@/lib/doc/platformDeclaration";
import {
	effectiveAppLocalization,
	PLATFORMS,
	type Platform,
	type PlatformFeatureId,
} from "@/lib/domain";
import { remapAssetRefs } from "@/lib/domain/mediaRefs";
import type { MediaAssetId } from "@/lib/domain/multimedia";
import { PLATFORM_FEATURE_IDS } from "@/lib/domain/platforms";
import { unavailableUses } from "@/lib/domain/platformUses";
import { log } from "@/lib/logger";
import type {
	LookupFixtureDataSnapshot,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import {
	type CircumstanceDetail,
	type CircumstanceFinding,
	circumstanceFinding,
	type Finding,
	type HqPlace,
	type ReadCircumstance,
} from "@/lib/publish/hqFindings";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	type AdoptedMediaFile,
	adoptedBaselineOwnershipSteps,
	adoptedIdentityRows,
	adoptedSourceTree,
	adoptionPlanFeatureConfirmations,
	assignMediaPaths,
} from "../adoption";
import { readHqAppClaims } from "../store";
import { keptListFor } from "../targetFacts";
import { type AcceptedReading, acceptReadingSteps } from "./acceptance";
import { adoptionExportBoundary } from "./adoptionBoundary";
import { readingAppStrings } from "./appStrings";
import { reviewDigestOf } from "./digest";
import { reviewMediaId } from "./mediaIds";
import {
	projectDataReadsOf,
	type ReaderProjectDataReads,
	type ReadingProjectData,
	readingLookupSnapshot,
	readingProjectDataFindingsFor,
	unreadPlacesFailure,
} from "./projectData";
import { boundAsItStands } from "./projectData/lookupTables";
import {
	adoptedMediaFiles,
	type HqMediaClaim,
	type HqMediaPlan,
	hqMediaReferencesOf,
	narrowDeclarationsByMedia,
	planReadingMedia,
	type ReadingMediaPlan,
	readingMediaFindings,
	readingMediaIndex,
	readingMediaRows,
} from "./projectData/media";
import { judgeReadingMedia } from "./projectData/mediaStore";
import {
	postgresProjectSide,
	type ReadingProjectSide,
	readReadingProjectData,
} from "./projectData/read";
import { projectDataReview } from "./projectData/review";
import { handOffSettlements } from "./projectData/settlements";
import type { BringInActor } from "./read";
import {
	READING_MAX_LISTED_FINDINGS,
	type ReadingAnswer,
	type ReadingEvent,
	type ReadingKey,
	type ReadingReview,
} from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GatherInput {
	readonly actor: BringInActor;
	readonly key: ReadingKey;
	readonly readingId: string;
	/** `broughtInAppId(actor.userId, key, readingId)`. */
	readonly appId: string;
	/** False in a read. True in a create: the plan keeps the bytes of each held file. */
	readonly keepMedia: boolean;
	/** Stage and file-count events. `gatherReading` never emits `done` or `failed`. */
	readonly onEvent: (event: ReadingEvent) => void;
	readonly cancel?: AbortSignal;
}

/** What one request read of CommCare HQ and of the Project. In memory until the request answers. */
export interface Fetched {
	readonly source: HqAppSource;
	readonly modules: readonly HqAlignedModule[];
	/** The save counter both ends of the bracketed read held. */
	readonly hqVersion: number;
	/** ISO 8601: when the bracketed read answered. */
	readonly readAt: string;
	/** The Project data, bound with no answer of the person's. */
	readonly data: ReadingProjectData;
	/** The flag answer where the source holds a write saved only if changed; absent where it
	 *  holds none. */
	readonly saveOnlyEditedApplied?: boolean;
}

/** A clean read, held in memory for the length of one request and never stored. */
export interface Gathered {
	readonly fetched: Fetched;
	/** The reader's draft: the document, its construction batch, its identities, its declarations. */
	readonly draft: ReadDraft;
	readonly accepted: Extract<AcceptedReading, { ok: true }>;
	/** What the reader read of project data. */
	readonly reads: ReaderProjectDataReads;
	/** The tables the document reads, as the birth will hold them. Acceptance's `lookup`, and
	 *  what the adoption's export boundary names its tables from. */
	readonly lookup: LookupFixtureDataSnapshot;
	/** Every referenced file with its verdict; in a create, the kept bytes of each held file and
	 *  then its published asset. */
	readonly media: ReadingMediaPlan;
	/** One entry per referenced path of every held file. */
	readonly mediaFiles: readonly AdoptedMediaFile[];
	readonly review: ReadingReview;
	readonly reviewDigest: string;
}

export type GatherResult =
	| { readonly kind: "stop"; readonly finding: CircumstanceFinding }
	| {
			readonly kind: "account";
			readonly account: Extract<ReadingAnswer, { kind: "account" }>;
	  }
	| { readonly kind: "clean"; readonly gathered: Gathered };

/** What the request's log line and the test at the cap read. */
export interface GatherFacts {
	/** `Buffer.byteLength(JSON.stringify(source.raw))`: CommCare HQ's source body less its white
	 *  space. Null where the source was not read. */
	readonly sourceBytes: number | null;
	/** The time the request's synchronous pieces took together, the longest of them, and what
	 *  that one was part of. */
	readonly checkMs: number;
	readonly longestPieceMs: number;
	readonly longestPieceAt: string;
	readonly mediaTotal: number;
	/** `ReadFacts.expressionRounds` where the reader gave a draft. */
	readonly expressionRounds: number | null;
}

/** What steps 1 and 2 resolve before anything of the app is read. */
export interface GatherSources {
	readonly creds: CommCareCredentials;
	/** The Project's side of the read. Production's is `postgresProjectSide`. */
	readonly project: ReadingProjectSide;
}

/** What the reader claimed in one gather, with each media reference Nova leaves out filed under
 *  its entry. `log` is the claim log as `serializeClaimLog` writes it, present where the full log
 *  was asked for. */
export interface GatherClaims {
	readonly counts: ClaimLog["counts"];
	readonly log?: string;
}

// ---------------------------------------------------------------------------
// Developer messages (thrown or logged; none holds a word of an app)
// ---------------------------------------------------------------------------

export const KEY_IN_ANOTHER_PROJECT =
	"A bring-in was authorized for one Project and asked to work in another. The actor must come from authorizeBringIn called with the same projectId the key holds. Look at the caller of lib/deployment/reading/index.ts.";

const AMBIGUOUS_NAMED_SPACE =
	"Nova asked for CommCare HQ credentials for a named project space and was told the choice is ambiguous, which a named project space can't be. Look at lib/db/settings.ts::resolveHqTarget.";

function formWithNoRealId(appId: string): string {
	return `The reading ${appId} holds a form that has no real CommCare HQ id. A reading with a menu CommCare HQ could not summarize should have ended as an account. Look at gather.ts, step 4.`;
}

// ---------------------------------------------------------------------------
// The log key of an `unrecognized` finding
// ---------------------------------------------------------------------------

/** A schema class's name, as CommCare HQ's document types are spelled: an upper-case ASCII
 *  letter, then letters and digits. */
function isClassName(text: string): boolean {
	if (text.length === 0) return false;
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		const upper = code >= 65 && code <= 90;
		const lower = code >= 97 && code <= 122;
		const digit = code >= 48 && code <= 57;
		if (index === 0 ? !upper : !(upper || lower || digit)) return false;
	}
	return true;
}

/**
 * The word an `unrecognized` finding's log line is titled by: the name itself
 * where it is a surface key the manifest declares, which is CommCare's own
 * schema and no content of an app, and otherwise one word of a closed set by
 * the name's shape: `undeclared-json-key` for a `<class>.<key>` with no
 * `schema:` prefix, `xform-element` for an `xform:` name with no `@`,
 * `xform-attribute` for one with an `@`, and `other` for anything else (a file
 * path, a table's tag, an appearance's value).
 */
export function unrecognizedLogKey(name: string): string {
	if (isDeclaredSurfaceKey(name)) return name;
	if (name.startsWith("xform:"))
		return name.includes("@") ? "xform-attribute" : "xform-element";
	if (name.startsWith("schema:")) return "other";
	const dot = name.indexOf(".");
	if (dot > 0 && dot < name.length - 1 && isClassName(name.slice(0, dot)))
		return "undeclared-json-key";
	return "other";
}

// ---------------------------------------------------------------------------
// Timing the synchronous pieces
// ---------------------------------------------------------------------------

/**
 * Times each synchronous piece of a request, and lets the event loop turn
 * before each one, so no two pieces run in one turn. A review of changes
 * made in CommCare HQ times its own pieces with it.
 */
export class Pieces {
	total = 0;
	longest = 0;
	/** What the longest piece was part of, as `at` named it. */
	longestAt = "";
	/** What the pieces now running are part of. */
	private part = "";
	/** The emissions this request's readings share (`heldExpansions.ts`). */
	readonly expansions = new HeldExpansions();

	/** Names what the pieces that follow are part of, for the facts that
	 *  name the longest. */
	at(part: string): this {
		this.part = part;
		return this;
	}

	async run<T>(piece: () => T): Promise<T> {
		await nextTurn();
		const started = performance.now();
		try {
			return piece();
		} finally {
			const took = performance.now() - started;
			this.total += took;
			if (took > this.longest) {
				this.longest = took;
				this.longestAt = this.part;
			}
		}
	}

	/** Runs `steps` to their end, each step its own piece. */
	async steps<T>(steps: Generator<void, T, void>): Promise<T> {
		for (;;) {
			const step = await this.run(() => steps.next());
			if (step.done) return step.value;
		}
	}
}

interface Tally {
	sourceBytes: number | null;
	mediaTotal: number;
	expressionRounds: number | null;
}

function factsOf(pieces: Pieces, tally: Tally): GatherFacts {
	return {
		sourceBytes: tally.sourceBytes,
		checkMs: pieces.total,
		longestPieceMs: pieces.longest,
		longestPieceAt: pieces.longestAt,
		mediaTotal: tally.mediaTotal,
		expressionRounds: tally.expressionRounds,
	};
}

/** Who and what every log line of a request names: never the project space, the app or a
 *  finding's words. */
interface LogScope {
	readonly appId: string;
	readonly projectId: string;
	readonly userId: string | null;
	readonly operation: "read" | "create";
}

function scopeContext(scope: LogScope): Record<string, unknown> {
	return {
		appId: scope.appId,
		projectId: scope.projectId,
		...(scope.userId !== null && { userId: scope.userId }),
		operation: scope.operation,
	};
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

const APP: HqPlace = { kind: "app" };

/** A circumstance at the app with no detail. Every code a failed read of CommCare HQ is carries
 *  none, and neither does a stop of steps 1 to 3. */
function atApp(code: ReadCircumstance): CircumstanceFinding {
	return circumstanceFinding(code, APP, {} as CircumstanceDetail<typeof code>);
}

function stopOf(finding: CircumstanceFinding): GatherResult {
	return { kind: "stop", finding };
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** Each finding once: two equal findings from two producers are one line of the account. */
function distinctFindings(findings: readonly Finding[]): Finding[] {
	const seen = new Set<string>();
	return findings.filter((finding) => {
		const key = JSON.stringify([finding.code, finding.place, finding.detail]);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** The account of `findings`, sorted by place and then code, the first ones listed. */
function accountOf(
	findings: readonly Finding[],
	appName: string | null,
	mediaChecked: boolean,
): GatherResult {
	const all = distinctFindings(findings).sort(
		(a, b) => placeOrder(a.place, b.place) || compareText(a.code, b.code),
	);
	const counts = { notYet: 0, never: 0, fixInHq: 0 };
	for (const finding of all) {
		if (finding.standing === "not-yet") counts.notYet += 1;
		else if (finding.standing === "never") counts.never += 1;
		else if (finding.standing === "fix-in-hq") counts.fixInHq += 1;
	}
	return {
		kind: "account",
		account: {
			kind: "account",
			appName,
			findings: all.slice(0, READING_MAX_LISTED_FINDINGS),
			more: Math.max(0, all.length - READING_MAX_LISTED_FINDINGS),
			counts,
			mediaChecked,
		},
	};
}

/**
 * A failed read of CommCare HQ: a stop where its circumstance stands `stop`,
 * else an account of that one finding, with no app name, since only a body
 * of the app over the bound reaches here and its name was not read.
 */
function failedRead(failure: HqFailure): GatherResult {
	const finding = atApp(hqReadCircumstance(failure));
	return finding.standing === "stop"
		? stopOf(finding)
		: accountOf([finding], null, false);
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

/**
 * The gate's context over every table the catalog binds, under the catalog's
 * own ids: a table bound to a Project table as it stands is that table, and
 * any other is the catalog's definition at the Project table's revision, or
 * the first, as the birth will hold it.
 */
export function readerLookupContext(
	data: ReadingProjectData,
): LookupValidationContext {
	const definitions: LookupTableDefinition[] = [];
	for (const table of data.gathered.tables) {
		const { standing, binding } = table;
		if (standing === null || binding === null) continue;
		if (boundAsItStands(standing, table.choice)) {
			definitions.push(standing.table);
			continue;
		}
		const definition = data.lookups.definitions.get(binding.tableId);
		if (definition === undefined) continue;
		definitions.push({
			id: definition.id,
			name: definition.name,
			tag: definition.tag,
			definitionRevision: (table.projectTable?.definitionRevision ??
				"0") as LookupTableDefinition["definitionRevision"],
			columns: definition.columns.map((column) => ({
				id: column.id,
				wireName: column.wireName,
				label: column.label,
				dataType: "text" as const,
			})),
		});
	}
	return {
		kind: "available",
		projectId: data.gathered.project.projectId,
		projectRevision: data.gathered.project.projectRevision,
		definitions,
	};
}

/** The reader's input over what was fetched, with the media index `plan` gives (none before the
 *  files are judged). */
function readerInputFor(
	appId: string,
	key: ReadingKey,
	fetched: Pick<
		Fetched,
		"source" | "modules" | "data" | "saveOnlyEditedApplied"
	>,
	plan: ReadingMediaPlan | null,
): ReaderInput {
	return {
		appId,
		target: {
			origin: COMMCARE_SERVERS[key.server].baseUrl,
			domain: key.domain,
		},
		source: fetched.source,
		modules: fetched.modules,
		resolver: mintingResolver(appId),
		lookup: fetched.data.lookups,
		organization: fetched.data.organization,
		media: readingMediaIndex({ source: fetched.source, appId, plan }),
		appStrings: readingAppStrings(readerLookupContext(fetched.data)),
		recordDialect: recordDialectRoundTrip,
		...(fetched.saveOnlyEditedApplied !== undefined && {
			saveOnlyEditedApplied: fetched.saveOnlyEditedApplied,
		}),
	};
}

/** The constructor names a thrown value is logged under: any other is `other`. */
const THROWN_NAMES: ReadonlySet<string> = new Set([
	"Error",
	"TypeError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
]);

/**
 * Where the reader broke its own contract, in closed words only: the part of
 * the reading that ran (`input` before the first stage, `stage/<index in
 * STAGES>`, `close`, or `declaration` for a draft that offers no choice) and
 * the thrown value's constructor name. Never the thrown message, which can
 * quote the app.
 */
interface ReaderBreak {
	readonly at: string;
	readonly thrown: string | null;
}

type ReaderRun =
	| { readonly kind: "outcome"; readonly outcome: ReadOutcome }
	/** The reader broke its own contract: it threw, or gave a draft whose declarations offer
	 *  nothing. */
	| { readonly kind: "contract"; readonly broke: ReaderBreak };

function thrownName(error: unknown): string {
	const name = error instanceof Error ? error.constructor.name : typeof error;
	return THROWN_NAMES.has(name) ? name : "other";
}

/** The reader over `input`, each of its stages one of `pieces`. */
async function runReader(
	pieces: Pieces,
	input: ReaderInput,
	claims: "counts" | "full",
): Promise<ReaderRun> {
	let at = "input";
	let outcome: ReadOutcome;
	try {
		outcome = await pieces.at("the reading").steps(
			readHqAppSteps(input, {
				claims,
				heldExpansions: pieces.expansions,
				onStage: (stage) => {
					at = stage === "close" ? "close" : `stage/${stage}`;
				},
			}),
		);
	} catch (error) {
		return { kind: "contract", broke: { at, thrown: thrownName(error) } };
	}
	if (outcome.kind === "read" && outcome.draft.declaration.kind !== "choices")
		return { kind: "contract", broke: { at: "declaration", thrown: null } };
	return { kind: "outcome", outcome };
}

/**
 * The account of one of Nova's own failures at the app, logged under the reader's check. A
 * contract break carries where it broke (`broke`) and an identity-row fault its own closed `why`;
 * the message and the signatures stay one per kind of fault.
 */
function readerFault(
	scope: LogScope,
	signature: "contract" | "identity-rows",
	appName: string | null,
	mediaChecked: boolean,
	detail: { readonly why?: string; readonly broke?: ReaderBreak } = {},
): GatherResult {
	log.error(`[reading] read-back differs: reader: ${signature}`, undefined, {
		...scopeContext(scope),
		phase: "reader",
		differenceCount: 1,
		signatures: [`reader/${signature}`],
		...(detail.why !== undefined && { why: detail.why }),
		...(detail.broke !== undefined && {
			at: detail.broke.at,
			...(detail.broke.thrown !== null && { thrown: detail.broke.thrown }),
		}),
	});
	return accountOf(
		[circumstanceFinding("read-back-differs", APP, { name: "reader" })],
		appName,
		mediaChecked,
	);
}

/** The platforms a declaration choice runs the app on. */
function declaredBy(runsOnlyOn: Platform | undefined | null): Platform[] {
	return runsOnlyOn === undefined || runsOnlyOn === null
		? [...PLATFORMS]
		: [runsOnlyOn];
}

function proposedChoice(
	declaration: Extract<DeclarationChoices, { kind: "choices" }>,
): DeclarationChoice {
	const choice = declaration.choices[declaration.proposed];
	if (choice === undefined)
		throw new Error(
			"The reader proposed a declaration choice it does not offer. Look at lib/doc/platformDeclaration.ts::planDeclarationChoices.",
		);
	return choice;
}

function choicesOf(
	draft: ReadDraft,
): Extract<DeclarationChoices, { kind: "choices" }> {
	if (draft.declaration.kind !== "choices")
		throw new Error(
			"A reading's draft offers no declaration choice, which runReader turns into the reader's contract error before any caller sees it.",
		);
	return draft.declaration;
}

/** Every platform some declaration choice of the draft declares. */
function offeredPlatforms(draft: ReadDraft): Platform[] {
	const offered = new Set<Platform>();
	for (const choice of choicesOf(draft).choices)
		for (const platform of declaredBy(choice.runsOnlyOn)) offered.add(platform);
	return PLATFORMS.filter((platform) => offered.has(platform));
}

/** Step 4: one finding at each menu CommCare HQ could not summarize, or the app's one. */
function unsummarizedFindings(
	source: HqAppSource,
	modules: readonly HqAlignedModule[],
): { readonly app: boolean; readonly findings: readonly Finding[] } {
	const answer = notSummarizedMenus(modules);
	if (answer.kind === "none") return { app: false, findings: [] };
	if (answer.kind === "app")
		return {
			app: true,
			findings: [atApp("app-unreadable-in-hq")],
		};
	const rawMenus = Array.isArray(source.raw.modules)
		? (source.raw.modules as unknown[])
		: [];
	const first = source.langs[0];
	return {
		app: false,
		findings: answer.indexes.map((menu) => {
			const raw = rawMenus[menu];
			const names =
				typeof raw === "object" && raw !== null
					? (raw as { readonly name?: unknown }).name
					: undefined;
			const name =
				first !== undefined &&
				typeof names === "object" &&
				names !== null &&
				typeof (names as Record<string, unknown>)[first] === "string"
					? ((names as Record<string, unknown>)[first] as string)
					: "";
			return circumstanceFinding(
				"menu-unreadable-in-hq",
				{ kind: "menu", menu, name },
				{},
			);
		}),
	};
}

// ---------------------------------------------------------------------------
// Logging what the request met
// ---------------------------------------------------------------------------

const LOGGED_AT_MOST = 5;

/** One line per distinct log key of the request's `unrecognized` findings, each carrying the
 *  `why` of the reader defects behind it. */
function logUnrecognized(
	scope: LogScope,
	findings: readonly Finding[],
	defects: readonly { readonly name: string; readonly why: string }[],
): void {
	const keys = new Set<string>();
	for (const finding of findings) {
		if (finding.code !== "unrecognized") continue;
		keys.add(unrecognizedLogKey(finding.detail.name ?? ""));
	}
	for (const key of keys) {
		const whys = defects
			.filter((defect) => unrecognizedLogKey(defect.name) === key)
			.slice(0, LOGGED_AT_MOST)
			.map((defect) => defect.why);
		log.error(`[reading] unrecognized: ${key}`, undefined, {
			...scopeContext(scope),
			...(whys.length > 0 && { defects: whys }),
		});
	}
}

/** The line of an acceptance that failed: its check, the first difference's signature, how
 *  many differences, their distinct signatures, and for a reader defect beside a clean read,
 *  each defect's `why`. No difference's detail. */
function logAcceptanceFailure(
	scope: LogScope,
	failed: Extract<AcceptedReading, { ok: false }>,
	defects: readonly { readonly why: string }[],
): void {
	const signatures = [
		...new Set(failed.differences.map((difference) => difference.signature)),
	].slice(0, LOGGED_AT_MOST);
	log.error(
		`[reading] read-back differs: ${failed.check}: ${failed.signature}`,
		undefined,
		{
			...scopeContext(scope),
			phase: failed.check,
			differenceCount: failed.differences.length,
			signatures,
			...(failed.signature === "accounting/defect" && {
				defects: defects.slice(0, LOGGED_AT_MOST).map((defect) => defect.why),
			}),
		},
	);
}

// ---------------------------------------------------------------------------
// The claim log of a request
// ---------------------------------------------------------------------------

/** The surface key a media reference Nova leaves out is filed under. */
const MULTIMEDIA_MAP_KEY = "schema:Application.multimedia_map";

/**
 * The reader's claims, with each media reference Nova leaves out filed under
 * its entry: once per site the reader handed that path off from, keyed by
 * `schema:Application.multimedia_map`.
 */
function gatherClaimsOf(
	claims: ClaimLog,
	mediaClaims: readonly HqMediaClaim[],
	mode: "counts" | "full",
): GatherClaims {
	const counts: Record<string, number> = { ...claims.counts };
	const filed: ClaimRecord[] = [];
	for (const claim of mediaClaims) {
		const sites = new Map<string, { artifact: string; where: string }>();
		for (const handOff of claims.handOffs) {
			if (
				handOff.to !== "media-reference" ||
				handOff.subject !== claim.reference.path
			)
				continue;
			sites.set(JSON.stringify([handOff.artifact, handOff.where]), {
				artifact: handOff.artifact,
				where: handOff.where,
			});
		}
		const standing = inventoryIndex().entry(claim.entry)?.standing;
		if (standing === undefined)
			throw new Error(
				`A media reference was filed under the entry "${claim.entry}", which the manifest does not hold.`,
			);
		for (const site of sites.values()) {
			counts[claim.entry] = (counts[claim.entry] ?? 0) + 1;
			filed.push({
				artifact: site.artifact,
				where: site.where,
				key: MULTIMEDIA_MAP_KEY,
				entry: claim.entry,
				standing,
			});
		}
	}
	if (mode === "counts") return { counts };
	const all = [...claims.records(), ...filed].sort(
		(a, b) =>
			compareText(a.artifact, b.artifact) ||
			compareText(a.where, b.where) ||
			compareText(a.key ?? "", b.key ?? "") ||
			compareText(a.entry, b.entry),
	);
	return {
		counts,
		log: serializeClaimLog({
			counts,
			handOffs: claims.handOffs,
			records: () => all[Symbol.iterator](),
		}),
	};
}

// ---------------------------------------------------------------------------
// Steps 1 and 2, then the rest
// ---------------------------------------------------------------------------

const NO_FACTS: GatherFacts = {
	sourceBytes: null,
	checkMs: 0,
	longestPieceMs: 0,
	longestPieceAt: "",
	mediaTotal: 0,
	expressionRounds: null,
};

/** Steps 1 and 2 from Nova's own store, then `gatherFromHq`. What both requests call. */
export async function gatherReading(
	input: GatherInput,
): Promise<{ readonly result: GatherResult; readonly facts: GatherFacts }> {
	const { actor, key, onEvent } = input;
	if (key.projectId !== actor.projectId)
		throw new Error(KEY_IN_ANOTHER_PROJECT);

	/* 1. The connection. */
	onEvent({ type: "stage", stage: "connecting" });
	const credentials = await getHqCredentials(actor.userId, key.domain);
	if (!credentials.ok) {
		if (credentials.error === "ambiguous")
			throw new Error(AMBIGUOUS_NAMED_SPACE);
		return {
			result: stopOf(
				atApp(
					credentials.error === "not_configured"
						? "not-connected"
						: "key-cannot-reach-space",
				),
			),
			facts: NO_FACTS,
		};
	}
	if (credentials.creds.server !== key.server)
		return { result: stopOf(atApp("not-connected")), facts: NO_FACTS };

	/* 2. The claim, as advice: the birth's own claim decides. */
	const [holder] = await readHqAppClaims({
		viewerUserId: actor.userId,
		server: key.server,
		domain: key.domain,
		remoteAppIds: [key.remoteAppId],
	});
	if (holder !== undefined) {
		const { remoteAppId: _remoteAppId, ...claim } = holder;
		return {
			result: stopOf(circumstanceFinding("already-in-nova", APP, { claim })),
			facts: NO_FACTS,
		};
	}

	const { result, facts } = await gatherFromHq({
		key,
		readingId: input.readingId,
		appId: input.appId,
		keepMedia: input.keepMedia,
		onEvent,
		...(input.cancel !== undefined && { cancel: input.cancel }),
		creds: credentials.creds,
		project: postgresProjectSide({
			projectId: key.projectId,
			actorUserId: actor.userId,
			appId: input.appId,
			origin: { server: key.server, domain: key.domain },
		}),
		actorUserId: actor.userId,
	});
	return { result, facts };
}

/**
 * Steps 3 to 9. It reads CommCare HQ and, through `sources.project`, the
 * Project's side, and nothing else of Nova's store. `actorUserId`, where
 * given, joins the request's log lines to the person; the proof lane's
 * reading has none.
 */
export async function gatherFromHq(
	input: Omit<GatherInput, "actor"> &
		GatherSources & {
			/** Counts alone by default, as every request keeps them. The proof lane asks `full`. */
			readonly claims?: "counts" | "full";
			readonly actorUserId?: string;
		},
): Promise<{
	readonly result: GatherResult;
	readonly facts: GatherFacts;
	/** Null where the reader never ran: a stop before step 6. */
	readonly claims: GatherClaims | null;
}> {
	const { key, appId, creds, onEvent, cancel } = input;
	const claimsMode = input.claims ?? "counts";
	const scope: LogScope = {
		appId,
		projectId: key.projectId,
		userId: input.actorUserId ?? null,
		operation: input.keepMedia ? "create" : "read",
	};
	const pieces = new Pieces();
	const tally: Tally = {
		sourceBytes: null,
		mediaTotal: 0,
		expressionRounds: null,
	};
	const answer = (
		result: GatherResult,
		claims: GatherClaims | null = null,
	) => ({
		result,
		facts: factsOf(pieces, tally),
		claims,
	});

	/* 3. The app, as one bracketed attempt, made once more where the app was saved during it. */
	onEvent({ type: "stage", stage: "reading-app" });
	let reading = await readHqAppForReading(creds, key.domain, key.remoteAppId, {
		cancel,
	});
	if (reading.kind === "changed" && cancel?.aborted !== true)
		reading = await readHqAppForReading(creds, key.domain, key.remoteAppId, {
			cancel,
		});
	const readAt = new Date().toISOString();
	switch (reading.kind) {
		case "changed":
			return answer(stopOf(atApp("changed-while-reading")));
		case "linked":
			return answer(stopOf(atApp("linked-app")));
		case "remote":
			return answer(stopOf(atApp("remote-app")));
		case "deleted":
			return answer(stopOf(atApp("app-deleted")));
		case "gone":
			return answer(stopOf(atApp("app-gone")));
		case "failed":
			return answer(failedRead(reading.failure));
		case "read":
			break;
	}
	const { source, modules, version: hqVersion } = reading;
	tally.sourceBytes = Buffer.byteLength(JSON.stringify(source.raw));
	const appName = source.name;

	let saveOnlyEditedApplied: boolean | undefined;
	const holdsEditMode = await pieces
		.at("the edit mode test")
		.run(() => sourceHoldsEditMode(publishedCaseBlocks(source.raw)));
	if (holdsEditMode) {
		const flag = await readHqSaveOnlyEditedAnswers(creds, key.domain, {
			cancel,
		});
		if (flag.kind === "not-a-member")
			return answer(stopOf(atApp("not-a-member")));
		if (flag.kind === "failed") return answer(failedRead(flag.failure));
		saveOnlyEditedApplied = flag.kind === "applied";
	}

	/* 4. Menus CommCare HQ could not summarize. */
	const unsummarized = unsummarizedFindings(source, modules);
	if (unsummarized.app)
		return answer(accountOf(unsummarized.findings, appName, false));

	/* 5. The Project data. */
	onEvent({ type: "stage", stage: "reading-project-data" });
	const projectData = await readReadingProjectData({
		creds,
		server: key.server,
		domain: key.domain,
		appId,
		readingId: input.readingId,
		source,
		project: input.project,
		places: "when-source-reads",
		...(cancel !== undefined && { cancel }),
	});
	if (projectData.kind === "failed")
		return answer(failedRead(projectData.failure));
	let data = projectData.data;

	/* 6. The reader, and everything but the files. */
	onEvent({ type: "stage", stage: "checking" });
	const fetchedOf = (current: ReadingProjectData): Fetched => ({
		source,
		modules,
		hqVersion,
		readAt,
		data: current,
		...(saveOnlyEditedApplied !== undefined && { saveOnlyEditedApplied }),
	});
	let run = await runReader(
		pieces,
		readerInputFor(appId, key, fetchedOf(data), null),
		claimsMode,
	);
	if (run.kind === "contract")
		return answer(
			readerFault(scope, "contract", appName, false, { broke: run.broke }),
		);
	let reads = projectDataReadsOf(data, run.outcome);
	if (reads.readsPlaces && !data.placesRead && data.placesUnread === null) {
		/* The source test of step 5 missed a spelling: read places, then the reader again. One
		 * extra pass, never a loop, since this read always reads places. Where step 5 asked and
		 * the read failed, nothing was missed: the failure below answers. */
		log.error("[reading] places read missed", undefined, scopeContext(scope));
		onEvent({ type: "stage", stage: "reading-project-data" });
		const again = await readReadingProjectData({
			creds,
			server: key.server,
			domain: key.domain,
			appId,
			readingId: input.readingId,
			source,
			project: input.project,
			places: "always",
			...(cancel !== undefined && { cancel }),
		});
		if (again.kind === "failed") return answer(failedRead(again.failure));
		data = again.data;
		onEvent({ type: "stage", stage: "checking" });
		run = await runReader(
			pieces,
			readerInputFor(appId, key, fetchedOf(data), null),
			claimsMode,
		);
		if (run.kind === "contract")
			return answer(
				readerFault(scope, "contract", appName, false, { broke: run.broke }),
			);
		reads = projectDataReadsOf(data, run.outcome);
	}
	/* A failed read of the places the source's text asked for ends the reading only where the
	 * app reads places, which the function decides from the reader's own outcome. */
	const placesFailure = unreadPlacesFailure(data, run.outcome);
	if (placesFailure !== null) return answer(failedRead(placesFailure));
	const first = run.outcome;
	const readerClaims = first.claims;

	if (first.kind === "account") {
		const findings = [
			...unsummarized.findings,
			...first.findings,
			...readingProjectDataFindingsFor(
				data,
				reads,
				null,
				mintingResolver(appId),
			),
		];
		logUnrecognized(scope, findings, first.defects);
		return answer(
			accountOf(findings, appName, false),
			gatherClaimsOf(readerClaims, [], claimsMode),
		);
	}

	const draft = first.draft;
	tally.expressionRounds = draft.facts.expressionRounds;
	const planned = await pieces.at("the project data plan").run(() => {
		const projectFindings = readingProjectDataFindingsFor(
			data,
			reads,
			draft.doc,
			mintingResolver(appId),
		);
		const media = planReadingMedia({
			source,
			appId,
			references: hqMediaReferencesOf(draft.facts),
			runsOn: declaredBy(proposedChoice(choicesOf(draft)).runsOnlyOn),
		});
		return { projectFindings, ...media };
	});
	tally.mediaTotal = planned.plan.files.length;
	const beforeFiles = [
		...unsummarized.findings,
		...planned.projectFindings,
		...planned.media.findings,
	];
	if (beforeFiles.length > 0) {
		/* An account here ends the request before any file is fetched. */
		logUnrecognized(scope, beforeFiles, first.defects);
		return answer(
			accountOf(beforeFiles, appName, false),
			gatherClaimsOf(readerClaims, planned.media.claims, claimsMode),
		);
	}

	/* 7. The files, judged. */
	let plan = planned.plan;
	if (plan.files.length > 0) {
		onEvent({ type: "stage", stage: "checking-media" });
		onEvent({ type: "files", done: 0, total: plan.files.length });
		const judged = await judgeReadingMedia({
			creds,
			plan,
			keep: input.keepMedia,
			onProgress: (done, total) => onEvent({ type: "files", done, total }),
			...(cancel !== undefined && { cancel }),
		});
		if (judged.kind === "failed") return answer(failedRead(judged.failure));
		plan = judged.plan;
		onEvent({ type: "stage", stage: "checking" });
	}

	/* 8 and 9. Everything, with the files' facts. */
	const checked = await checkWith(
		{ appId, key, fetched: fetchedOf(data), media: plan, first },
		pieces,
		tally,
		scope,
	);
	return answer(
		checked.result,
		gatherClaimsOf(readerClaims, checked.mediaClaims, claimsMode),
	);
}

// ---------------------------------------------------------------------------
// Steps 8 and 9
// ---------------------------------------------------------------------------

/**
 * Step 8 and step 9 over facts already fetched and a plan whose every file
 * has a verdict: the reader where it must run, the project data's findings,
 * the files' findings, acceptance, the review and its digest. It makes no
 * request. `first` is step 6's outcome, which a read hands it so the reader
 * runs again only where a file was judged missing; a create's second pass
 * hands it none, so the reader runs again under the published ids and the
 * tables bound under the person's answers. `actorUserId`, where given, joins
 * its log lines to the person.
 */
export async function checkFetched(input: {
	readonly appId: string;
	readonly key: ReadingKey;
	readonly fetched: Fetched;
	readonly media: ReadingMediaPlan;
	readonly first?: ReadOutcome;
	readonly actorUserId?: string;
}): Promise<{
	readonly result: Exclude<GatherResult, { kind: "stop" }>;
	readonly facts: GatherFacts;
}> {
	const pieces = new Pieces();
	const tally: Tally = {
		sourceBytes: Buffer.byteLength(JSON.stringify(input.fetched.source.raw)),
		mediaTotal: input.media.files.length,
		expressionRounds: null,
	};
	const { result } = await checkWith(input, pieces, tally, {
		appId: input.appId,
		projectId: input.key.projectId,
		userId: input.actorUserId ?? null,
		operation: "create",
	});
	return { result, facts: factsOf(pieces, tally) };
}

async function checkWith(
	input: {
		readonly appId: string;
		readonly key: ReadingKey;
		readonly fetched: Fetched;
		readonly media: ReadingMediaPlan;
		readonly first?: ReadOutcome;
	},
	pieces: Pieces,
	tally: Tally,
	scope: LogScope,
): Promise<{
	readonly result: Exclude<GatherResult, { kind: "stop" }>;
	readonly mediaClaims: readonly HqMediaClaim[];
}> {
	const { appId, key, fetched, media: plan } = input;
	const { source, data } = fetched;
	const appName = source.name;
	const none = (
		result: Exclude<GatherResult, { kind: "stop" }>,
		mediaClaims: readonly HqMediaClaim[] = [],
	) => ({ result, mediaClaims });

	const unsummarized = unsummarizedFindings(source, fetched.modules);
	if (unsummarized.app)
		return none(
			accountOf(unsummarized.findings, appName, false) as Exclude<
				GatherResult,
				{ kind: "stop" }
			>,
		);

	/* 8.1 The reader once more, only where it must. */
	const missing = plan.files.some(
		(file) =>
			Object.hasOwn(plan.verdicts, file.key) &&
			plan.verdicts[file.key]?.kind === "missing",
	);
	let read: ReaderRun;
	if (input.first !== undefined && !missing)
		read = { kind: "outcome", outcome: input.first };
	else
		read = await runReader(
			pieces,
			readerInputFor(appId, key, fetched, plan),
			"counts",
		);
	const stage = await pieces.at("the stage").run(() => {
		if (read.kind === "contract")
			return { kind: "contract" as const, broke: read.broke };
		const outcome = read.outcome;
		const reads = projectDataReadsOf(data, outcome);
		if (outcome.kind === "account")
			return {
				kind: "account" as const,
				outcome,
				findings: [
					...outcome.findings,
					...readingProjectDataFindingsFor(
						data,
						reads,
						null,
						mintingResolver(appId),
					),
				],
			};
		const draft = outcome.draft;
		const hqPlan = planReadingMedia({
			source,
			appId,
			references: hqMediaReferencesOf(draft.facts),
			runsOn: declaredBy(proposedChoice(choicesOf(draft)).runsOnlyOn),
		}).media;
		const projectFindings = readingProjectDataFindingsFor(
			data,
			reads,
			draft.doc,
			mintingResolver(appId),
		);
		/* 8.2 The files' findings. */
		const files = readingMediaFindings({
			media: hqPlan,
			plan,
			runsOn: offeredPlatforms(draft),
		});
		return {
			kind: "read" as const,
			outcome,
			draft,
			reads,
			hqPlan,
			projectFindings,
			files,
		};
	});
	if (stage.kind === "contract")
		return none(
			readerFault(scope, "contract", appName, false, {
				broke: stage.broke,
			}) as Exclude<GatherResult, { kind: "stop" }>,
		);
	if (stage.kind === "account") {
		const findings = [...unsummarized.findings, ...stage.findings];
		logUnrecognized(scope, findings, stage.outcome.defects);
		return none(
			accountOf(findings, appName, false) as Exclude<
				GatherResult,
				{ kind: "stop" }
			>,
		);
	}
	const { outcome, draft, reads, hqPlan, projectFindings, files } = stage;
	tally.expressionRounds = draft.facts.expressionRounds;
	/* The plan with every reference the files' verdicts leave out. */
	const judgedPlan: HqMediaPlan = {
		...hqPlan,
		inert: [...hqPlan.inert, ...files.inert],
		claims: [...hqPlan.claims, ...files.claims],
	};
	/* `files.findings` holds what the source alone says of the files too. */
	const findings = [
		...unsummarized.findings,
		...projectFindings,
		...files.findings,
	];
	if (findings.length > 0) {
		logUnrecognized(scope, findings, outcome.defects);
		return none(
			accountOf(findings, appName, files.complete) as Exclude<
				GatherResult,
				{ kind: "stop" }
			>,
			judgedPlan.claims,
		);
	}
	const choices = narrowDeclarationsByMedia(draft.declaration, files.playsOn);
	if (choices.kind !== "choices")
		throw new Error(
			"Every declaration was narrowed away by the files with no finding to say so. readingMediaFindings gives media-not-played-where-app-runs exactly where none is left; look at lib/deployment/reading/projectData/media.ts.",
		);

	/* 8.3 Acceptance. */
	const lookup = readingLookupSnapshot(data, reads);
	const mediaFiles = adoptedMediaFiles(plan);
	const reader = readerInputFor(appId, key, fetched, plan);
	const accepted = await pieces.at("acceptance").steps(
		acceptReadingSteps({
			appId,
			target: { server: key.server, domain: key.domain },
			source,
			modules: fetched.modules,
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
			},
			choices,
			settlements: handOffSettlements(outcome.claims.handOffs, judgedPlan, [
				...projectFindings,
				...files.findings,
			]),
			lookup,
			mediaLeftOut: judgedPlan.inert.length,
			media: { files: mediaFiles, rows: readingMediaRows(plan) },
			heldExpansions: pieces.expansions,
		}),
	);
	if (!accepted.ok) {
		logAcceptanceFailure(scope, accepted, outcome.defects);
		logUnrecognized(scope, accepted.findings, outcome.defects);
		return none(
			accountOf(accepted.findings, appName, true) as Exclude<
				GatherResult,
				{ kind: "stop" }
			>,
			judgedPlan.claims,
		);
	}

	/* 9. A clean read's values: the review and its digest. */
	const identityRows = adoptedIdentityRows(draft.identities, fetched.modules);
	if (!identityRows.ok)
		return none(
			readerFault(scope, "identity-rows", appName, true, {
				why: formWithNoRealId(appId),
			}) as Exclude<GatherResult, { kind: "stop" }>,
			judgedPlan.claims,
		);
	const review = await pieces.at("the review").steps(
		reviewOf({
			appId,
			key,
			fetched,
			draft,
			reads,
			plan,
			judgedPlan,
			playsOn: files.playsOn,
			choices,
			accepted,
			lookup,
			mediaFiles,
			identityRows: identityRows.rows,
		}),
	);
	const reviewDigest = await pieces.at("the review digest").run(() => {
		const contentId = new Map<MediaAssetId, MediaAssetId>(
			mediaFiles.map((file) => [file.assetId, reviewMediaId(file.contentHash)]),
		);
		return reviewDigestOf({
			v: 1,
			review,
			document: canonicalJsonDigest(
				remapAssetRefs(toPersistableDoc(draft.doc), contentId),
			),
			identities: identityRows.rows,
			mediaPaths: assignMediaPaths(
				mediaFiles.map((file) => ({
					...file,
					assetId: reviewMediaId(file.contentHash),
				})),
			),
		});
	});
	return none(
		{
			kind: "clean",
			gathered: {
				fetched,
				draft,
				accepted,
				reads,
				lookup,
				media: plan,
				mediaFiles,
				review,
				reviewDigest,
			},
		},
		judgedPlan.claims,
	);
}

// ---------------------------------------------------------------------------
// The review
// ---------------------------------------------------------------------------

/** The review, a piece at a time: each declaration's plan features, the
 *  baseline the birth will write, and the Project data each its own. */
function* reviewOf(input: {
	readonly appId: string;
	readonly key: ReadingKey;
	readonly fetched: Fetched;
	readonly draft: ReadDraft;
	readonly reads: ReaderProjectDataReads;
	readonly plan: ReadingMediaPlan;
	readonly judgedPlan: HqMediaPlan;
	readonly playsOn: readonly Platform[];
	readonly choices: Extract<DeclarationChoices, { kind: "choices" }>;
	readonly accepted: Extract<AcceptedReading, { ok: true }>;
	readonly lookup: LookupFixtureDataSnapshot;
	readonly mediaFiles: readonly AdoptedMediaFile[];
	readonly identityRows: Parameters<typeof targetWireIdentity>[0];
}): Generator<void, ReadingReview, void> {
	const { appId, key, fetched, draft, plan, choices, accepted } = input;
	const { source } = fetched;
	const doc = draft.doc;
	const target = { server: key.server, domain: key.domain };

	const localization = effectiveAppLocalization(doc.localization);
	const heldFiles = plan.files.filter(
		(file) =>
			Object.hasOwn(plan.verdicts, file.key) &&
			plan.verdicts[file.key]?.kind === "held",
	).length;

	const runsOn: ReadingReview["runsOn"][number][] = [];
	for (const declaration of accepted.declarations) {
		yield;
		runsOn.push({
			runsOnlyOn: declaration.runsOnlyOn,
			splitDatetime: declaration.splitDatetime,
			preselected: declaration.preselected,
			recordedFeatures: adoptionPlanFeatureConfirmations({
				doc: declaration.doc,
				target,
				sourceWebAppsOn: source.cloudcareEnabled,
				sourceHoldsSaveToCase: accepted.sourceHoldsSaveToCase,
			}),
			firstPublish: declaration.firstPublish,
		});
	}
	yield;
	const preselectedAt = accepted.declarations.findIndex(
		(declaration) => declaration.preselected,
	);
	const draftChoices = choicesOf(draft);
	const proposalStands =
		preselectedAt >= 0 &&
		choices.choices[preselectedAt] ===
			draftChoices.choices[draftChoices.proposed];
	const runsOnWhy: ReadingReview["runsOnWhy"] =
		proposalStands && draftChoices.narrowedByHq
			? "web-apps-off-in-hq"
			: proposalStands && draftChoices.keepsWebApps
				? "keeps-web-apps"
				: "content";

	const declared = new Set<Platform>(
		runsOn.flatMap((choice) => declaredBy(choice.runsOnlyOn)),
	);
	const platformsOut = PLATFORMS.filter(
		(platform) => !declared.has(platform),
	).map((platform) => {
		const uses = new Set<PlatformFeatureId>(
			unavailableUses(doc, [platform]).map((use) => use.feature),
		);
		return {
			platform,
			features: PLATFORM_FEATURE_IDS.filter((feature) => uses.has(feature)),
			media: !input.playsOn.includes(platform),
		};
	});

	/* The kept list of the baseline the birth will write, under the preselected declaration. */
	const preselected = accepted.declarations[preselectedAt];
	if (preselected === undefined)
		throw new Error(
			"Acceptance answered declarations with none preselected. Look at lib/deployment/reading/acceptance.ts.",
		);
	const origin = COMMCARE_SERVERS[key.server].baseUrl;
	/* What the baseline the birth writes (`adoptedAppBaselineWrite`) records of
	 * the source and of what Nova owns, a part at a time: its source as stored
	 * and the ownership of its first import, which is all the review reads of
	 * it. */
	yield;
	const normalized = adoptedSourceTree(key.remoteAppId, source);
	yield;
	const prepared = adoptionExportBoundary(
		preselected.doc,
		input.lookup.definitions,
		input.mediaFiles,
		{ origin, domain: key.domain },
	);
	yield;
	const ownership = yield* adoptedBaselineOwnershipSteps({
		remoteAppId: key.remoteAppId,
		source,
		prepared,
		target,
		identity: targetWireIdentity(input.identityRows),
	});
	yield;
	const facts = targetFactsFromSource(normalized, {
		observedAt: fetched.readAt,
		novaOwnsAutoGpsCapture: ownership?.autoGpsCapture === true,
		adopted: true,
	});

	yield;
	const projectReview = projectDataReview(
		fetched.data,
		input.reads,
		doc,
		mintingResolver(appId),
	);

	const datetimeSplit = choices.choices.find((choice) => choice.split);
	return {
		appName: source.name ?? "",
		readAt: fetched.readAt,
		creates: {
			menus: doc.moduleOrder.length,
			forms: Object.keys(doc.forms).length,
			questions: Object.keys(doc.fields).length,
			caseTypes: (doc.caseTypes ?? [])
				.map((caseType) => caseType.name)
				.sort(compareText),
			languages: localization.languageOrder.map((tag) => {
				const code = localization.wireCodes[tag];
				if (code === undefined)
					throw new Error(
						"A reading's document holds a language with no CommCare code, which its localization schema refuses.",
					);
				return code;
			}),
			mediaFiles: heldFiles,
		},
		runsOn,
		runsOnWhy,
		webAppsOnInHq: draft.facts.webAppsOnInHq,
		datetimeQuestions: datetimeSplit?.splits.length ?? 0,
		platformsOut,
		kept: facts === null ? [] : keptListFor(facts),
		tables: projectReview.tables,
		places: projectReview.places,
		mediaLeftOut: input.judgedPlan.inert.length,
		firstPublish: accepted.firstPublish,
	};
}
