/**
 * What a review of the changes made in CommCare HQ to an app Nova publishes
 * there is sent, and what it and a bring-in of those changes answer.
 *
 * Client-safe: every import is a type, but the kinds of
 * `lib/publish/hqChangesKinds.ts`, which are constants re-exported here so a
 * caller reads one module for the vocabulary of both requests.
 */

import type { CommCareServer } from "@/lib/commcare/servers";
import type { DeploymentView } from "@/lib/deployment/actions";
import type { ReadingReview } from "@/lib/deployment/reading/types";
import type { Platform } from "@/lib/domain/platforms";
import type { DriftReference } from "@/lib/publish/driftReference";
import type {
	CasePropertyRename,
	HqChangeHeld,
	HqChangesUnavailable,
} from "@/lib/publish/hqChangesKinds";
import type { CircumstanceFinding, Finding } from "@/lib/publish/hqFindings";

export {
	type CasePropertyRename,
	HQ_CHANGE_HELD,
	HQ_CHANGES_STAGES,
	HQ_CHANGES_UNAVAILABLE,
	type HqChangeHeld,
	type HqChangesStage,
	type HqChangesUnavailable,
} from "@/lib/publish/hqChangesKinds";

/** One app's deployment on one project space, as both requests name it. */
export interface HqChangesKey {
	readonly appId: string;
	readonly server: CommCareServer;
	readonly domain: string;
}

/** What a review of the changes made in CommCare HQ answers. */
export type HqChangesReview =
	/** Nothing to bring in. */
	| {
			readonly kind: "nothing";
			/**
			 * `unchanged`: CommCare HQ's app is the baseline's. `reads-the-same`:
			 * it was saved and reads as the same app. `already-here`: it
			 * changed, and this app already holds that.
			 */
			readonly reason: "unchanged" | "reads-the-same" | "already-here";
			readonly since: DriftReference;
			/**
			 * Where CommCare HQ now keeps what the document doesn't hold, which a
			 * bring-in records and Nova follows (a form's id, a keyed create's
			 * case id prefix, a file's path), as sentences; empty where nothing
			 * moved.
			 */
			readonly hqChanges: readonly string[];
			/** What the next publish changes in CommCare HQ, as sentences. */
			readonly publishChanges: readonly string[];
			/** Null for `unchanged`: there is nothing to record. */
			readonly readingId: string | null;
			readonly reviewDigest: string | null;
	  }
	| {
			readonly kind: "changes";
			readonly requiresReview?: true;
			readonly since: DriftReference;
			/**
			 * Every line of what changed in CommCare HQ, then where CommCare HQ
			 * now keeps what the document doesn't hold, which Nova follows.
			 */
			readonly hqChanges: readonly string[];
			/** Every line of what changed in Nova since; empty where taking the change removes nothing. */
			readonly novaChanges: readonly string[];
			/**
			 * The members other than the reader who made the changes in Nova
			 * since the reference, by name, which the Nova list names under its
			 * lead; empty where none is known or only the reader.
			 */
			readonly madeBy: readonly string[];
			/** The case data lines: none, one, or one for properties and one for case types. */
			readonly caseData: readonly string[];
			readonly publishChanges: readonly string[];
			/**
			 * The digest of CommCare HQ's whole normalized source as read: what a
			 * publish over this change names in its discard
			 * (`RemoteChangeDiscard.observedDigest`).
			 */
			readonly observedDigest: string;
			/** Not empty: using CommCare HQ's version is not offered. */
			readonly renamedInNova: readonly CasePropertyRename[];
			/**
			 * The review entries of the tables the changed app newly reads. One
			 * whose tag meets a Project table asks its choice, answered in the
			 * bring-in's `tableChoices`.
			 */
			readonly tables: ReadingReview["tables"];
			/** The name of the app's Project, which a table's choice names. */
			readonly projectName: string;
			/** Sent back at the bring-in: the ids of a newly read table derive from it. */
			readonly readingId: string;
			readonly reviewDigest: string;
	  }
	| {
			readonly kind: "account";
			readonly findings: readonly Finding[];
			readonly more: number;
			readonly counts: {
				readonly notYet: number;
				readonly never: number;
				readonly fixInHq: number;
			};
	  }
	| {
			readonly kind: "held";
			readonly reason: HqChangeHeld;
			/** For `runs-elsewhere`: where the app runs, and where CommCare HQ's version runs. */
			readonly runs: {
				readonly app: readonly Platform[];
				readonly hq: readonly Platform[];
			} | null;
	  }
	| {
			readonly kind: "unavailable";
			readonly reason: HqChangesUnavailable;
			/**
			 * What the change is measured against, as the deployment's baseline
			 * says (`remoteChanges.ts::driftReferenceOf`): three of the
			 * reasons' sentences name it, and each of those always carries it.
			 * Null where the review found no baseline to say it, which only
			 * `not-published`, `publishing-stopped`, `app-deleted`, `no-reference` and a
			 * bring-in's own defect answer, and none of their sentences names it.
			 */
			readonly since: DriftReference | null;
	  }
	/** CommCare HQ could not be read, or the read is not Nova's to make. */
	| { readonly kind: "stop"; readonly finding: CircumstanceFinding };

/** A review that lists what to bring in, or says there is nothing to. */
export type HqChangesListedReview = Extract<
	HqChangesReview,
	{ readonly kind: "changes" | "nothing" }
>;

/** Every other review: an account, a held change, an unavailable review, a stop. */
export type HqChangesUnlistedReview = Exclude<
	HqChangesReview,
	HqChangesListedReview
>;

/** The `changed` outcome over `now`, carrying `editedBy` only beside a listed review. */
export function changedOutcome(
	now: HqChangesReview,
	editedBy: string | null = null,
): Extract<HqChangesOutcome, { readonly kind: "changed" }> {
	return now.kind === "changes" || now.kind === "nothing"
		? { kind: "changed", now, editedBy }
		: { kind: "changed", now };
}

/** What a bring-in of the changes made in CommCare HQ answers. */
export type HqChangesOutcome =
	| {
			readonly kind: "brought-in";
			readonly seq: number;
			/** Whether the review listed changes made in Nova, which taking it removed. */
			readonly discarded: boolean;
			/** The record, null where Nova could not read it after the bring-in landed. */
			readonly deployment: DeploymentView | null;
	  }
	/**
	 * Nothing in the app changed: Nova recorded what CommCare HQ holds. The
	 * record is null where Nova could not read it after the record landed.
	 */
	| { readonly kind: "recorded"; readonly deployment: DeploymentView | null }
	/**
	 * The app, the baseline or CommCare HQ is not what was reviewed. `now` is
	 * where it stands. A member who moved the app's head is named only beside a
	 * review that lists what to bring in or says there is nothing: every other
	 * review is not one the person can act on in this app, and a review that is
	 * unavailable because the app moved must not name who edits it now.
	 */
	| {
			readonly kind: "changed";
			readonly now: HqChangesListedReview;
			/** The member whose edit moved the head, where that is what changed. */
			readonly editedBy: string | null;
	  }
	| { readonly kind: "changed"; readonly now: HqChangesUnlistedReview }
	/**
	 * The changes would leave the app with what no longer works, and nothing
	 * was taken. The same findings in the two voices of
	 * `lib/doc/userFacingErrors.ts`, in one order: `findings` is the builder's
	 * (`userFacingError`, as the publish dialog's preflight renders the same
	 * export boundary), and `details` is the one MCP and the logs speak
	 * (`ValidationError.message`). A refusal the commit's own gate makes
	 * carries its findings the same way (`BlueprintCommitRejectedError.findings`).
	 * Each list holds every distinct sentence once (`gate.ts::hqChangesGateRefusal`),
	 * so two findings one builder line says are one line there.
	 */
	| {
			readonly kind: "gate";
			readonly findings: readonly string[];
			readonly details: readonly string[];
	  }
	| { readonly kind: "refused"; readonly message: string };
