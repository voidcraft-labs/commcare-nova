import { INSTALLATION_REVIEW_TOKEN } from "@/lib/publish/installationReviewToken";
import { toolText } from "../paging";
import { LARGE_RESULT_META } from "../resultSize";
/**
 * `nova.upload_app_to_hq`: publish an editable Project app's blueprint to CommCare
 * HQ, into a project space the user's API key can reach.
 *
 * Scope: `nova.hq.write` (per-tool, in addition to the route-layer
 * `nova.read` + `nova.write` floor). HQ access is orthogonal to
 * Nova-internal read/write; see `lib/mcp/scopes.ts` for the full
 * enforcement model.
 *
 * The first publish to a project space creates an empty app there, which
 * the deployment ledger records, and then fills it in place; publishing
 * again sends that mapping's id so HQ updates the same app in place, and
 * the payload's `hq_app_action` says which happened (`created` also for a
 * publish that fills the empty app an earlier try left). The create path
 * also runs after the mapped app was deleted on HQ (`remote_app_missing`
 * below). The decision is the shared publish lifecycle's, made from the
 * ledger; the request shape carries no say in it.
 *
 * The upload is media-ON and two-phase: import the media-bearing HQ JSON
 * first (forms carry `jr://file/commcare/...` itext references), then
 * upload each asset's bytes against the app so HQ maps them by path.
 * A media failure leaves the app intact and surfaces as a
 * warning; it never fails the upload.
 *
 * The app's Project data goes before the app's content: content whose
 * selects read a table that is not there yet installs and misbehaves. On a
 * first publish the empty app is made first, and it holds nothing that reads
 * a table. That step is not optional and has no argument of its own, but it can refuse
 * (`hq_resource_conflict`), and it reports through the `resources_pushed`
 * progress stage when it lands.
 *
 * Target space (the optional `domain` argument):
 *   An HQ API key can reach several project spaces (an unscoped key reaches
 *   every space its owner belongs to). Omitting `domain` works only when the
 *   key reaches exactly one space: that sole space is used. A multi-space key
 *   must pass `domain` explicitly: there is no stored default, so a multi-space
 *   key with no `domain` is `domain_ambiguous` (see below); the tool refuses
 *   to guess. Use `get_hq_connection` to list the reachable spaces
 *   (`available_domains`) and ask the user which one.
 *
 * Actionable `error_type` values, in the order their gates fire, each
 * producing a distinct envelope so MCP clients can branch cleanly:
 *
 *   1. `scope_missing`:           the access token lacks `nova.hq.write`.
 *                                 Checked by its registration
 *                                 (`registerScopedTool`) before any
 *                                 app-state read.
 *   2. `hq_not_configured`:       the user has not stored CommCare HQ
 *                                 credentials in Settings.
 *   3. `domain_not_authorized`:   `domain` was supplied but the key can't
 *                                 reach it; the message names the reachable
 *                                 set.
 *   4. `domain_ambiguous`:        multi-space key with no `domain` supplied;
 *                                 the tool names the spaces and asks the
 *                                 caller to choose rather than guessing.
 *   5. `invalid_input`:           the zero-tolerance boundary gate found
 *                                 validator issues (a soundness error,
 *                                 unfinished completeness work, or a stale
 *                                 media reference). Fires after domain
 *                                 resolution, before the HQ network call;
 *                                 the message carries each rule's
 *                                 actionable text.
 *   6. `project_space_incompatible`: the project space is missing support the
 *                                 app requires, or Nova could not confirm it.
 *                                 Nothing was sent; the semantic report names
 *                                 every blocker and its next step.
 *   7. `hq_resource_conflict`:    the project space already holds a lookup
 *                                 table or a place this app's data would
 *                                 land on, and Nova did not make it.
 *                                 Nothing was sent. Change the name in
 *                                 Nova, or name the exact Nova ids in
 *                                 `adopt_resources` to take the existing
 *                                 ones over. Never resolved by guessing:
 *                                 a shared name is not evidence of
 *                                 ownership.
 *   7a. `hq_table_content_unsupported`: a lookup table under one of
 *                                 this app's export tags holds in CommCare
 *                                 HQ what Nova's push would remove. Nothing
 *                                 was sent, and neither `adopt_resources`
 *                                 nor `discard_hq_changes` resolves it: the
 *                                 message names each table, and a new export
 *                                 tag in Project data is the way out.
 *   7b. `hq_managed_data_changed`: a lookup table this app reads is
 *                                 managed in CommCare HQ there and changed
 *                                 in a way the app depends on. Nova stopped
 *                                 it before sending anything; the message
 *                                 names each table, what changed and what
 *                                 the user can do.
 *   7c. `managed_table_handed_back`: a lookup table this app reads was
 *                                 handed back to CommCare HQ while the
 *                                 upload got ready. Nothing of the lookup
 *                                 tables or the app's content was sent;
 *                                 uploading again leaves that table alone.
 *   8. `hq_organization_mismatch`: the app's places do not fit the levels
 *                                 the project space defines, so CommCare
 *                                 HQ would refuse them. Nothing was sent,
 *                                 and no adoption resolves it: the message
 *                                 names each place and what has to change,
 *                                 in Nova or on CommCare HQ.
 *   9. `hq_app_state_unknown`:    Nova could not safely read the HQ app's
 *                                 source before sending its content, or the
 *                                 app there is a linked app Nova does not
 *                                 update. Its content was not sent; the
 *                                 message says whether this call left an
 *                                 empty app there.
 *  10. `remote_app_missing`:      HQ reported the mapped app deleted there.
 *                                 Nothing was changed; calling again creates
 *                                 a fresh app and supersedes the dead
 *                                 mapping.
 *  11. `hq_changed`:              the app, a lookup table or a place this
 *                                 app publishes is not what CommCare HQ
 *                                 held when Nova last published it.
 *                                 Found in preflight, nothing was sent;
 *                                 `remote_changes` lists each with what
 *                                 changed, the state it was read in, and
 *                                 `since`, what it is measured against: the
 *                                 last publish, the bring-in, or the last
 *                                 bring-in of changes. The app's own change
 *                                 says in `can_bring_in` whether
 *                                 `bring_in_hq_changes` can take it instead.
 *                                 Naming each back in `discard_hq_changes`
 *                                 with that state, once the user said to
 *                                 write over it, is the one way past it.
 *                                 Found after the tables and places were
 *                                 pushed, the app's content was not sent,
 *                                 `remote_changes` is empty and calling
 *                                 again lists what changed.
 *  12. `hq_confirmation_needed`:  the app needs something of the project
 *                                 space no API key reads (a plan feature,
 *                                 the flat location list, a Connect
 *                                 forwarder, Sync Cases On Form Entry
 *                                 turned off, CommCare Supply turned off)
 *                                 and nobody confirmed it there.
 *                                 Nothing was sent; `confirmations_needed`
 *                                 lists each with why the app needs it.
 *                                 Naming each back once the user said the
 *                                 project space has it is the one way past
 *                                 it.
 *  12a. `hq_web_apps_change`:     the app's Web App setting on CommCare HQ
 *                                 differs from where the app runs. Nothing
 *                                 was sent; `web_apps_change` names `from`,
 *                                 `to` and `changed_in_hq`. Sending
 *                                 `confirm_web_apps` with that `to`, once
 *                                 the user said to change it, is the one
 *                                 way past it.
 *  13. `hq_app_version_below_floor`: the app on CommCare HQ is set to a
 *                                 CommCare version below the one Nova's
 *                                 apps need. Nothing of its content was
 *                                 sent; `url` is the app's page there.
 *  13d. `hq_build_profile_language_missing`: an application profile of
 *                                 the app on CommCare HQ includes a
 *                                 language the app no longer has, and no
 *                                 API key can change one. Nothing of its
 *                                 content was sent; `message` names each
 *                                 profile and language on its own line, and
 *                                 `url` is the app's page there.
 *  13a. `hq_plan_lacks_web_apps`: CommCare HQ made the new app with Web
 *                                 Apps off, so the project space's plan has
 *                                 no Web Apps. Only the empty app was made,
 *                                 and Nova withdrew the `web-apps` plan
 *                                 feature's confirmation.
 *  13b. `hq_placement_moves_changed`: the case changes `accept_placement_moves`
 *                                 named are no longer the ones Nova would
 *                                 move, because the app changed since the
 *                                 offer. Nothing was moved or sent;
 *                                 `placement_moves` is the offer as it
 *                                 stands now.
 *  13c. `app_changed_while_publishing`: the app kept changing while Nova
 *                                 recorded where CommCare HQ keeps its case
 *                                 changes. Nothing was sent; uploading again
 *                                 once the edits settle goes on.
 *  13d. `publishing_stopped`:     someone stopped publishing the app to
 *                                 that project space while this upload ran,
 *                                 so Nova recorded nothing more of it; the
 *                                 message says whether CommCare HQ may hold
 *                                 part of it.
 *  14. `hq_upload_failed`:       `importApp` returned a non-success
 *                                 response (HQ rejected the upload or
 *                                 returned 5xx), or CommCare HQ would not
 *                                 take the app's lookup tables or places.
 *                                 A thrown
 *                                 transport fault goes through the shared
 *                                 MCP classifier.
 *
 * (`not_found` from the ownership pre-gate is also possible but not
 * actionable: it collapses cross-tenant probes to the same shape as
 * a missing app.)
 *
 * Placements: the first upload of a case change records where CommCare HQ
 * keeps it, as a `publish-placement` change to the saved app, before
 * anything is sent. Every answer the publish gives carries `placements`
 * (`recorded`, and how many of them `moved` because the caller accepted an
 * offer) and `placement_moves`: the case changes Nova can move so the
 * project space can take the app, named by form, change and sentence and
 * never by wire path, or null. Accepting the offer is
 * `accept_placement_moves` with its `reason` and `digest`.
 *
 * The closed server catalog (`lib/commcare/servers.ts`, resolved through
 * the stored connection's `server`) is the one SSRF boundary; the resolved
 * domain is always one the stored key already reached (probed at
 * save/refresh and re-checked here against the reachable set), so it
 * cannot smuggle path components into the URL `importApp` constructs.
 *
 * Pre-gate ordering (scope → Project edit access → settings/domain) is defensive:
 * each gate leaks strictly less information than the one after it, so
 * the earliest-applicable rejection always closes more probe channels
 * than it opens.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveHqTarget } from "@/lib/db/settings";
import { LOOKUP_ADOPTION_NOTE } from "@/lib/deployment/remoteChanges";
import { activeRemoteApp } from "@/lib/deployment/resources";
import { landedDeploymentKept, publishAppToHq } from "@/lib/deployment/service";
import {
	type DeploymentConfirmationKey,
	type DeploymentConfirmationNeeded,
	type DeploymentRemoteChange,
	type DeploymentResourceConflict,
	PLAN_FEATURE_ID_LIST,
	type PublishPlacements,
} from "@/lib/deployment/types";
import { orderedOrganizationLevels } from "@/lib/domain";
import { log } from "@/lib/logger";
import {
	acceptPlacementMovesSchema,
	type PlacementMoveOfferView,
} from "@/lib/publish/placementMoves";
import {
	LOGO_UPLOAD_STEP_TEXT,
	type PlanFeatureId,
} from "@/lib/publish/planFeatures";
import type { ProjectSpaceCompatibilityReport } from "@/lib/publish/projectSpaceCompatibility";
import type { WebAppsChange } from "@/lib/publish/webApps";
import { initMcpCall } from "../context";
import {
	type McpErrorType,
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
	type UploadErrorType,
} from "../errors";
import { loadAppBlueprint } from "../loadApp";
import { deriveRunId } from "../runId";
import { registerScopedTool } from "../scopedTool";
import { assertScope, SCOPES } from "../scopes";
import type { ToolContext } from "../types";
import { describeDeployment } from "./deploymentProjection";
import { landedNovaRevisions, landedResourceIdentities } from "./landedReads";

/**
 * Canonical `error_type` strings for each upload-gate failure mode.
 * `satisfies Record<UploadErrorType, UploadErrorType>` forces every
 * variant an upload gate can emit to appear as a key: adding a new
 * variant to the union without a matching entry here is a compile
 * error, so the wire taxonomy cannot silently drift.
 *
 * The handler shares this compile-checked record; protocol tests assert
 * independently authored wire literals.
 *
 * These tags are part of the MCP wire contract: any client branching
 * on an upload error expects exactly these values. Treat them as public API.
 */
export const UPLOAD_ERROR_TAGS = {
	/** The user has no stored HQ credentials. */
	hq_not_configured: "hq_not_configured",
	/** HQ rejected the upload (HQ-side failure, post-validation). */
	hq_upload_failed: "hq_upload_failed",
	/** Supplied `domain` is outside the key's reachable set. */
	domain_not_authorized: "domain_not_authorized",
	/** Multi-space key with no `domain` supplied; caller must choose. */
	domain_ambiguous: "domain_ambiguous",
	/** The mapped HQ app is gone; the next call creates a fresh one. */
	remote_app_missing: "remote_app_missing",
	/** The target already holds a same-named resource Nova didn't make. */
	hq_resource_conflict: "hq_resource_conflict",
	/** A lookup table HQ holds under this app's tag has content Nova's push would remove. */
	hq_table_content_unsupported: "hq_table_content_unsupported",
	/** A table CommCare HQ manages there changed in a way the app depends on. */
	hq_managed_data_changed: "hq_managed_data_changed",
	/** A table the app reads was handed back to CommCare HQ while the upload got ready. */
	managed_table_handed_back: "managed_table_handed_back",
	/** The app's organization does not fit the target's levels. */
	hq_organization_mismatch: "hq_organization_mismatch",
	/** Required target support is missing or could not be verified. */
	project_space_incompatible: "project_space_incompatible",
	/** The current HQ app source could not be read safely for an update. */
	hq_app_state_unknown: "hq_app_state_unknown",
	/** Something this app publishes changed in CommCare HQ since Nova's last publish. */
	hq_changed: "hq_changed",
	/** The app needs something of the project space a person has not confirmed. */
	hq_confirmation_needed: "hq_confirmation_needed",
	/** The app's Web App setting on CommCare HQ differs from where the app runs. */
	hq_web_apps_change: "hq_web_apps_change",
	/** The app on CommCare HQ is set to a CommCare version below the floor. */
	hq_app_version_below_floor: "hq_app_version_below_floor",
	/** An application profile on CommCare HQ includes a language the app no longer has. */
	hq_build_profile_language_missing: "hq_build_profile_language_missing",
	hq_installation_profile_review: "hq_installation_profile_review",
	/** CommCare HQ made the new app with Web Apps off, so the plan has no Web Apps. */
	hq_plan_lacks_web_apps: "hq_plan_lacks_web_apps",
	/** The app kept changing while Nova recorded where CommCare HQ keeps its case changes. */
	app_changed_while_publishing: "app_changed_while_publishing",
	/** The case changes the caller accepted moving are no longer the ones Nova would move. */
	hq_placement_moves_changed: "hq_placement_moves_changed",
	/** Someone stopped publishing the app to that project space while this upload ran. */
	publishing_stopped: "publishing_stopped",
} as const satisfies Record<UploadErrorType, UploadErrorType>;

const CONFIRM_DESCRIPTION =
	"Send only after an `hq_confirmation_needed` refusal named them and the user said yes to each.";

/**
 * What every answer says of where CommCare HQ keeps the app's case changes:
 * the placements this call recorded, and the moves Nova offers, if any. A
 * move is named by its form, the change in words and the whole sentence a
 * person reads, never by a wire path.
 */
interface PlacementAnswer {
	readonly placement_moves: PlacementMovesAnswer | null;
	readonly placements: { readonly recorded: number; readonly moved: number };
}

/** A move offer as MCP serves it: what a caller shows and what it sends back. */
export interface PlacementMovesAnswer {
	readonly reason: PlacementMoveOfferView["reason"];
	readonly digest: string;
	readonly moves: readonly {
		readonly form: string;
		readonly change: string;
		readonly sentence: string;
	}[];
}

/**
 * A move offer in MCP's words. `check_project_space_compatibility` serves
 * the same shape, so the offer a caller saw there is the one it accepts here.
 */
export function placementMovesAnswer(
	offer: PlacementMoveOfferView | null,
): PlacementMovesAnswer | null {
	return offer === null
		? null
		: {
				reason: offer.reason,
				digest: offer.digest,
				moves: offer.moves.map((move) => ({
					form: move.form,
					change: move.change,
					sentence: move.sentence,
				})),
			};
}

function placementAnswer(
	placements: PublishPlacements,
	offer: PlacementMoveOfferView | null,
): PlacementAnswer {
	return {
		placement_moves: placementMovesAnswer(offer),
		placements: { recorded: placements.recorded, moved: placements.moved },
	};
}

/** The answer of a gate that stops before the publish runs: nothing recorded. */
const NOTHING_RECORDED = placementAnswer({ recorded: 0, moved: 0 }, null);

/**
 * Build an MCP error envelope for a failed upload gate.
 *
 * Gates return a structured envelope directly (rather than throwing a
 * tagged error to be caught and discriminated elsewhere) so every
 * gate's exit path has the same shape: `makeGateError` builds the full
 * MCP result in one place.
 *
 * The JSON content carries both the machine-readable `error_type` (for
 * model branching) and the user-actionable `message` (for display).
 */
function makeGateError(
	errorType: Extract<McpErrorType, UploadErrorType | "invalid_input">,
	message: string,
	appId: string,
	answer: PlacementAnswer,
): McpToolErrorResult {
	return {
		isError: true,
		content: [
			{
				type: "text",
				text: JSON.stringify({
					error_type: errorType,
					message,
					app_id: appId,
					...answer,
				}),
			},
		],
	};
}

/**
 * Build the name-clash envelope, which carries its resources structurally.
 *
 * Every other gate answers with a sentence because a sentence is all the
 * caller can act on. This one is different: the client has to put a choice
 * to the user per resource and then send exact ids back, so the ids travel
 * as data rather than being spelled out in prose for the client to parse
 * back.
 */
function makeConflictError(
	message: string,
	appId: string,
	conflicts: readonly DeploymentResourceConflict[],
	answer: PlacementAnswer,
): McpToolErrorResult {
	return {
		isError: true,
		content: [
			{
				type: "text",
				text: JSON.stringify({
					error_type: UPLOAD_ERROR_TAGS.hq_resource_conflict,
					message,
					app_id: appId,
					resource_conflicts: conflicts.map((conflict) => ({
						kind: conflict.kind,
						nova_resource_id: conflict.novaResourceId,
						name: conflict.name,
						hq_name: conflict.identity,
						hq_id: conflict.remoteId,
					})),
					...(conflicts.some(
						(conflict) => conflict.kind === "lookup-table",
					) && {
						adoption_note: LOOKUP_ADOPTION_NOTE,
					}),
					...answer,
				}),
			},
		],
	};
}

/**
 * Build the envelope for a change made in CommCare HQ, which carries each
 * change structurally.
 *
 * Like the name clash, the caller's one move past it needs exact data: put
 * each listed change to the user, then send its kind, id and observed
 * digest back in `discard_hq_changes`. The digest binds the user's answer
 * to the state they were shown, so it travels as data, never as prose. A
 * stop during the resource push lists nothing: calling again reads CommCare
 * HQ afresh and lists what changed then.
 */
function makeRemoteChangesError(
	message: string,
	appId: string,
	changes: readonly DeploymentRemoteChange[],
	answer: PlacementAnswer,
): McpToolErrorResult {
	return {
		isError: true,
		content: [
			{
				type: "text",
				text: JSON.stringify({
					error_type: UPLOAD_ERROR_TAGS.hq_changed,
					message,
					app_id: appId,
					remote_changes: changes.map((change) => ({
						kind: change.kind,
						nova_resource_id: change.novaResourceId,
						name: change.name,
						hq_name: change.identity,
						parts: change.parts,
						note: change.note,
						observed_digest: change.observedDigest,
						baseline_known: change.baselineKnown,
						/* What the change is measured against: the last publish, the
						 * bring-in at `at`, or the last bring-in of changes. */
						since: change.since,
						/* Whether `read_hq_changes` can read this change and
						 * `bring_in_hq_changes` take it: the app's own change over a
						 * usable pair, and never a table's or a place's. */
						can_bring_in: change.canBringIn,
					})),
					...answer,
				}),
			},
		],
	};
}

/**
 * Build the envelope for what a person has to confirm about the project
 * space. Like the name clash, the caller's one move past it needs exact
 * data: put each item to the user with its reasons, then send back the
 * ones they said the project space has.
 */
function makeConfirmationError(
	message: string,
	appId: string,
	needed: readonly DeploymentConfirmationNeeded[],
	answer: PlacementAnswer,
): McpToolErrorResult {
	return {
		isError: true,
		content: [
			{
				type: "text",
				text: JSON.stringify({
					error_type: UPLOAD_ERROR_TAGS.hq_confirmation_needed,
					message,
					app_id: appId,
					confirmations_needed: needed.map((item) => ({
						kind: item.kind,
						subject: item.subject,
						label: item.label,
						plans: item.plans,
						consequence: item.consequence,
						reasons: item.reasons,
						where_missing: item.whereMissing,
					})),
					...answer,
				}),
			},
		],
	};
}

/**
 * Build the envelope for the Web Apps question, which carries the change
 * structurally: the caller relays the message, and sends `confirm_web_apps`
 * with exactly `to` once the user says to change the setting.
 */
function makeWebAppsChangeError(
	message: string,
	appId: string,
	change: WebAppsChange,
	answer: PlacementAnswer,
): McpToolErrorResult {
	return {
		isError: true,
		content: [
			{
				type: "text",
				text: JSON.stringify({
					error_type: UPLOAD_ERROR_TAGS.hq_web_apps_change,
					message,
					app_id: appId,
					web_apps_change: {
						from: change.from,
						to: change.to,
						changed_in_hq: change.changedInHq,
					},
					...answer,
				}),
			},
		],
	};
}

/** The confirmations an MCP call names, as the publish takes them. */
function confirmationKeys(args: {
	readonly confirm_plan_features?: readonly PlanFeatureId[];
	readonly confirm_flat_location_fixture?: boolean;
	readonly confirm_connect_forwarder?: boolean;
	readonly confirm_form_entry_sync_off?: boolean;
	readonly confirm_commtrack_off?: boolean;
}): DeploymentConfirmationKey[] {
	return [
		...(args.confirm_plan_features ?? []).map(
			(subject): DeploymentConfirmationKey => ({
				kind: "plan-feature",
				subject,
			}),
		),
		...(args.confirm_flat_location_fixture === true
			? [{ kind: "flat-location-fixture" } as const]
			: []),
		...(args.confirm_connect_forwarder === true
			? [{ kind: "connect-forwarder" } as const]
			: []),
		...(args.confirm_form_entry_sync_off === true
			? [{ kind: "form-entry-sync-off" } as const]
			: []),
		...(args.confirm_commtrack_off === true
			? [{ kind: "commtrack-off" } as const]
			: []),
	];
}

/** Compatibility refusals carry the semantic report as structured data so a
 * client can relay the app capability and next step without parsing prose. */
function makeCompatibilityError(
	message: string,
	appId: string,
	report: ProjectSpaceCompatibilityReport,
	answer: PlacementAnswer,
): McpToolErrorResult {
	return {
		isError: true,
		content: [
			{
				type: "text",
				text: JSON.stringify({
					error_type: UPLOAD_ERROR_TAGS.project_space_incompatible,
					message,
					app_id: appId,
					project_space_compatibility: report,
					...answer,
				}),
			},
		],
	};
}

/**
 * Register the `upload_app_to_hq` tool on an `McpServer`.
 *
 * The handler allocates its `LogWriter` + `McpContext` AFTER the
 * pre-network gates pass. A missing-creds / ambiguous-domain call therefore
 * never allocates a log writer it has nothing to flush. The blueprint load
 * + expand + `importApp` sit inside a `try`/`finally` so the writer drains
 * whether the HQ call succeeds, returns a non-success envelope, or throws.
 */
export function registerUploadAppToHq(
	server: McpServer,
	ctx: ToolContext,
): void {
	registerScopedTool(
		server,
		ctx,
		"upload_app_to_hq",
		{
			_meta: LARGE_RESULT_META,
			description:
				"Upload an app you can edit in its Project to CommCare HQ. Call `get_hq_connection` first to list reachable spaces (`available_domains`); when there are several, ask the user which one and never choose for them. Before asking for confirmation, call `check_project_space_compatibility` with the explicit chosen domain and relay its friendly capability report. Pass that same `domain` here. You can omit it only when the key reaches exactly one space; a multi-space key with no `domain` returns `domain_ambiguous` and never guesses. This upload performs its own final authoritative compatibility check immediately before remote writes: required support that is missing or could not be verified returns `project_space_incompatible` with `project_space_compatibility`, while a performance advisory never blocks. The first upload creates the app there; uploading again updates that same HQ app in place, and `hq_app_action` says which happened. Where Nova stopped publishing the app to that project space, an upload makes a new app beside the one that stays there, which `check_project_space_compatibility` says in `new_app_beside` before the upload. If the current HQ app source cannot be read safely before an update, the call returns `hq_app_state_unknown` and leaves the existing HQ app unchanged. If an installation profile needs an edit in the project space, show the complete hq_installation_profile_review message and its review_url. Follow any Read the next part choice until the complete review has been disclosed. Use the replacement_choices labels to browse Nova installations and their matching installations in the project space. Send the chosen navigation token to see that page. Ask the user to confirm the exact destination ID, languages and worker before sending a binding choice. Ask the user to confirm a newly selected practice worker before sending confirm_installation_profiles with the returned confirmation. If an application profile of the app on CommCare HQ includes a language the app no longer has, the call returns `hq_build_profile_language_missing` before sending the app's content: relay the `message` and its `url`, and upload again once the user has changed the profile there. If the linked app was deleted there, the call returns `remote_app_missing`; uploading again then creates a fresh one. If the app, a lookup table or a place it publishes changed in CommCare HQ since Nova last published it, the call returns `hq_changed` before sending anything: show the user each entry of `remote_changes` (its `name`, `hq_name` and `parts`, or that Nova couldn't tell what changed when `baseline_known` is false) and send them back in `discard_hq_changes` only for the ones the user said to write over. If the app changed while Nova was publishing its lookup tables and places, `hq_changed` comes after those were sent and before the app's content, with `remote_changes` empty; uploading again lists what changed. A success after such a publish can carry `app_preview_note`; relay it. Refreshing a lookup table or places managed in CommCare HQ during upload also requires HQ Import. If a lookup table the app reads is managed in CommCare HQ and changed there in a way the app depends on, the call returns `hq_managed_data_changed` before sending anything: relay the `message`, which names each table, what changed and what the user can do, and upload again once that is done. To publish Nova's copy of a table instead, the user can hand it to Nova with `set_lookup_table_management`: show what that does and ask first. `managed_table_handed_back` means a table was handed back to CommCare HQ while the upload was getting ready, and Nova stopped before sending any lookup table or the app's content: upload again, and Nova leaves that table as it is. An app brought in from CommCare HQ updates the app it came from, keeping every menu's and form's ID there. `hq_changed` then measures changes since the app was brought in: each change's `since` says which (`published`, `brought-in` with `at`, or `changes-brought-in`), and a date in a message is the UTC day. When the app's change has `can_bring_in` true, you can read what changed with `read_hq_changes` and bring it in with `bring_in_hq_changes`, or publish over it by naming it in `discard_hq_changes`. Ask the user which. `publishing_stopped` means someone stopped publishing this app to that project space while the upload was getting ready; relay the `message`, which says whether anything was sent, and do not upload again unless the user wants a new app there. If the app needs something of the project space that no API key can read (a plan feature, the flat location list, a Connect forwarder, Sync Cases On Form Entry turned off, CommCare Supply turned off) and nobody has confirmed it there, the call returns `hq_confirmation_needed` before sending anything: show the user each entry of `confirmations_needed` (its `label`, `plans`, `consequence`, `reasons` and `where_missing`, what the user can do where the project space lacks it) and send back only the ones the user said the project space has, in `confirm_plan_features`, `confirm_flat_location_fixture`, `confirm_connect_forwarder`, `confirm_form_entry_sync_off` and `confirm_commtrack_off`; a confirmation is kept once an upload goes ahead, so resend it with each attempt until one does. The first upload of a case change records where CommCare HQ keeps it, which changes the saved app (`placements.recorded`); work begun with `begin_work` before then has to begin again. If a refusal carries `placement_moves`, show the user each move's `sentence`, and send `accept_placement_moves` with its `reason` and `digest` only when the user agrees: the move changes where CommCare HQ keeps those answers in every project space the app is published to. `hq_placement_moves_changed` means the offer changed since; show the new one. `app_changed_while_publishing` means the app, or where it publishes, kept changing while Nova prepared the upload, and nothing more was sent; relay the `message`, which says when to upload again. If the app's Web App setting on CommCare HQ differs from where the app runs, the call returns `hq_web_apps_change` before sending anything: relay its message, and send `confirm_web_apps` with `web_apps_change.to` only when the user says to change it. If CommCare HQ made the new app with Web Apps off for an app that runs in Web Apps, the call returns `hq_plan_lacks_web_apps`: relay its message, and leave `web-apps` out of `confirm_plan_features` until the user says the plan now includes it. If the app on CommCare HQ is set to a CommCare version below the one Nova's apps need, the call returns `hq_app_version_below_floor` with the app's `url`; relay its message. A success returns the same checked `project_space_compatibility` report, the durable deployment state and `logo_step` (the app's logo, which an upload never sends, with `instructions` to relay when `changed` is true). Where Nova couldn't read back the deployment's `kept` list or `nova_revision` after the app landed, that field is left out and the upload still succeeded: `get_deployment` reads them again. Where the user was removed from the app's Project, or the app was deleted, while the upload ran, a success carries `deployment` null and `sent`, what this upload put on CommCare HQ: tell the user it landed and was recorded. A refusal after something went says so in its `message`.",
			inputSchema: z.object({
				app_id: z
					.string()
					.describe(
						"App id to upload. Requires edit access in the app’s Project.",
					),
				app_name: z
					.string()
					.optional()
					.describe(
						"Optional app name to use on HQ. Defaults to the blueprint's own name when omitted or blank.",
					),
				domain: z
					.string()
					.optional()
					.describe(
						"Optional target project-space identifier. Must be one the user's API key can reach. See `get_hq_connection`'s `available_domains`. Omit only when the key reaches a single space; a multi-space key requires it.",
					),
				adopt_resources: z
					.array(z.string())
					.optional()
					.describe(
						"Nova ids of lookup tables or places whose name already exists on the project space and which the user has confirmed Nova may take over. Send only after an `hq_resource_conflict` refusal named them and the user said yes for each one; a shared name is not evidence that the existing resource is theirs. Omit to adopt nothing.",
					),
				discard_hq_changes: z
					.array(
						z.object({
							kind: z.enum(["app", "lookup-table", "location"]),
							nova_resource_id: z.string(),
							observed_digest: z.string(),
						}),
					)
					.optional()
					.describe(
						"Send only after an `hq_changed` refusal listed them, the user saw the list, and said to write over each.",
					),
				confirm_plan_features: z
					.array(z.enum(PLAN_FEATURE_ID_LIST))
					.optional()
					.describe(CONFIRM_DESCRIPTION),
				confirm_flat_location_fixture: z
					.boolean()
					.optional()
					.describe(CONFIRM_DESCRIPTION),
				confirm_connect_forwarder: z
					.boolean()
					.optional()
					.describe(CONFIRM_DESCRIPTION),
				confirm_form_entry_sync_off: z
					.boolean()
					.optional()
					.describe(CONFIRM_DESCRIPTION),
				confirm_commtrack_off: z
					.boolean()
					.optional()
					.describe(CONFIRM_DESCRIPTION),
				confirm_installation_profiles: z
					.string()
					.regex(INSTALLATION_REVIEW_TOKEN)
					.optional()
					.describe(
						"The exact confirmation from the latest installation profile review, after the user confirms the listed practice workers or selects an exact replacement profile from replacement_choices for this project space.",
					),
				confirm_web_apps: z
					.boolean()
					.optional()
					.describe(
						"Send only after an `hq_web_apps_change` refusal, and only the `to` value it named, once the user said to change the setting.",
					),
				accept_placement_moves: acceptPlacementMovesSchema
					.optional()
					.describe(
						"Send only after a refusal returned placement_moves, with its reason and digest, once the user agreed to move those case changes.",
					),
			}),
		},
		async (args, extra): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			const appId = args.app_id;

			try {
				/* Pre-gate 1: Project edit access + blueprint load in one
				 * read. `loadAppBlueprint` throws `McpAccessError` on
				 * cross-tenant probe or vanished row; both collapse to
				 * `not_found` on the wire so a probing client cannot
				 * surface settings-level failure reasons for an app the
				 * caller cannot edit. */
				const { doc, app, access } = await loadAppBlueprint(
					appId,
					ctx.userId,
					"edit",
				);

				/* Gate 2: credentials + target-space resolution in one read.
				 * The optional `domain` arg picks the target (required for a
				 * multi-space key). This read keeps the key encrypted; only the
				 * shared publish lifecycle decrypts it after target resolution. The three failure shapes map 1:1 to distinct
				 * wire error types so a client can branch (configure, pick a
				 * valid space, or disambiguate). */
				const requested = args.domain?.trim() || undefined;
				const target = await resolveHqTarget(ctx.userId, requested);
				if (!target.ok) {
					if (target.error === "not_configured") {
						return makeGateError(
							UPLOAD_ERROR_TAGS.hq_not_configured,
							"CommCare HQ is not configured. Add your HQ credentials in Settings before uploading.",
							appId,
							NOTHING_RECORDED,
						);
					}
					const reachable = target.available.map((d) => d.name).join(", ");
					if (target.error === "not_authorized") {
						return makeGateError(
							UPLOAD_ERROR_TAGS.domain_not_authorized,
							`Your stored CommCare HQ API key can't reach the "${requested}" project space. It reaches: ${reachable}. Pass one of those as \`domain\`, or update your key in Settings.`,
							appId,
							NOTHING_RECORDED,
						);
					}
					return makeGateError(
						UPLOAD_ERROR_TAGS.domain_ambiguous,
						`Your CommCare HQ API key reaches ${target.available.length} project spaces (${reachable}). Pass \`domain\` to choose which one to upload to.`,
						appId,
						NOTHING_RECORDED,
					);
				}
				const targetDomain = target.domain.name;

				/* Derive the run id from the app's own state (see
				 * `lib/mcp/runId.ts`). The upload typically comes at the
				 * end of a generation run, so the sliding-window lookup
				 * reuses the same id that the preceding mutations
				 * grouped under. */
				const runId = deriveRunId({
					currentRunId: app.run_id,
					lastActiveMs: app.updated_at.getTime(),
					now: new Date(),
				});

				/* The per-call collaborators (LogWriter, progress emitter,
				 * McpContext) are allocated INSIDE the publish's own
				 * upload-started hook, which fires only after every blocking
				 * preflight edge has passed. A refused upload therefore never
				 * announces "Uploading" for an app that was never sent, and
				 * never allocates a log writer or records a phantom run:
				 * a client retrying an invalid app in a loop must not fill
				 * admin inspect with uploads that never happened. Held in a
				 * ref object because the hook assigns it from inside the
				 * publish call, where a plain `let` stays narrowed to null. */
				const call: { current: ReturnType<typeof initMcpCall> | null } = {
					current: null,
				};

				try {
					/* The one publish lifecycle, shared with the browser's
					 * publish dialog. It preflights the dependency graph, sends
					 * the app, and records the durable deployment, so an MCP
					 * upload and a browser upload produce the same record and
					 * cannot drift apart.
					 *
					 * App name defaulting: `?.trim() || app.app_name` maps both
					 * omitted and whitespace-only inputs to the blueprint's
					 * denormalized name, which the schema keeps non-blank. */
					const outcome = await publishAppToHq({
						requireHqImport: () => {
							assertScope(ctx, SCOPES.hqWrite, "upload_app_to_hq");
							assertScope(ctx, SCOPES.hqImport, "upload_app_to_hq");
						},
						scope: {
							appId,
							projectId: access.projectId,
							role: access.role,
							actorUserId: ctx.userId,
						},
						doc,
						compiledAtSeq: app.mutation_seq,
						/* The head again, under the same edit check, where the
						 * app moved while the publish recorded its placements. */
						reloadHead: async () => {
							const head = await loadAppBlueprint(appId, ctx.userId, "edit");
							return { doc: head.doc, seq: head.app.mutation_seq };
						},
						...(args.accept_placement_moves !== undefined && {
							acceptPlacementMoves: args.accept_placement_moves,
						}),
						appName: args.app_name?.trim() || app.app_name,
						server: target.server,
						domain: targetDomain,
						adoptResourceIds: args.adopt_resources ?? [],
						discardRemoteChanges: (args.discard_hq_changes ?? []).map(
							(discard) => ({
								kind: discard.kind,
								novaResourceId: discard.nova_resource_id,
								observedDigest: discard.observed_digest,
							}),
						),
						confirm: confirmationKeys(args),
						confirmInstallationProfiles: args.confirm_installation_profiles,
						...(args.confirm_web_apps !== undefined && {
							confirmWebApps: args.confirm_web_apps,
						}),
						onUploadStarted: () => {
							call.current = initMcpCall(
								ctx,
								appId,
								access.projectId,
								access.role,
								runId,
								extra,
							);
							call.current.progress.notify(
								"upload_started",
								`Uploading to ${targetDomain}`,
								{ app_id: appId },
							);
						},
						onResourcesPushed: ({ tables, places }) => {
							const put = [
								...(tables === 0
									? []
									: [`${tables} lookup table${tables === 1 ? "" : "s"}`]),
								...(places === 0
									? []
									: [`${places} place${places === 1 ? "" : "s"}`]),
							];
							call.current?.progress.notify(
								"resources_pushed",
								`Put ${put.join(" and ")} on ${targetDomain}`,
								{ app_id: appId, tables, places },
							);
						},
					});

					/* Branch on whether THIS attempt got the app there, not on
					 * the record's state: a blocked preflight against an app
					 * that is already released leaves the record released,
					 * because it still is, and reading success off that would
					 * report a publish that never happened as a success. The
					 * refusal is the attempt's own report, never read back out
					 * of the record's phase history, where an earlier attempt's
					 * failure would shadow this one's. */
					if (!outcome.landed) {
						const failure = outcome.refusal.failure;
						/* What this attempt recorded and offers to move rides
						 * every refusal: a stop after the record keeps the holds,
						 * and the saved app changed either way. */
						const answer = placementAnswer(
							outcome.placements,
							outcome.refusal.placementMoves,
						);
						/* The boundary gate's findings are `invalid_input`
						 * because that is what a client branches on to know the
						 * APP is what needs fixing, not the connection or the
						 * target. Logged under the shared classifier's invalid
						 * input line, so a spike against one user shows, with
						 * the count of findings and never their sentences,
						 * which name the app's forms and questions. */
						if (failure.code === "app_not_ready") {
							const message = `This app isn't ready to upload. Fix these first: ${
								failure.details.length > 0
									? failure.details.join(" ")
									: failure.message
							}`;
							log.warn("[mcp] invalid input", {
								userId: ctx.userId,
								appId,
								code: failure.code,
								findings: failure.details.length,
							});
							return makeGateError("invalid_input", message, appId, answer);
						}
						if (failure.code === "hq_not_connected") {
							return makeGateError(
								UPLOAD_ERROR_TAGS.hq_not_configured,
								failure.message,
								appId,
								answer,
							);
						}
						if (failure.code === "domain_not_authorized") {
							return makeGateError(
								UPLOAD_ERROR_TAGS.domain_not_authorized,
								failure.message,
								appId,
								answer,
							);
						}
						if (failure.code === "project_space_incompatible") {
							if (outcome.projectSpaceCompatibility === null) {
								return makeGateError(
									UPLOAD_ERROR_TAGS.hq_upload_failed,
									"Nova couldn't complete the project space compatibility check. Try publishing again.",
									appId,
									answer,
								);
							}
							return makeCompatibilityError(
								failure.message,
								appId,
								outcome.projectSpaceCompatibility,
								answer,
							);
						}
						if (failure.code === "hq_app_state_unknown") {
							return makeGateError(
								UPLOAD_ERROR_TAGS.hq_app_state_unknown,
								failure.message,
								appId,
								answer,
							);
						}
						/* The mapped HQ app is gone. The generic upload-failed
						 * envelope would tell the caller the upload broke when the
						 * truth is the target vanished; this tag says what actually
						 * helps: publish again to recreate. */
						if (failure.code === "remote_app_missing") {
							return makeGateError(
								UPLOAD_ERROR_TAGS.remote_app_missing,
								failure.message,
								appId,
								answer,
							);
						}
						/* A name clash on the target's Project data. The envelope
						 * carries the conflicts structurally, because the
						 * caller's only two moves both need to know WHICH: rename
						 * the table in Project data, or ask the user about that
						 * exact table and send its `nova_resource_id` back in
						 * `adopt_resources`. A prose list would make the client
						 * parse names back into ids to do either. */
						if (failure.code === "hq_resource_conflict") {
							return makeConflictError(
								failure.message,
								appId,
								outcome.refusal.resourceConflicts,
								answer,
							);
						}
						/* Something this app publishes changed in CommCare HQ
						 * since Nova last published it. The envelope carries
						 * each change with the state it was read in, because
						 * the caller's one move past it is to ask the user about
						 * each and send that exact state back. */
						if (failure.code === "hq_changed") {
							return makeRemoteChangesError(
								failure.message,
								appId,
								outcome.refusal.remoteChanges,
								answer,
							);
						}
						/* What a person has to confirm about the project space.
						 * The envelope carries each item structurally, because
						 * the caller asks the user about each and sends back
						 * the ones they said yes to. */
						if (failure.code === "hq_confirmation_needed") {
							return makeConfirmationError(
								failure.message,
								appId,
								outcome.refusal.confirmationsNeeded,
								answer,
							);
						}
						/* The Web Apps question. The envelope carries the change
						 * structurally, because the caller's one move past it is
						 * to send its `to` back once the user says so. */
						if (
							failure.code === "hq_web_apps_change" &&
							outcome.refusal.webAppsChange !== null
						) {
							return makeWebAppsChangeError(
								failure.message,
								appId,
								outcome.refusal.webAppsChange,
								answer,
							);
						}
						/* HQ made the new app with Web Apps off. The person's
						 * `web-apps` answer is withdrawn; the message says what
						 * they can do. */
						if (failure.code === "hq_plan_lacks_web_apps") {
							return makeGateError(
								UPLOAD_ERROR_TAGS.hq_plan_lacks_web_apps,
								failure.message,
								appId,
								answer,
							);
						}
						/* The app's page on CommCare HQ rides along: raising its
						 * version, or changing an application profile, is done
						 * there. A profile's refusal names each profile and
						 * language on a line of its own after the message. */
						if (
							failure.code === "hq_installation_profile_review" ||
							failure.code === "hq_app_version_below_floor" ||
							failure.code === "hq_build_profile_language_missing"
						) {
							return {
								isError: true,
								content: [
									{
										type: "text",
										text: toolText({
											error_type: UPLOAD_ERROR_TAGS[failure.code],
											...(failure.installationProfileChoices && {
												replacement_choices: failure.installationProfileChoices,
											}),
											...(failure.installationProfileConfirmation && {
												confirmation: failure.installationProfileConfirmation,
											}),
											...(failure.installationProfileReviewUrl && {
												review_url: failure.installationProfileReviewUrl,
											}),
											message: [failure.message, ...failure.details].join("\n"),
											app_id: appId,
											url: outcome.hqAppUrl,
											...answer,
										}),
									},
								],
							};
						}
						/* The accepted offer no longer names what would move. The
						 * envelope's `placement_moves` is the offer as it stands
						 * now, which the caller shows the user afresh; the
						 * message alone says why. */
						if (failure.code === "hq_placement_moves_changed") {
							return makeGateError(
								UPLOAD_ERROR_TAGS.hq_placement_moves_changed,
								failure.message,
								appId,
								answer,
							);
						}
						/* The head kept moving while the publish recorded its
						 * placements. Nothing was sent; the next call goes on
						 * once the edits settle. */
						if (failure.code === "app_changed_while_publishing") {
							return makeGateError(
								UPLOAD_ERROR_TAGS.app_changed_while_publishing,
								failure.message,
								appId,
								answer,
							);
						}
						/* Someone stopped publishing the app there while this
						 * upload ran, so Nova recorded nothing more of it. The
						 * message says whether CommCare HQ may hold part of it. */
						if (failure.code === "publishing_stopped") {
							return makeGateError(
								UPLOAD_ERROR_TAGS.publishing_stopped,
								failure.message,
								appId,
								answer,
							);
						}
						/* A table HQ holds with content Nova's push would remove.
						 * Its own tag because neither an adoption nor a discard
						 * resolves it, and nothing was sent: the way out is a new
						 * export tag in Project data. The details name each table
						 * and what it holds. */
						/* A table CommCare HQ manages there changed in a way the app
						 * depends on, or was handed back to it while the upload got
						 * ready. Nova stopped both itself before any table was sent,
						 * so neither is CommCare HQ refusing the upload. The details
						 * of the first name each table and what changed. */
						if (
							failure.code === "hq_managed_data_changed" ||
							failure.code === "managed_table_handed_back"
						) {
							return makeGateError(
								UPLOAD_ERROR_TAGS[failure.code],
								[failure.message, ...failure.details].join(" "),
								appId,
								answer,
							);
						}
						if (failure.code === "hq_table_content_unsupported") {
							return makeGateError(
								UPLOAD_ERROR_TAGS.hq_table_content_unsupported,
								[failure.message, ...failure.details].join(" "),
								appId,
								answer,
							);
						}
						/* The organization does not fit the target's levels. Its
						 * own tag because no ownership decision resolves it and
						 * nothing was sent: the generic upload-failed envelope
						 * would send a caller looking at the app when what needs
						 * changing is the tree or the levels over there. The
						 * details name each place and what is wrong with it. */
						if (failure.code === "hq_organization_mismatch") {
							return makeGateError(
								UPLOAD_ERROR_TAGS.hq_organization_mismatch,
								failure.details.length > 0
									? `${failure.message} ${failure.details.join(" ")}`
									: failure.message,
								appId,
								answer,
							);
						}
						return makeGateError(
							UPLOAD_ERROR_TAGS.hq_upload_failed,
							failure.details.length > 0
								? `${failure.message}\n${failure.details.join("\n")}`
								: failure.message,
							appId,
							answer,
						);
					}

					const landedRecord = outcome.deployment;
					/* The HQ app this upload imported: the record's live mapping, or,
					 * for a caller who may no longer read the record, what the upload
					 * sent. */
					const hqAppId =
						landedRecord === null
							? (outcome.sent.find((resource) => resource.kind === "app")
									?.remoteId ?? null)
							: (activeRemoteApp(landedRecord)?.remoteId ?? null);
					call.current?.progress.notify(
						"upload_complete",
						`Uploaded. HQ app id ${hqAppId ?? "unknown"}`,
						{ app_id: appId, hq_app_id: hqAppId },
					);

					const shared = {
						stage: "upload_complete",
						app_id: appId,
						hq_app_id: hqAppId,
						/* Updated in place, or created fresh; the ledger decided. */
						hq_app_action: outcome.hqAppAction,
						/* The App Preview statement, on a publish that wrote over
						 * the app without knowing it unchanged; null otherwise. */
						app_preview_note: outcome.appPreviewNote,
						/* The logo an upload never sends, for the user to add in
						 * the app's settings on CommCare HQ. */
						logo_step:
							outcome.logoStep === null
								? null
								: {
										asset_id: outcome.logoStep.assetId,
										file_name: outcome.logoStep.fileName,
										changed: outcome.logoStep.changed,
										instructions: LOGO_UPLOAD_STEP_TEXT,
									},
						url: outcome.hqAppUrl,
						warnings: outcome.warnings,
						project_space_compatibility: outcome.projectSpaceCompatibility,
					};
					/* What this upload recorded of where CommCare HQ keeps the
					 * app's case changes. */
					const placements = {
						recorded: outcome.placements.recorded,
						moved: outcome.placements.moved,
					};
					let payload: Record<string, unknown>;
					if (landedRecord === null) {
						/* The caller was removed from the app's Project, or the app
						 * was deleted, after the import was admitted: the app landed
						 * and Nova recorded it, and the answer says what this upload
						 * sent and nothing of a deployment the caller may no longer
						 * read. */
						payload = {
							...shared,
							deployment: null,
							sent: outcome.sent.map((resource) => ({
								kind: resource.kind,
								nova_id: resource.novaResourceId,
								hq_id: resource.remoteId,
								hq_name: resource.pushedIdentity,
							})),
							setup_artifact: outcome.artifact,
							placements,
						};
					} else {
						const record = landedRecord.deployment;
						const deploymentScope = {
							appId,
							projectId: access.projectId,
							role: access.role,
							actorUserId: ctx.userId,
						};
						/* The app has landed, so what Nova could not read just now
						 * is left out of the answer rather than failing it and
						 * inviting a second upload. */
						const [identities, kept, novaRevisions] = await Promise.all([
							landedResourceIdentities(
								deploymentScope,
								doc,
								record.domain,
								"publish",
							),
							landedDeploymentKept(deploymentScope, landedRecord, "publish"),
							landedNovaRevisions(deploymentScope, record.domain, "publish"),
						]);
						payload = {
							...shared,
							deployment_state: record.state,
							deployment: describeDeployment(
								landedRecord,
								identities,
								kept,
								novaRevisions,
								orderedOrganizationLevels(doc),
							),
							setup_artifact: outcome.artifact,
							placements,
						};
					}

					/* Record the upload success on the event log as a
					 * `tool-result` conversation event. `toolCallId` is a fresh
					 * uuid (not `runId`) to preserve the `tool-call` ↔
					 * `tool-result` pairing contract in `lib/log/types.ts`. */
					call.current?.mcpCtx.recordConversation({
						type: "tool-result",
						toolCallId: crypto.randomUUID(),
						toolName: "upload_app_to_hq",
						output: {
							hq_app_id: hqAppId,
							url: outcome.hqAppUrl,
							warnings: outcome.warnings,
							project_space_compatibility: outcome.projectSpaceCompatibility,
						},
					});

					return {
						content: [{ type: "text", text: JSON.stringify(payload) }],
					};
				} finally {
					/* Drain the event-log buffer before returning OR
					 * throwing. `LogWriter.flush` never throws; it resolves
					 * once every inflight log batch has acknowledged.
					 * A missed flush silently drops any events that hadn't
					 * triggered the batch-size flush threshold yet. */
					const opened = call.current;
					if (opened !== null) await opened.logWriter.flush();
				}
			} catch (err) {
				/* Ownership failures, missing-blueprint races, and any
				 * throw from `importApp` (network fault, etc.) all land
				 * here. `toMcpErrorResult` classifies via the shared
				 * taxonomy. Gate 2-3 failures never reach this block:
				 * they return structured envelopes directly. */
				return toMcpErrorResult(err, {
					appId,
					userId: ctx.userId,
				});
			}
		},
	);
}
