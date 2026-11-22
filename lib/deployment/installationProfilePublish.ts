import "server-only";

import { selectedSuiteAgrees } from "@/lib/commcare/buildProfile";
import {
	type CommCareCredentials,
	readWorkingInstallationSuite,
} from "@/lib/commcare/client";
import type { HqAppSource } from "@/lib/commcare/hq/appSource";
import type { InstallationProfileBinding } from "@/lib/commcare/wireIdentity";
import { type BlueprintDoc, effectiveAppLocalization } from "@/lib/domain";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { normalizeHqAppSource } from "./hqSourceBaseline";
import {
	describedProfile,
	type InstallationProfileCheckpoint,
	type InstallationProfileRequest,
	profileAgreement,
	profileLanguageTransition,
	requestedProfiles,
} from "./installationProfileReview";
import {
	type DeploymentScope,
	type DeploymentTargetKey,
	readInstallationReview,
	writeInstallationReview,
} from "./store";
import type { TargetIdentity } from "./targetIdentity";
import type { DeploymentFailure } from "./types";

export type InstallationPublishCheck =
	| { kind: "agreed"; bindings: readonly InstallationProfileBinding[] }
	| {
			kind: "prepare-languages";
			keepUntilEdit: readonly string[];
			checkpoint: InstallationProfileCheckpoint;
	  }
	| {
			kind: "review";
			message: string;
			details: readonly string[];
			confirmation?: string;
	  };

export function profileSourceDigests(raw: unknown) {
	const normalized = normalizeHqAppSource(raw);
	if (
		"malformed" in normalized ||
		!normalized.normalized ||
		typeof normalized.normalized !== "object"
	)
		throw new Error(
			"The project space’s app could not be compared. Check its source again before publishing.",
		);
	const rest = { ...normalized.normalized } as Record<string, unknown>;
	for (const field of ["build_profiles", "_rev", "last_modified", "version"])
		delete rest[field];
	return {
		sourceDigest: normalized.digest,
		unrelatedDigest: canonicalJsonDigest(rest),
	};
}

export async function unavailableInstallationWorker(
	creds: CommCareCredentials,
	domain: string,
	appId: string,
	source: HqAppSource,
): Promise<string | undefined> {
	for (const profile of source.buildProfiles) {
		if (!profile.practiceWorkerId) continue;
		const suite = await readWorkingInstallationSuite(
			creds,
			domain,
			appId,
			profile.id,
		);
		if ("success" in suite || !selectedSuiteAgrees(suite.xml, profile))
			return `CommCare HQ could not verify the practice worker for “${profile.name}” in this project space. Check that the account is an active practice worker here and has a saved practice restore. You can also remove the practice worker requirement in Nova and review the change.`;
	}
}

/** A reviewed but unbound requirement may now have an ID because the person set it
 * through HQ. Only an exact, actor-confirmed read can promote that observed ID. */
function withObservedWorkers(
	requests: readonly InstallationProfileRequest[],
	source: HqAppSource,
	previousKeys: readonly string[],
) {
	const previous = new Set(previousKeys);
	return requests.map((request) => {
		const { definition } = request;
		if (!request.needsWorker) return request;
		const exact = source.buildProfiles.find(
			(profile) => profile.id === definition.id,
		);
		const candidates = exact
			? [exact]
			: source.buildProfiles.filter(
					(profile) =>
						!request.knownKey &&
						!previous.has(profile.id) &&
						profile.name === definition.name &&
						profile.langs.length === definition.langs.length &&
						profile.langs.every((lang, i) => lang === definition.langs[i]),
				);
		const worker = candidates.length === 1 && candidates[0].practiceWorkerId;
		return worker
			? { ...request, definition: { ...definition, practiceWorkerId: worker } }
			: request;
	});
}

export async function checkInstallationPublish(input: {
	readonly scope: DeploymentScope;
	readonly target: DeploymentTargetKey;
	readonly remoteAppId: string;
	readonly doc: BlueprintDoc;
	readonly sequence: number;
	readonly identity: TargetIdentity;
	readonly source: HqAppSource;
	readonly releasesUrl: string;
	readonly creds: CommCareCredentials;
	readonly confirmWorkers?: string;
	readonly requireHqImport: (() => void) | null;
}): Promise<InstallationPublishCheck> {
	const { scope, target, doc, sequence, identity, source, remoteAppId } = input;
	const bindings = identity.installationProfiles ?? [];
	const requests = requestedProfiles(doc, bindings);
	if (!requests.length && !bindings.length) {
		if (!source.buildProfiles.length) return { kind: "agreed", bindings: [] };
		return {
			kind: "review",
			message:
				"This project space has installation profiles Nova has never brought in. Bring in its changes to edit the profiles in Nova. To keep only the installation with all app languages, review the profiles on the Releases page and remove them there.",
			details: source.buildProfiles.map(
				(p) => `“${p.name || p.id}” · ${p.langs.join(" → ")}`,
			),
		};
	}
	input.requireHqImport?.();
	const previous = await readInstallationReview(scope, target);
	const { sourceDigest, unrelatedDigest } = profileSourceDigests(source.raw);
	const currentReview =
		previous &&
		previous.appId === remoteAppId &&
		previous.sequence === sequence &&
		previous.unrelatedDigest === unrelatedDigest
			? previous
			: undefined;
	const observedKeys = source.buildProfiles.map((profile) => profile.id);
	const previousKeys = currentReview?.review.previousKeys ?? observedKeys;
	const requested = withObservedWorkers(requests, source, previousKeys);
	// A browser-assigned key can be correlated only against the state reviewed
	// before its creation. A different app, sequence or unrelated source change
	// drops that evidence and presents a fresh review.

	const review = { requested, previousKeys };
	const agreement = profileAgreement(review, source.buildProfiles);
	const acquiredWorker = requested.some(
		(request, index) =>
			request.definition.practiceWorkerId !==
			requests[index].definition.practiceWorkerId,
	);
	const confirmation = canonicalJsonDigest({
		actor: scope.actorUserId,
		project: scope.projectId,
		app: scope.appId,
		target,
		remoteAppId,
		sequence,
		sourceDigest,
		review,
	});
	const write = (
		next?: InstallationProfileCheckpoint,
		agreedBindings?: readonly InstallationProfileBinding[],
	) =>
		writeInstallationReview(scope, target, {
			sequence,
			previous,
			next,
			bindings: agreedBindings,
			identity,
			requireHqImport: input.requireHqImport,
			remoteAppId,
		});
	const stale = {
		kind: "review" as const,
		message:
			"The app or its profile review changed while Nova was checking. Publish again to review the current profiles.",
		details: [],
	};
	if (
		agreement.agreed &&
		(!acquiredWorker ||
			(previous?.phase === "confirm-workers" &&
				previous.sourceDigest === sourceDigest &&
				input.confirmWorkers === confirmation))
	) {
		const unavailableWorker = await unavailableInstallationWorker(
			input.creds,
			target.domain,
			remoteAppId,
			source,
		);
		if (unavailableWorker)
			return { kind: "review", message: unavailableWorker, details: [] };
		const previousBindings = [...bindings].sort((a, b) =>
			a.uuid.localeCompare(b.uuid),
		);
		const nextBindings = [...agreement.bindings].sort((a, b) =>
			a.uuid.localeCompare(b.uuid),
		);
		if (
			(previous ||
				canonicalJsonDigest(previousBindings) !==
					canonicalJsonDigest(nextBindings)) &&
			!(await write(
				currentReview?.verifiedIntermediate ? currentReview : undefined,
				agreement.bindings,
			))
		)
			return stale;
		return { kind: "agreed", bindings: agreement.bindings };
	}
	const outgoing = Object.values(
		effectiveAppLocalization(doc.localization).wireCodes,
	);
	const transition = profileLanguageTransition(outgoing, source, requested);
	const phase = agreement.agreed
		? "confirm-workers"
		: transition.needsContentFirst
			? "prepare-languages"
			: "edit-profiles";
	const checkpoint: InstallationProfileCheckpoint = {
		phase,
		sequence,
		appId: remoteAppId,
		sourceDigest,
		unrelatedDigest,
		review,
		...(currentReview?.verifiedIntermediate && { verifiedIntermediate: true }),
	};
	if (
		canonicalJsonDigest(previous ?? null) !== canonicalJsonDigest(checkpoint) &&
		!(await write(checkpoint))
	)
		return stale;
	if (phase === "prepare-languages")
		return { kind: phase, keepUntilEdit: transition.keepUntilEdit, checkpoint };
	return {
		kind: "review",
		message:
			phase === "confirm-workers"
				? "Review the practice worker this project space will supply for each installation."
				: "The project space’s application profiles need an edit before this publish can finish. On the app’s Releases page in CommCare HQ, open Application Profiles and make its complete list match the profiles below. Then publish again.",
		details: requested.length
			? requested.map(describedProfile)
			: ["Remove all named profiles. Workers will install all app languages."],
		...(phase === "confirm-workers" && { confirmation }),
	};
}

export function installationReviewFailure(
	result: Extract<InstallationPublishCheck, { kind: "review" }>,
	url: string,
): DeploymentFailure {
	return {
		code: "hq_installation_profile_review",
		message: result.message,
		details: result.details,
		installationProfileReviewUrl: url,
		...(result.confirmation && {
			installationProfileConfirmation: result.confirmation,
		}),
	};
}
