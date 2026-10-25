/**
 * What a publish asks a person to confirm about a project space, and how a
 * confirmation on record answers it.
 *
 * No API key reads a project space's plan, whether it still sends its flat
 * location list, whether it holds a forwarder to CommCare Connect, or whether
 * it syncs cases on form entry, so the
 * person confirms each one the app needs, as they confirm taking over a
 * lookup table: the refusal names what is needed, the caller comes back
 * naming what the person confirmed, and the deployment keeps it until
 * someone withdraws it. The `plan-features` preflight edge, the pre-publish
 * check (browser and MCP) and the HQ import guide all read the needs from
 * here, so they name the same things in the same words.
 *
 * Reads only the document and the two facts about what a publish sends
 * besides the app; it asks CommCare HQ nothing.
 */

import { buildConnectSlugMap } from "@/lib/commcare/connectSlugs";
import {
	connectForwarderReasons,
	flatLocationFixtureReasons,
	formEntrySyncReasons,
	type PlanPrivilegePushes,
	requiredPlanFeatures,
} from "@/lib/commcare/planPrivileges";
import type { AttachmentUrlTarget } from "@/lib/commcare/xform/captureUrlNode";
import type { BlueprintDoc } from "@/lib/domain";
import {
	CONNECT_FORWARDER,
	FLAT_LOCATION_FIXTURE,
	FORM_ENTRY_SYNC_OFF,
	formEntrySyncWhereMissing,
	isPlanFeatureId,
	PLAN_FEATURES,
	type PlanFeatureCheck,
	PROJECT_SPACE_SETTINGS,
	type ProjectSpaceSettingCheck,
	type ProjectSpaceSettingKind,
	webAppsWhereMissing,
} from "@/lib/publish/planFeatures";
import { narrowingTo } from "./platformNarrowing";
import {
	confirmationSubject,
	type DeploymentConfirmation,
	type DeploymentConfirmationKey,
	type DeploymentConfirmationNeeded,
} from "./types";

export type { PlanPrivilegePushes } from "@/lib/commcare/planPrivileges";

/**
 * Everything this app needs a person to confirm about a project space, in
 * the order every surface lists it: the plan features, then the flat
 * location list, then the Connect forwarder, then sync on form entry turned
 * off. `attachmentTarget` is the one a
 * publish there hands the emitter (`attachmentTarget.ts::attachmentUrlTarget`
 * of its server and project space).
 */
export function requiredConfirmations(
	doc: BlueprintDoc,
	pushes: PlanPrivilegePushes,
	attachmentTarget: AttachmentUrlTarget | null,
): DeploymentConfirmationNeeded[] {
	const connect = buildConnectSlugMap(doc);
	const needed: DeploymentConfirmationNeeded[] = requiredPlanFeatures(
		doc,
		pushes,
		attachmentTarget,
		connect,
	).map((feature) => ({
		kind: "plan-feature",
		subject: feature.id,
		label: feature.label,
		plans: feature.plans,
		consequence: feature.consequence,
		reasons: feature.reasons,
		whereMissing:
			feature.id === "web-apps"
				? webAppsWhereMissing(narrowingTo(doc, "android"))
				: null,
	}));
	const fixtureReasons = flatLocationFixtureReasons(doc);
	if (fixtureReasons.length > 0) {
		needed.push({
			kind: "flat-location-fixture",
			subject: "flat-location-fixture",
			label: FLAT_LOCATION_FIXTURE.label,
			plans: "",
			consequence: FLAT_LOCATION_FIXTURE.consequence,
			reasons: fixtureReasons,
			whereMissing: FLAT_LOCATION_FIXTURE.whereMissing,
		});
	}
	const forwarderReasons = connectForwarderReasons(doc, connect);
	if (forwarderReasons.length > 0) {
		needed.push({
			kind: "connect-forwarder",
			subject: "connect-forwarder",
			label: CONNECT_FORWARDER.label,
			plans: "",
			consequence: CONNECT_FORWARDER.consequence,
			reasons: forwarderReasons,
			whereMissing: CONNECT_FORWARDER.whereMissing,
		});
	}
	const syncReasons = formEntrySyncReasons(doc);
	if (syncReasons.length > 0) {
		needed.push({
			kind: "form-entry-sync-off",
			subject: "form-entry-sync-off",
			label: FORM_ENTRY_SYNC_OFF.label,
			plans: "",
			consequence: FORM_ENTRY_SYNC_OFF.consequence,
			reasons: syncReasons,
			whereMissing: formEntrySyncWhereMissing(narrowingTo(doc, "web-apps")),
		});
	}
	return needed;
}

/** The key a caller names back for one need. */
export function confirmationKeyOf(
	needed: Pick<DeploymentConfirmationNeeded, "kind" | "subject">,
): DeploymentConfirmationKey {
	switch (needed.kind) {
		case "plan-feature":
			if (!isPlanFeatureId(needed.subject)) {
				throw new Error(
					`A plan feature confirmation names “${needed.subject}”, which is no plan feature Nova knows.`,
				);
			}
			return { kind: "plan-feature", subject: needed.subject };
		case "flat-location-fixture":
			return { kind: "flat-location-fixture" };
		case "connect-forwarder":
			return { kind: "connect-forwarder" };
		case "form-entry-sync-off":
			return { kind: "form-entry-sync-off" };
	}
}

function sameSubject(
	a: Pick<DeploymentConfirmationNeeded, "kind" | "subject">,
	b: Pick<DeploymentConfirmationNeeded, "kind" | "subject">,
): boolean {
	return a.kind === b.kind && a.subject === b.subject;
}

/**
 * The needs nothing answers yet, and the confirmations this call brings
 * that answer a need. A confirmation naming something the app does not need
 * answers nothing and is left out, so it is never stored.
 */
export function settleConfirmations(input: {
	readonly needed: readonly DeploymentConfirmationNeeded[];
	readonly live: readonly DeploymentConfirmation[];
	readonly confirm: readonly DeploymentConfirmationKey[];
}): {
	readonly missing: readonly DeploymentConfirmationNeeded[];
	readonly accepted: readonly DeploymentConfirmationKey[];
} {
	const sent = input.confirm.map((key) => ({
		kind: key.kind,
		subject: confirmationSubject(key),
	}));
	const missing = input.needed.filter(
		(need) =>
			!input.live.some((held) => sameSubject(held, need)) &&
			!sent.some((key) => sameSubject(key, need)),
	);
	const accepted = input.needed
		.filter((need) => sent.some((key) => sameSubject(key, need)))
		.map(confirmationKeyOf);
	return { missing, accepted };
}

/** What the pre-publish check reports for one target. */
export interface ProjectSpaceConfirmationChecks {
	readonly plan_features: readonly PlanFeatureCheck[];
	readonly flat_location_fixture: ProjectSpaceSettingCheck | null;
	readonly connect_forwarder: ProjectSpaceSettingCheck | null;
	readonly form_entry_sync_off: ProjectSpaceSettingCheck | null;
}

/**
 * Each need as the pre-publish check reports it, with its state from the
 * confirmations in force on the target (none where no deployment exists).
 * The person is named by display name, never by user id.
 */
export function confirmationChecks(
	needed: readonly DeploymentConfirmationNeeded[],
	live: readonly DeploymentConfirmation[],
): ProjectSpaceConfirmationChecks {
	const stateOf = (need: DeploymentConfirmationNeeded) => {
		const held = live.find((confirmation) => sameSubject(confirmation, need));
		return held === undefined
			? { state: "needs_confirmation" as const }
			: {
					state: "confirmed" as const,
					confirmed_by: held.confirmedByName,
					confirmed_at: held.confirmedAt,
				};
	};
	const setting = (
		kind: ProjectSpaceSettingKind,
	): ProjectSpaceSettingCheck | null => {
		const need = needed.find((item) => item.kind === kind);
		return need === undefined
			? null
			: {
					label: need.label,
					consequence: need.consequence,
					reasons: need.reasons,
					where_missing: need.whereMissing,
					...stateOf(need),
				};
	};
	return {
		plan_features: needed.flatMap((need) => {
			if (need.kind !== "plan-feature" || !isPlanFeatureId(need.subject)) {
				return [];
			}
			return [
				{
					id: need.subject,
					label: need.label,
					plans: need.plans,
					consequence: need.consequence,
					reasons: need.reasons,
					where_missing: need.whereMissing,
					...stateOf(need),
				},
			];
		}),
		flat_location_fixture: setting("flat-location-fixture"),
		connect_forwarder: setting("connect-forwarder"),
		form_entry_sync_off: setting("form-entry-sync-off"),
	};
}

/**
 * What a confirmation on record is called, as the dialog row that asked for
 * it named it. A plan feature Nova no longer knows reads as its id.
 */
export function confirmationLabel(
	confirmation: Pick<DeploymentConfirmation, "kind" | "subject">,
): string {
	switch (confirmation.kind) {
		case "plan-feature":
			return isPlanFeatureId(confirmation.subject)
				? PLAN_FEATURES[confirmation.subject].label
				: confirmation.subject;
		default:
			return PROJECT_SPACE_SETTINGS[confirmation.kind].label;
	}
}

/** The sentence a refusal for missing confirmations opens with. */
export function confirmationNeededMessage(domain: string): string {
	return `“${domain}” needs a few things Nova can't check from here. Once you confirm that the project space has each one below, publishing can continue.`;
}
