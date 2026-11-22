import { sameProfileDefinition } from "@/lib/commcare/installationProfiles";
import {
	installationDisclosure,
	installationReviewFits,
	isInstallationPage,
} from "./installationDisclosure";
import "server-only";

import { selectedSuiteAgrees } from "@/lib/commcare/buildProfile";
import {
	type CommCareCredentials,
	readWorkingInstallationSuite,
} from "@/lib/commcare/client";
import type { HqAppSource, HqBuildProfile } from "@/lib/commcare/hq/appSource";
import { readHqAppSaveCounter } from "@/lib/commcare/hq/appSourceAtVersion";
import type { InstallationProfileBinding } from "@/lib/commcare/wireIdentity";
import { type BlueprintDoc, effectiveAppLocalization } from "@/lib/domain";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { entriesByWirePath } from "./hqMedia";
import { normalizeHqAppSource } from "./hqSourceBaseline";
import { checkPracticePreparation } from "./installationPractice";
import {
	definitionKey,
	groupedDefinitions,
	type InstallationProfileCheckpoint,
	type InstallationProfileRequest,
	installationEditorSteps,
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
	| {
			kind: "agreed";
			bindings: readonly InstallationProfileBinding[];
			resume?: InstallationProfileCheckpoint;
	  }
	| { kind: "prepare-content"; checkpoint: InstallationProfileCheckpoint }
	| {
			kind: "prepare-languages";
			keepUntilEdit: readonly string[];
			checkpoint: InstallationProfileCheckpoint;
	  }
	| {
			kind: "review";
			message: string;
			paged?: true;
			details: readonly string[];
			confirmation?: string;
			choices?: DeploymentFailure["installationProfileChoices"];
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

/** Only the exact uploaded paths reported by HQ can change during the file step. */
export function sameInstallationAfterMedia(
	before: HqAppSource,
	after: HqAppSource,
	reported: Readonly<Record<string, string>>,
): boolean {
	if (
		canonicalJsonDigest(before.buildProfiles) !==
		canonicalJsonDigest(after.buildProfiles)
	)
		return false;
	const accepted = new Set<string>();
	const current = entriesByWirePath(after.multimediaMap ?? []);
	for (const [wirePath, id] of Object.entries(reported)) {
		const held = current.get(wirePath);
		if (!held || held.multimediaId !== id) return false;
		accepted.add(held.path);
	}
	const withoutReported = (source: HqAppSource) => {
		const value = source.raw.multimedia_map;
		if (!value || typeof value !== "object" || Array.isArray(value))
			return source.raw;
		return {
			...source.raw,
			multimedia_map: Object.fromEntries(
				Object.entries(value).filter(([path]) => !accepted.has(path)),
			),
		};
	};
	return (
		profileSourceDigests(withoutReported(before)).unrelatedDigest ===
		profileSourceDigests(withoutReported(after)).unrelatedDigest
	);
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
	const exact = new Map(source.buildProfiles.map((p) => [p.id, p]));
	const available = groupedDefinitions(
		source.buildProfiles.filter((p) => !previous.has(p.id)),
		(p) => definitionKey(p, null),
	);
	return requests.map((request) => {
		const { definition } = request;
		if (!request.needsWorker) return request;
		const held = exact.get(definition.id);
		const matches =
			!held && !request.knownKey
				? available.get(definitionKey(definition, null))
				: undefined;
		const worker =
			held?.practiceWorkerId ??
			(matches?.length === 1 ? matches[0].practiceWorkerId : undefined);
		return worker
			? { ...request, definition: { ...definition, practiceWorkerId: worker } }
			: request;
	});
}

type ChoicePage = NonNullable<InstallationProfileCheckpoint["choicePage"]>;

type ProfileOption = {
	label: string;
	confirmation: string;
	action:
		| { page: ChoicePage }
		| { request: InstallationProfileRequest; profile: HqBuildProfile };
};

const PROFILE_PAGE_SIZE = 12;

/** Only the displayed page carries confirmations. A navigation choice can change
 * the page, never a binding. Matching installations share one indexed group. */
export function installationChoicePage(
	unresolved: readonly InstallationProfileRequest[],
	available: ReadonlyMap<string, readonly HqBuildProfile[]>,
	page: ChoicePage | undefined,
	confirmation: string,
) {
	const candidates = (r: InstallationProfileRequest) =>
		available.get(definitionKey(r.definition, r.needsWorker));
	const selectable = unresolved.filter((r) => candidates(r)?.length);
	if (!selectable.length) return null;
	const request =
		selectable.length === 1
			? selectable[0]
			: selectable.find((r) => r.uuid === page?.installation);
	const group = request ? (candidates(request) ?? []) : selectable;
	const offset = Math.max(
		0,
		Math.min(
			page?.offset ?? 0,
			Math.floor((group.length - 1) / PROFILE_PAGE_SIZE) * PROFILE_PAGE_SIZE,
		),
	);
	const current: ChoicePage = request
		? { installation: request.uuid, offset }
		: { offset };
	const options: ProfileOption[] = [];
	const navigate = (label: string, next: ChoicePage) => {
		options.push({
			label,
			confirmation:
				"browse:" +
				canonicalJsonDigest({
					confirmation,
					operation: "browse-installations",
					from: current,
					to: next,
				}),
			action: { page: next },
		});
	};
	const name = (s: string) => s || "Unnamed profile";
	if (request) {
		for (const profile of (candidates(request) ?? []).slice(
			offset,
			offset + PROFILE_PAGE_SIZE,
		)) {
			options.push({
				label: `Use “${name(profile.name)}” (HQ ID ${profile.id}) for Nova installation “${name(request.definition.name)}” (${request.uuid}). ${profile.langs.join(" → ")}. ${profile.practiceWorkerId ? `Practice worker ${profile.practiceWorkerId}` : "No practice worker"}.`,
				confirmation: canonicalJsonDigest({
					confirmation,
					operation: "bind-profile",
					uuid: request.uuid,
					oldKey: request.knownKey ? request.definition.id : null,
					destination: profile,
				}),
				action: { request, profile },
			});
		}
	} else {
		for (const item of selectable.slice(offset, offset + PROFILE_PAGE_SIZE))
			navigate(
				`Choose a project-space installation for “${name(item.definition.name)}” (${item.uuid})`,
				{ installation: item.uuid, offset: 0 },
			);
	}
	if (offset > 0)
		navigate("Previous installations", {
			...current,
			offset: offset - PROFILE_PAGE_SIZE,
		});
	if (offset + PROFILE_PAGE_SIZE < group.length)
		navigate("More installations", {
			...current,
			offset: offset + PROFILE_PAGE_SIZE,
		});
	if (request && selectable.length > 1)
		navigate("Choose another Nova installation", { offset: 0 });
	const message = request
		? `Choose the project-space installation for “${name(request.definition.name)}”. Check its HQ ID, language order and practice worker. Showing ${offset + 1}–${Math.min(offset + PROFILE_PAGE_SIZE, group.length)} of ${group.length}.`
		: `Choose a Nova installation to see its matching project-space installations. Showing ${offset + 1}–${Math.min(offset + PROFILE_PAGE_SIZE, group.length)} of ${group.length}.`;
	return { page: current, options, message };
}

interface PublishCheckInput {
	readonly scope: DeploymentScope;
	readonly target: DeploymentTargetKey;
	readonly remoteAppId: string;
	readonly claim: InstallationProfileCheckpoint["claim"];
	readonly doc: BlueprintDoc;
	readonly sequence: number;
	readonly identity: TargetIdentity;
	readonly source: HqAppSource;
	readonly releasesUrl: string;
	readonly workingVersion: number;
	readonly needsBuildableContent: boolean;
	readonly creds: CommCareCredentials;
	readonly confirmWorkers?: string;
	readonly requireHqImport: (() => void) | null;
}

export async function checkInstallationPublish(
	input: PublishCheckInput,
): Promise<InstallationPublishCheck> {
	const browsing =
		isInstallationPage(input.confirmWorkers) ||
		input.confirmWorkers?.startsWith("browse:") === true;
	const result = await checkInstallations(
		{
			...input,
			confirmWorkers: isInstallationPage(input.confirmWorkers)
				? undefined
				: input.confirmWorkers,
		},
		browsing,
	);
	if (browsing && result.kind !== "review") return reviewFinished;
	if (result.kind !== "review" || installationReviewFits(result)) return result;
	const basis = canonicalJsonDigest({
		actor: input.scope.actorUserId,
		app: input.scope.appId,
		project: input.scope.projectId,
		target: input.target,
		remote: input.remoteAppId,
		claim: input.claim,
		version: input.workingVersion,
		sequence: input.sequence,
		source: profileSourceDigests(input.source.raw).sourceDigest,
	});
	return installationDisclosure(result, basis, input.confirmWorkers);
}

const reviewFinished = {
	kind: "review" as const,
	message:
		"The current installation review has finished. Publish again when you’re ready to send the app.",
	details: [],
};

async function checkInstallations(
	input: PublishCheckInput,
	browsing = false,
): Promise<InstallationPublishCheck> {
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
		previous.claim?.mapping === input.claim.mapping &&
		previous.claim?.endings === input.claim.endings &&
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

	const revision = { claim: input.claim, workingVersion: input.workingVersion };
	const review = { requested, previousKeys };
	const agreement = profileAgreement(review, source.buildProfiles);
	const acquiredWorker = requested.some(
		(request, index) =>
			request.definition.practiceWorkerId !==
			requests[index].definition.practiceWorkerId,
	);
	const confirmation = canonicalJsonDigest({
		...revision,
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
			claim: input.claim,
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
	const reserved = new Set([
		...bindings.map((b) => b.key),
		...requests.map((r) => r.definition.id),
	]);
	const observedByKey = new Map(
		source.buildProfiles.map((profile) => [profile.id, profile]),
	);
	const unresolved = requested.filter((request) => {
		const physical = observedByKey.get(request.definition.id);
		return (
			!physical ||
			(!request.knownKey &&
				!sameProfileDefinition(request.definition, physical))
		);
	});
	const missingKnown = unresolved.find((request) => request.knownKey);
	const previousChoice =
		currentReview?.phase === "replace-profile" &&
		currentReview.workingVersion === input.workingVersion &&
		currentReview.sourceDigest === sourceDigest
			? currentReview.choicePage
			: undefined;
	const matching = groupedDefinitions(
		source.buildProfiles.filter((p) => !reserved.has(p.id)),
		(p) => definitionKey(p, Boolean(p.practiceWorkerId)),
	);
	let choices = agreement.agreed
		? null
		: installationChoicePage(
				unresolved,
				matching,
				previousChoice,
				confirmation,
			);
	if (choices) {
		const checkpoint = (
			choicePage: ChoicePage,
		): InstallationProfileCheckpoint => ({
			phase: "replace-profile",
			sequence,
			appId: remoteAppId,
			...revision,
			sourceDigest,
			unrelatedDigest,
			review,
			choicePage,
		});
		const selected =
			previousChoice &&
			canonicalJsonDigest(currentReview) ===
				canonicalJsonDigest(checkpoint(choices.page))
				? choices.options.find(
						(option) => option.confirmation === input.confirmWorkers,
					)?.action
				: undefined;
		if (selected && "request" in selected) {
			const { request, profile } = selected;
			if (profile.practiceWorkerId) {
				const unavailable = await unavailableInstallationWorker(
					input.creds,
					target.domain,
					remoteAppId,
					{ ...source, buildProfiles: [profile] },
				);
				if (unavailable)
					return { kind: "review", message: unavailable, details: [] };
			}
			if (
				(await readHqAppSaveCounter(
					input.creds,
					target.domain,
					remoteAppId,
				)) !== input.workingVersion
			)
				return stale;
			const rebound = [
				...bindings.filter((b) => b.uuid !== request.uuid),
				{ uuid: request.uuid, key: profile.id },
			];
			if (!(await write(undefined, rebound))) return stale;
			return checkInstallations({
				...input,
				confirmWorkers: undefined,
				identity: { ...identity, installationProfiles: rebound },
			});
		}
		if (selected && "page" in selected)
			choices =
				installationChoicePage(
					unresolved,
					matching,
					selected.page,
					confirmation,
				) ?? choices;
		const pending = checkpoint(choices.page);
		if (
			canonicalJsonDigest(previous ?? null) !== canonicalJsonDigest(pending) &&
			!(await write(pending))
		)
			return stale;
		return {
			kind: "review",
			message: choices.message,
			details: [],
			choices: choices.options.map(({ label, confirmation }) => ({
				label,
				confirmation,
			})),
		};
	}

	if (
		agreement.agreed &&
		(!acquiredWorker ||
			(currentReview &&
				(currentReview.phase === "prepare-practice" ||
					currentReview.phase === "prepare-content") &&
				(currentReview.sourceDigest === sourceDigest ||
					currentReview.practiceStart?.definitionsDigest ===
						canonicalJsonDigest(source.buildProfiles)) &&
				canonicalJsonDigest(currentReview.review.requested) ===
					canonicalJsonDigest(requested)) ||
			(currentReview?.phase === "confirm-workers" &&
				currentReview.workingVersion === input.workingVersion &&
				currentReview.sourceDigest === sourceDigest &&
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
		if (
			(input.needsBuildableContent ||
				currentReview?.preparedContent?.resourcesReady === false) &&
			agreement.bindings.some((binding) => binding.practiceWorkerId)
		) {
			if (
				(await readHqAppSaveCounter(
					input.creds,
					target.domain,
					remoteAppId,
				)) !== input.workingVersion
			)
				return stale;
			if (browsing) return reviewFinished;
			const checkpoint: InstallationProfileCheckpoint = {
				phase: "prepare-content",
				sequence,
				appId: remoteAppId,
				...revision,
				sourceDigest,
				unrelatedDigest,
				review,
			};
			if (
				canonicalJsonDigest(previous ?? null) !==
					canonicalJsonDigest(checkpoint) &&
				!(await write(checkpoint))
			)
				return stale;
			return { kind: "prepare-content", checkpoint };
		}
		const practice = await checkPracticePreparation({
			creds: input.creds,
			domain: target.domain,
			appId: remoteAppId,
			profiles: source.buildProfiles,
			workingVersion: input.workingVersion,
			proposed: agreement.bindings,
			held: bindings,
			start: currentReview?.practiceStart,
		});
		if (practice.kind === "review") {
			if (practice.start) {
				if (
					(await readHqAppSaveCounter(
						input.creds,
						target.domain,
						remoteAppId,
					)) !== input.workingVersion
				)
					return stale;
				const checkpoint: InstallationProfileCheckpoint = {
					phase: "prepare-practice",
					sequence,
					appId: remoteAppId,
					...revision,
					sourceDigest,
					unrelatedDigest,
					review,
					practiceStart: practice.start,
					...(currentReview?.verifiedIntermediate && {
						verifiedIntermediate: true,
					}),
					...(currentReview?.preparedContent && {
						preparedContent: currentReview.preparedContent,
					}),
				};
				if (
					canonicalJsonDigest(previous ?? null) !==
						canonicalJsonDigest(checkpoint) &&
					!(await write(checkpoint))
				)
					return stale;
			}
			return { kind: "review", message: practice.message, details: [] };
		}
		if (browsing) return reviewFinished;
		const previousBindings = [...bindings].sort((a, b) =>
			a.uuid.localeCompare(b.uuid),
		);
		const nextBindings = [...practice.bindings].sort((a, b) =>
			a.uuid.localeCompare(b.uuid),
		);
		const bindingsChanged =
			canonicalJsonDigest(previousBindings) !==
			canonicalJsonDigest(nextBindings);
		if (
			(bindingsChanged || practice.bindings.some((b) => b.practiceWorkerId)) &&
			(await readHqAppSaveCounter(input.creds, target.domain, remoteAppId)) !==
				input.workingVersion
		)
			return stale;
		if (
			(previous || bindingsChanged) &&
			!(await write(
				currentReview?.verifiedIntermediate ? currentReview : undefined,
				practice.bindings,
			))
		)
			return stale;
		return {
			kind: "agreed",
			bindings: practice.bindings,
			...(currentReview?.preparedContent && { resume: currentReview }),
		};
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
		...revision,
		sourceDigest,
		unrelatedDigest,
		review,
		...(currentReview?.verifiedIntermediate && { verifiedIntermediate: true }),
		...(currentReview?.practiceStart && {
			practiceStart: currentReview.practiceStart,
		}),
		...(currentReview?.preparedContent && {
			preparedContent: currentReview.preparedContent,
		}),
	};
	if (
		canonicalJsonDigest(previous ?? null) !== canonicalJsonDigest(checkpoint) &&
		!(await write(checkpoint))
	)
		return stale;
	if (phase === "prepare-languages") {
		const unavailable = await unavailableInstallationWorker(
			input.creds,
			target.domain,
			remoteAppId,
			source,
		);
		if (unavailable)
			return {
				kind: "review",
				message: `${unavailable} In Releases → Application Profiles, clear or replace that worker, or remove its profile if you no longer need it. Publish again to add the new languages.`,
				details: [],
			};
		if (
			source.buildProfiles.some((profile) => profile.practiceWorkerId) &&
			(await readHqAppSaveCounter(input.creds, target.domain, remoteAppId)) !==
				input.workingVersion
		)
			return stale;
		return { kind: phase, keepUntilEdit: transition.keepUntilEdit, checkpoint };
	}
	return {
		kind: "review",
		message:
			phase === "confirm-workers"
				? "Review the practice worker this project space will supply for each installation."
				: missingKnown
					? `The original “${missingKnown.definition.name || "Unnamed profile"}” installation (${missingKnown.definition.id}) was removed from this project space. In Releases → Application Profiles, create its replacement with the name and languages below${missingKnown.needsWorker ? " and an active practice worker" : ""}. CommCare HQ assigns a new ID. Publish again to choose the replacement.`
					: "The project space’s application profiles need an edit before this publish can finish. On the app’s Releases page in CommCare HQ, open Application Profiles and make its complete list match the profiles below. Then publish again.",
		details: requested.length
			? requested.map((r) =>
					installationEditorSteps(
						r,
						observedByKey.get(r.definition.id)?.langs,
						source.langs,
					),
				)
			: ["Remove all named profiles. Workers will install all app languages."],
		...(phase === "confirm-workers" && { confirmation }),
	};
}

export function installationReviewFailure(
	result: Extract<InstallationPublishCheck, { kind: "review" }>,
	url: string,
): DeploymentFailure {
	if (!installationReviewFits(result) && !result.paged)
		return {
			code: "hq_installation_profile_review",
			message:
				"The installation review is ready. Publish again to read its details one page at a time.",
			details: [],
			installationProfileReviewUrl: url,
		};
	return {
		code: "hq_installation_profile_review",
		message: result.message,
		details: result.details,
		installationProfileReviewUrl: url,
		...(result.choices && { installationProfileChoices: result.choices }),
		...(result.confirmation && {
			installationProfileConfirmation: result.confirmation,
		}),
	};
}
