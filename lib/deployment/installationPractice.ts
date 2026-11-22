import "server-only";

import { readHqApplication } from "@/lib/commcare/hq/application";
import type { HqBuildProfile } from "@/lib/commcare/hq/appSource";
import type { CommCareCredentials } from "@/lib/commcare/hq/http";
import {
	type InstallationFileState,
	readInstallationBuild,
} from "@/lib/commcare/hq/installationBuild";
import type { InstallationProfileBinding } from "@/lib/commcare/wireIdentity";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import type { InstallationProfileCheckpoint } from "./installationProfileReview";

type PracticeStart = NonNullable<
	InstallationProfileCheckpoint["practiceStart"]
>;
type PracticeResult =
	| { kind: "agreed"; bindings: readonly InstallationProfileBinding[] }
	| { kind: "review"; message: string; start?: PracticeStart };

/** A witness records when this definition's restore was actually generated.
 * It survives a later check while another installation is still being prepared. */
export async function checkPracticePreparation(input: {
	creds: CommCareCredentials;
	domain: string;
	appId: string;
	workingVersion: number;
	profiles: readonly HqBuildProfile[];
	proposed: readonly InstallationProfileBinding[];
	held: readonly InstallationProfileBinding[];
	start?: PracticeStart;
}): Promise<PracticeResult> {
	const { creds, domain, appId, profiles } = input;
	const definitions = new Map(
		profiles.map((p) => [p.id, canonicalJsonDigest(p)]),
	);
	const definitionsDigest = canonicalJsonDigest(profiles);
	const start =
		input.start?.definitionsDigest === definitionsDigest
			? input.start
			: undefined;
	const previous = new Map(
		[...input.held, ...(start?.witnessed ?? [])].map((p) => [p.uuid, p]),
	);
	const bindings = input.proposed.map(
		({ uuid, key, practiceWorkerId }): InstallationProfileBinding => {
			const binding = {
				uuid,
				key,
				...(practiceWorkerId && { practiceWorkerId }),
			};
			const prior = previous.get(binding.uuid);
			const witness = prior?.practiceWitness;
			if (
				binding.practiceWorkerId &&
				prior?.key === binding.key &&
				prior.practiceWorkerId === binding.practiceWorkerId &&
				witness?.appId === appId &&
				witness.definitionDigest === definitions.get(binding.key)
			)
				return { ...binding, practiceWitness: witness };
			return binding;
		},
	);
	const outstanding = (binding: InstallationProfileBinding) =>
		Boolean(binding.practiceWorkerId && !binding.practiceWitness);
	if (!bindings.some(outstanding)) return { kind: "agreed", bindings };
	const app = await readHqApplication(creds, domain, appId);
	const unavailable = {
		kind: "review" as const,
		message:
			"Nova could not read this version’s installation details. Check the Access APIs permission for your CommCare HQ account, then publish again.",
	};
	if (
		"success" in app ||
		app.builtFromAppId !== null ||
		app.version !== input.workingVersion ||
		(start && app.version < start.version)
	)
		return unavailable;
	const current = app.builds.filter((b) => b.version === app.version);
	if (current.length > 1) return unavailable;
	const build = current[0];
	const states = build
		? await readInstallationBuild(creds, domain, appId, build, profiles)
		: new Map<string, InstallationFileState>();
	if (!states || [...states.values()].includes("different")) return unavailable;

	const alreadyPrepared = new Set(start?.preparedOrIncomplete ?? []);
	const checked = bindings.map((binding) => {
		if (
			!outstanding(binding) ||
			!build ||
			!start ||
			states.get(binding.key) !== "prepared"
		)
			return binding;
		const newer = app.version > start.version && build.id !== start.buildId;
		const preparedSinceReview =
			app.version === start.version &&
			(!start.buildId || start.buildId === build.id) &&
			!alreadyPrepared.has(binding.key);
		const definitionDigest = definitions.get(binding.key);
		if (!definitionDigest || !(newer || preparedSinceReview)) return binding;
		return {
			...binding,
			practiceWitness: {
				appId,
				buildId: build.id,
				version: build.version,
				definitionDigest,
			},
		};
	});
	const remaining = checked.filter(outstanding);
	if (!remaining.length) return { kind: "agreed", bindings: checked };
	const needsNewVersion = remaining
		.filter((binding) => build && states.get(binding.key) !== "cold")
		.map((binding) => binding.key);
	const baseline =
		start?.version === app.version
			? start
			: {
					version: app.version,
					buildId: build?.id ?? null,
					definitionsDigest,
					preparedOrIncomplete: needsNewVersion,
				};
	const next: PracticeStart = {
		...baseline,
		witnessed: checked.filter((binding) => binding.practiceWitness),
	};
	const remainingKeys = new Set(remaining.map((binding) => binding.key));
	const names = profiles
		.filter((profile) => remainingKeys.has(profile.id))
		.map((p) => `“${p.name}”`)
		.join(", ");
	const version = needsNewVersion.length
		? `Version ${app.version} already has installation files for a worker Nova still needs to verify. Save the profiles and make a new version in CommCare HQ.`
		: `Use version ${app.version} in CommCare HQ. If it has not been built, choose Make new version.`;
	const file = needsNewVersion.length
		? "the CommCare_vN.ccz file for the new version"
		: `CommCare_v${app.version}.ccz`;
	return {
		kind: "review",
		start: next,
		message: `${version} In that version’s Deploy menu, choose Download to Android, then Offline Installation. Under Application Profile, select ${names}, one at a time, and download ${file} for each. Return to Nova and publish again to verify the selected workers. You can also remove the practice worker requirement in Nova.`,
	};
}
