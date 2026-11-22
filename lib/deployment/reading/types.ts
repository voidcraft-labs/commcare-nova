/**
 * What a bring-in of a CommCare HQ app reads, answers and is sent: the key that
 * names the app, the answer of one read (a stop, an account or a review), the
 * lines of the stream both bring-in routes answer with, the create's body and
 * its answer, and the refusals a route or a create can meet.
 *
 * "Reading" is the code's word for one read of one HQ app. It names a request
 * and the id that request mints, and nothing that is kept; no sentence a
 * person reads says it.
 *
 * Client-safe: its run-time imports are `zod` and constants.
 */

import { z } from "zod";
import {
	COMMCARE_SERVER_IDS,
	type CommCareServer,
} from "@/lib/commcare/servers";
import type { AdoptedAppReceipt } from "@/lib/db/appGenesis";
import type { DeploymentConfirmationKey } from "@/lib/deployment/types";
import { PLATFORMS, type Platform, type PlatformFeatureId } from "@/lib/domain";
import { LOOKUP_UUID_V7_PATTERN } from "@/lib/domain/lookupIds";
import type { FirstPublishView } from "@/lib/publish/firstPublishChangeIds";
import type { CircumstanceFinding, Finding } from "@/lib/publish/hqFindings";
import type { KeptLabelId } from "@/lib/publish/keptValues";
import type { InstallationReviewState } from "../targetIdentity";
import {
	LOOKUP_TABLE_CHOICES,
	type ReviewPlaces,
	type ReviewTable,
} from "./projectData/reviewTypes";

export type { ReviewPlaces, ReviewTable } from "./projectData/reviewTypes";
export { keptTableChoices } from "./projectData/reviewTypes";

// ---------------------------------------------------------------------------
// The key, and what a read answers
// ---------------------------------------------------------------------------

/** One app of one project space, read for one Project. */
export interface ReadingKey {
	readonly projectId: string;
	readonly server: CommCareServer;
	readonly domain: string;
	readonly remoteAppId: string;
}

/** The read route's body. Both routes also hold `domain` to `isValidDomainSlug`. */
export const readingKeySchema = z.strictObject({
	projectId: z.string().min(1).max(255),
	server: z.enum(COMMCARE_SERVER_IDS),
	domain: z.string(),
	remoteAppId: z.string().regex(/^[\w-]{1,255}$/),
});

export type ReadingAnswer =
	/** The read ended at something that is no fact about the app's content. */
	| { readonly kind: "stop"; readonly finding: CircumstanceFinding }
	/** What Nova could not hold, in the app's own order. */
	| {
			readonly kind: "account";
			/** CommCare HQ's name for the app, or null where the app's own read did not complete. */
			readonly appName: string | null;
			/** At most `READING_MAX_LISTED_FINDINGS`, sorted by place, then code. */
			readonly findings: readonly Finding[];
			/** How many findings beyond those the read met. */
			readonly more: number;
			/** Over every finding the read met, the ones past the listed limit too. */
			readonly counts: {
				readonly notYet: number;
				readonly never: number;
				readonly fixInHq: number;
			};
			/** False where the read answered before every referenced file was judged. */
			readonly mediaChecked: boolean;
	  }
	/** What creating will make. */
	| {
			readonly kind: "review";
			/** Sent back at creation. Every id of the app derives from it. */
			readonly readingId: string;
			readonly reviewDigest: string;
			readonly review: ReadingReview;
	  };

/** The most findings an account lists; `more` counts the rest. */
export const READING_MAX_LISTED_FINDINGS = 2000;

// ---------------------------------------------------------------------------
// The review
// ---------------------------------------------------------------------------

/** One way the app may declare where it runs, as the review offers it. */
export interface ReadingDeclarationChoice {
	readonly removesFiles?: readonly string[];
	/** Null is Web Apps and Android. */
	readonly runsOnlyOn: Platform | null;
	/** True where choosing this splits the app's date-and-time questions. */
	readonly splitDatetime: boolean;
	readonly preselected: boolean;
	/** The plan features Nova records as already in use under this choice. */
	readonly recordedFeatures: readonly DeploymentConfirmationKey[];
	/** Features retained in the app that HQ source cannot establish for its plan. */
	readonly installationPlanChecks?: readonly (
		| "installation-profiles"
		| "practice-workers"
	)[];
	/** What a first publish changes where this choice is made. */
	readonly firstPublish: FirstPublishView;
}

/** What creating will make. Everything here is shown to the person or is a count of what is. */
export interface ReadingReview {
	/** The named installations and destination-scoped accounts accepted at birth. */
	readonly installations?: readonly (InstallationReviewState & {
		readonly key: string;
	})[];
	/** CommCare HQ's name for the app: the default of the name choice. */
	readonly appName: string;
	/** ISO 8601: when the read ended. The kept list's date. Not in the digest. */
	readonly readAt: string;
	readonly creates: {
		readonly menus: number;
		readonly forms: number;
		readonly questions: number;
		readonly caseTypes: readonly string[];
		/** The app's languages, as CommCare HQ's codes, default first. */
		readonly languages: readonly string[];
		readonly mediaFiles: number;
	};
	/** At least one, exactly one preselected. */
	readonly runsOn: readonly ReadingDeclarationChoice[];
	/** Why the preselected choice is the one proposed. */
	readonly runsOnWhy: "content" | "web-apps-off-in-hq" | "keeps-web-apps";
	/** Whether Web Apps is on for the app in CommCare HQ. */
	readonly webAppsOnInHq: boolean;
	/** How many date-and-time questions a choice that splits changes; 0 where no choice splits. */
	readonly datetimeQuestions: number;
	/** Each platform no offered choice declares, with what keeps the app off it. */
	readonly platformsOut: readonly {
		readonly platform: Platform;
		/** The distinct features of `platformUses.ts::unavailableUses` for that platform, in table order. */
		readonly features: readonly PlatformFeatureId[];
		/** A referenced file does not play there. */
		readonly media: boolean;
	}[];
	/** What stays as it is in CommCare HQ. */
	readonly kept: readonly KeptLabelId[];
	/** The lookup tables the app reads, by tag. */
	readonly tables: readonly ReviewTable[];
	/** The places the app's logic reads, or null where it reads none. */
	readonly places: ReviewPlaces | null;
	/** Count of omitted references with no worker-visible effect. An omitted icon that
	 *  Web Apps showed broken or Android required to install has its own worker-facing
	 *  first-publish disclosure (`broken-pictures-removed`). */
	readonly mediaLeftOut: number;
	/** The preselected choice's list: `runsOn`'s preselected entry holds the same. */
	readonly firstPublish: FirstPublishView;
}

// ---------------------------------------------------------------------------
// The create
// ---------------------------------------------------------------------------

/** The UUIDv7 layout: the same expression as `lib/domain/lookupIds.ts::LOOKUP_UUID_V7_PATTERN`. */
export const READING_ID_PATTERN: RegExp = LOOKUP_UUID_V7_PATTERN;

/** The create route's body: the key, what the person reviewed, and their answers. */
export const bringInInputSchema = z.strictObject({
	projectId: z.string().min(1).max(255),
	server: z.enum(COMMCARE_SERVER_IDS),
	domain: z.string(),
	remoteAppId: z.string().regex(/^[\w-]{1,255}$/),
	/** The reading the person reviewed. */
	readingId: z.string().regex(READING_ID_PATTERN),
	/** The digest of the review the person is answering. */
	reviewDigest: z.string().regex(/^[0-9a-f]{64}$/),
	appName: z.string(),
	runsOnlyOn: z.enum(PLATFORMS).nullable(),
	splitDatetime: z.boolean(),
	/** The answer for each table whose review entry asks a choice, by tag. */
	tableChoices: z.record(z.string(), z.enum(LOOKUP_TABLE_CHOICES)),
});
export type BringInInput = z.infer<typeof bringInInputSchema>;

export type CreateAnswer =
	| { readonly kind: "created"; readonly receipt: AdoptedAppReceipt }
	/** The app or the Project is not what was reviewed. `now` is where it stands. */
	| { readonly kind: "changed"; readonly now: ReadingAnswer }
	/** A Project table changed under the birth. The caller reads the app again. */
	| { readonly kind: "read-again" }
	/** One of Nova's own checks stopped the create though the review matched. */
	| { readonly kind: "check-failed"; readonly finding: CircumstanceFinding }
	/** A stop the person can clear. The review they hold stands. */
	| { readonly kind: "held"; readonly finding: CircumstanceFinding }
	| { readonly kind: "refused"; readonly refusal: ReadingRefusal };

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * Every refusal of a bring-in: the two a route meets before its stream opens,
 * and the six that only ever ride a `CreateAnswer`. `publish_in_flight` is a
 * create whose claim met a write another Nova app let out to the HQ app that
 * has not settled: the review stands, and the person can try again shortly. `no_project_access` is
 * both: the route's 403, and the birth's own check of `edit` after the stream
 * is open.
 */
export const READING_REFUSALS = [
	"no_project_access",
	"invalid_input",
	"name_missing",
	"choice_not_offered",
	"choice_missing",
	"project_changed",
	"app_unavailable",
	"publish_in_flight",
] as const;
export type ReadingRefusal = (typeof READING_REFUSALS)[number];

/** The status a route answers a refusal with: 200 where it rides the stream's last line. */
export const READING_REFUSAL_STATUS = {
	no_project_access: 403,
	invalid_input: 400,
	name_missing: 200,
	choice_not_offered: 200,
	choice_missing: 200,
	project_changed: 200,
	app_unavailable: 200,
	publish_in_flight: 200,
} as const satisfies Record<ReadingRefusal, 200 | 400 | 403>;

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

/** What a bring-in is doing, in the order a create names them. */
export const READING_STAGES = [
	"connecting",
	"reading-app",
	"reading-project-data",
	"checking",
	"checking-media",
	"bringing-in-media",
	"creating",
] as const;
export type ReadingStage = (typeof READING_STAGES)[number];

/** One line of a bring-in route's stream. */
export type ReadingEvent =
	| { readonly type: "stage"; readonly stage: ReadingStage }
	/** With `checking-media` and `bringing-in-media`: files that have a verdict, or are published,
	 *  of those planned. */
	| { readonly type: "files"; readonly done: number; readonly total: number }
	/** Always the last line. */
	| { readonly type: "done"; readonly answer: ReadingAnswer | CreateAnswer }
	/** Always the last line: something was thrown that is no answer. It is logged. */
	| { readonly type: "failed" };
