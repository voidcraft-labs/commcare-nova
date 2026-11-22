import {
	type HqBuildProfile,
	readBuildProfiles,
} from "@/lib/commcare/hq/appSource";
import { sameProfileDefinition } from "@/lib/commcare/installationProfiles";
import {
	derivedUniqueId,
	type InstallationProfileBinding,
} from "@/lib/commcare/wireIdentity";
import {
	type BlueprintDoc,
	effectiveAppLocalization,
	type Uuid,
} from "@/lib/domain";

/** An in-place upload leaves HQ’s map in place. Bring in changes also compares the
 * definitions themselves, including a worker change that leaves the Blueprint identical. */
export function installationDefinitionsChanged(
	baseline: unknown,
	current: readonly HqBuildProfile[],
): boolean {
	const raw =
		baseline && typeof baseline === "object" && "build_profiles" in baseline
			? baseline.build_profiles
			: undefined;
	const before = readBuildProfiles(raw) ?? [];
	const byKey = new Map(before.map((profile) => [profile.id, profile]));
	return (
		before.length !== current.length ||
		current.some((profile) => {
			const previous = byKey.get(profile.id);
			return !previous || !sameProfileDefinition(previous, profile);
		})
	);
}

export interface InstallationProfileRequest {
	readonly uuid: Uuid;
	readonly definition: HqBuildProfile;
	readonly needsWorker: boolean;
	/** A known destination key stays attached even when every visible setting changes. */
	readonly knownKey: boolean;
}

export interface ReviewedInstallationProfiles {
	readonly requested: readonly InstallationProfileRequest[];
	readonly previousKeys: readonly string[];
}

export function requestedProfiles(
	doc: BlueprintDoc,
	bindings: readonly InstallationProfileBinding[],
): InstallationProfileRequest[] {
	const held = new Map(bindings.map((binding) => [binding.uuid, binding]));
	const { wireCodes } = effectiveAppLocalization(doc.localization);
	return Object.values(doc.appSettings.installationProfiles ?? {}).map(
		(profile) => {
			const binding = held.get(profile.uuid);
			return {
				uuid: profile.uuid,
				needsWorker: profile.requiresPracticeWorker,
				knownKey: binding !== undefined,
				definition: {
					id: binding?.key ?? derivedUniqueId(profile.uuid),
					name: profile.name,
					langs: profile.languages.map((language) => wireCodes[language]),
					...(profile.requiresPracticeWorker &&
						binding?.practiceWorkerId && {
							practiceWorkerId: binding.practiceWorkerId,
						}),
				},
			};
		},
	);
}

export function definitionKey(
	profile: HqBuildProfile,
	worker: boolean | string | null,
): string {
	return JSON.stringify([profile.name, profile.langs, worker]);
}

export function groupedDefinitions(
	profiles: Iterable<HqBuildProfile>,
	key: (profile: HqBuildProfile) => string,
) {
	const groups = new Map<string, HqBuildProfile[]>();
	for (const profile of profiles) {
		const value = key(profile);
		const group = groups.get(value);
		if (group) group.push(profile);
		else groups.set(value, [profile]);
	}
	return groups;
}

export type ProfileAgreement =
	| {
			readonly agreed: true;
			readonly bindings: readonly InstallationProfileBinding[];
	  }
	| { readonly agreed: false };
/** First match every known target key. A key allocated during the reviewed browser edit can
 * then identify exactly one new profile by its complete reviewed definition. A rename never
 * falls through to title matching, and an extra remote profile never counts as agreement. */
export function profileAgreement(
	review: ReviewedInstallationProfiles,
	observed: readonly HqBuildProfile[],
): ProfileAgreement {
	if (observed.length !== review.requested.length) return { agreed: false };
	const byKey = new Map(observed.map((profile) => [profile.id, profile]));
	const prior = new Set(review.previousKeys);
	const unresolved: InstallationProfileRequest[] = [];
	const bindings: InstallationProfileBinding[] = [];
	const admit = (
		request: InstallationProfileRequest,
		remote: HqBuildProfile,
	) => {
		byKey.delete(remote.id);
		bindings.push({
			uuid: request.uuid,
			key: remote.id,
			...(remote.practiceWorkerId && {
				practiceWorkerId: remote.practiceWorkerId,
			}),
		});
	};
	for (const request of review.requested) {
		if (request.needsWorker && !request.definition.practiceWorkerId)
			return { agreed: false };
		const remote = byKey.get(request.definition.id);
		if (!remote) {
			if (request.knownKey) return { agreed: false };
			unresolved.push(request);
		} else {
			if (!sameProfileDefinition(remote, request.definition))
				return { agreed: false };
			admit(request, remote);
		}
	}
	const key = (p: HqBuildProfile) =>
		definitionKey(p, p.practiceWorkerId ?? null);
	const available = groupedDefinitions(
		[...byKey.values()].filter((p) => !prior.has(p.id)),
		key,
	);
	for (const request of unresolved) {
		const group = key(request.definition);
		const matches = available.get(group);
		if (matches?.length !== 1) return { agreed: false };
		admit(request, matches[0]);
		available.delete(group);
	}
	return { agreed: true, bindings };
}

/** Adding a profile language requires content first. Removing a language the old
 * target profiles still reference requires their edit first. Both edges together
 * need an intermediate app with the union of both language sets. */
export function profileLanguageTransition(
	desired: readonly string[],
	source: {
		readonly langs: readonly string[];
		readonly buildProfiles: readonly HqBuildProfile[];
	},
	requests: readonly InstallationProfileRequest[],
) {
	const desiredSet = new Set(desired);
	const current = new Set(source.langs);
	const requestedCodes = new Set(
		requests.flatMap((request) => request.definition.langs),
	);
	const addFirst = [...requestedCodes].filter((code) => !current.has(code));
	const keepUntilEdit = [
		...new Set(source.buildProfiles.flatMap((profile) => profile.langs)),
	].filter((code) => !desiredSet.has(code));
	const needsContentFirst = addFirst.length > 0;
	return {
		addFirst,
		keepUntilEdit,
		needsContentFirst,
		intermediateLanguages: [...desired, ...keepUntilEdit],
	};
}

/** A browser edit may change the map once, then Nova must account for each changed
 * destination key. Kept with the app, project, actor, target and exact Nova revision. */
export interface InstallationProfileCheckpoint {
	readonly claim: { readonly mapping: string; readonly endings: number };
	readonly workingVersion: number;
	readonly choicePage?: {
		readonly installation?: Uuid;
		readonly offset: number;
	};
	readonly phase:
		| "prepare-languages"
		| "edit-profiles"
		| "confirm-workers"
		| "prepare-practice"
		| "prepare-content"
		| "replace-profile";
	readonly appId: string;
	readonly sequence: number;
	readonly sourceDigest: string;
	readonly unrelatedDigest: string;
	readonly review: ReviewedInstallationProfiles;
	/** Only an acknowledged intermediate read can stand in for the old app baseline. */
	readonly verifiedIntermediate?: boolean;
	/** Full, read-back content and Project inputs placed before a first practice build. */
	readonly preparedContent?: {
		readonly version: number;
		readonly inputs: string;
		readonly baselineDigest: string;
		readonly resourcesReady: boolean;
	};
	readonly practiceStart?: {
		readonly version: number;
		readonly buildId: string | null;
		readonly preparedOrIncomplete: readonly string[];
		readonly definitionsDigest: string;
		readonly witnessed?: readonly InstallationProfileBinding[];
	};
}

export function describedProfile(request: InstallationProfileRequest): string {
	const { name, id, langs, practiceWorkerId } = request.definition;
	const worker = request.needsWorker
		? practiceWorkerId
			? `Practice worker ${practiceWorkerId}.`
			: "Choose a practice worker from this project space."
		: "No practice worker.";
	return `“${name || "Unnamed profile"}” (${id}) · ${langs.join(" → ")}. ${worker}`;
}

/** HQ saves a profile by moving its selected default to the front. Its
 * multiselect otherwise writes selected languages in the app's option order. */
export function installationEditorSteps(
	request: InstallationProfileRequest,
	held: readonly string[] | undefined,
	appLanguages: readonly string[],
): string {
	const desired = request.definition.langs;
	const selected = new Set(desired);
	const starting =
		held &&
		held.length === desired.length &&
		held.every((lang) => selected.has(lang))
			? held
			: appLanguages.filter((lang) => selected.has(lang));
	// The suffix already in relative order stays put; moving the prefix to the
	// front in reverse order yields exactly the requested default and other languages.
	let prefix = desired.length;
	for (let i = starting.length - 1; i >= 0 && prefix > 0; i--) {
		if (starting[i] === desired[prefix - 1]) prefix--;
	}
	const defaults = desired.slice(0, prefix).reverse();
	if (!defaults.length) return describedProfile(request);
	return `${describedProfile(request)} After selecting the languages, set Default Language and save once for each of these, in this order: ${defaults.join(" → ")}. Leave the language selection as it is between saves.`;
}

export type InstallationPracticeWitness = NonNullable<
	InstallationProfileBinding["practiceWitness"]
>;
