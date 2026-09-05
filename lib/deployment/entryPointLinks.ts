import "server-only";
import { profileReferencesBuildSuite } from "@/lib/commcare/buildProfile";
import {
	listAppBuilds,
	probeHqProjectSpaceCompatibility,
	readAppVersions,
	readBuildXml,
} from "@/lib/commcare/client";
import { endpointSuiteSignature } from "@/lib/commcare/entryPointSignature";
import { listHqLocations } from "@/lib/commcare/hq/locations";
import { listHqLookupTables } from "@/lib/commcare/hq/lookupTables";
import { projectSpaceCompatibilityProbePlan } from "@/lib/commcare/projectSpaceCompatibility";
import { COMMCARE_SERVERS } from "@/lib/commcare/servers";
import { getCredentialsForUpload } from "@/lib/db/settings";
import { type BlueprintDoc, entryPointInventory } from "@/lib/domain";
import type { EntryPointLink, PublishedEntryPoint } from "./entryPointTypes";
import { DeploymentError } from "./errors";
import { activeRemoteApp } from "./resources";
import {
	type DeploymentScope,
	type DeploymentTargetKey,
	readDeployment,
	readEntryPointEvidence,
	recordEntryPointObservation,
} from "./store";

function refuse(message: string): never {
	throw new DeploymentError("invalid", message);
}

/** HQ splits collection arguments on commas; there is no escaping convention. */
export function entryPointArguments(
	entry: PublishedEntryPoint,
	selections: readonly { moduleUuid: string; caseIds: readonly string[] }[],
): URLSearchParams {
	const args = new URLSearchParams();
	if (
		selections.length !== entry.requiredSelections.length ||
		new Set(selections.map((s) => s.moduleUuid)).size !== selections.length
	)
		refuse(
			"Choose a case selection for every required module, without extra or repeated selections.",
		);
	for (const required of entry.requiredSelections) {
		const ids = selections.find(
			(s) => s.moduleUuid === required.moduleUuid,
		)?.caseIds;
		if (
			!ids ||
			ids.length === 0 ||
			ids.length > required.maximum ||
			(required.cardinality === "one" && ids.length !== 1)
		)
			refuse(
				`Choose ${required.cardinality === "one" ? "one case" : `between one and ${required.maximum} cases`} for each required selection.`,
			);
		if (
			ids.some((id) => id.trim().length === 0 || id.includes(",")) ||
			new Set(ids).size !== ids.length
		)
			refuse("Case IDs must be nonempty, distinct, and contain no commas.");
		args.set(required.argumentId, ids.join(","));
	}
	return args;
}

/** A fresh bounded observation, never a request to the claim-capable link itself. */
export async function getEntryPointLink(input: {
	scope: DeploymentScope;
	target: DeploymentTargetKey;
	doc: BlueprintDoc;
	/** Sequence from the same authorized snapshot as doc, never client asserted. */
	sourceSequence: number;
	entryPointUuid: string;
	selections: readonly { moduleUuid: string; caseIds: readonly string[] }[];
}): Promise<EntryPointLink> {
	const { scope, target } = input;
	const deployment = await readDeployment(scope, target);
	if (!deployment)
		refuse(
			"Publish this app to the selected project space before creating a link.",
		);
	const remote = activeRemoteApp(deployment);
	const evidence = await readEntryPointEvidence(scope, target);
	const manifest = evidence.manifest;
	if (
		!remote ||
		!manifest ||
		manifest.remoteAppId !== remote.remoteId ||
		manifest.generation !== evidence.generation
	)
		refuse(
			"Publish this app again before creating a link. Nova needs to verify the entry points from a complete publish.",
		);
	if (input.sourceSequence !== manifest.sourceSequence)
		refuse(
			"This app has changed since it was published. Publish the current app before creating a new HQ link.",
		);
	const current = entryPointInventory(input.doc).find(
		(item) => item.entryPoint.uuid === input.entryPointUuid,
	);
	const entry = manifest.entries.find(
		(item) => item.uuid === input.entryPointUuid,
	);
	if (
		!current ||
		!entry ||
		current.entryPoint.id !== entry.id ||
		current.target.kind !== entry.target.kind ||
		current.target.moduleUuid !== entry.target.moduleUuid ||
		(current.target.kind === "form" &&
			entry.target.kind === "form" &&
			current.target.formUuid !== entry.target.formUuid)
	)
		refuse("Publish this entry point before creating its HQ link.");
	const args = entryPointArguments(entry, input.selections);
	const credentials = await getCredentialsForUpload(
		scope.actorUserId,
		target.domain,
	);
	if (!credentials.ok)
		throw new DeploymentError(
			"hq_not_connected",
			"Nova couldn't reach this project space with your CommCare HQ connection. Check your connection in Settings, then try again.",
		);
	const { creds } = credentials;
	if (creds.server !== target.server)
		refuse(
			"Your CommCare HQ connection uses a different server. Connect to this deployment's server in Settings, then try again.",
		);
	const compatibility = await probeHqProjectSpaceCompatibility(
		creds,
		target.domain,
		projectSpaceCompatibilityProbePlan(input.doc),
	);
	const links = compatibility.report.required_capabilities.find(
		(cap) => cap.id === "deep-links",
	);
	if (links?.state !== "available")
		refuse(
			"Nova couldn't confirm Deep links support on this project space. Ask its administrator to enable that support, then check again.",
		);
	const versions = await readAppVersions(creds, target.domain, remote.remoteId);
	if ("success" in versions)
		refuse(
			"Nova couldn't read this app's released version. Check the app and your CommCare HQ connection, then try again.",
		);
	if (versions.latestReleasedVersion === null)
		refuse("Release a build on CommCare HQ before creating a link.");
	const builds = await listAppBuilds(creds, target.domain, remote.remoteId);
	if ("success" in builds)
		refuse(
			"Nova couldn't read this app's builds. Check that your CommCare HQ account has Access APIs permission, then try again.",
		);
	const released = builds.find(
		(build) =>
			build.isReleased && build.version === versions.latestReleasedVersion,
	);
	if (!released)
		refuse(
			"Nova couldn't find the released build. Check its release on CommCare HQ, then try again.",
		);
	const [profile, suite] = await Promise.all([
		readBuildXml(creds, target.domain, released.id, "profile.ccpr"),
		readBuildXml(creds, target.domain, released.id, "suite.xml"),
	]);
	if ("success" in profile || "success" in suite)
		refuse(
			"Nova couldn't read the released build's files. Check the deployment and try again.",
		);
	if (
		!profileReferencesBuildSuite(profile.xml, {
			server: target.server,
			domain: target.domain,
			buildId: released.id,
		})
	)
		refuse(
			"The released build didn't return its install profile and suite. Check its release on CommCare HQ, then try again.",
		);
	const actual = endpointSuiteSignature(suite.xml, entry.id, {
		appIds: [released.id, remote.remoteId],
	});
	if (!actual || actual !== entry.signature)
		refuse(
			"The released build doesn't match this published entry point. Build and release the published app on CommCare HQ, then try again.",
		);
	for (const dependency of manifest.dependencies) {
		if (
			!deployment.active.some(
				(item) =>
					item.kind === dependency.kind &&
					item.novaResourceId === dependency.novaResourceId &&
					item.remoteId === dependency.remoteId &&
					item.pushedIdentity === dependency.pushedIdentity,
			)
		)
			refuse(
				"This entry point's published dependencies have changed. Publish the app again before creating a link.",
			);
	}
	const tables = manifest.dependencies.filter((d) => d.kind === "lookup-table");
	if (tables.length) {
		const remoteTables = await listHqLookupTables(creds, target.domain);
		if (
			"success" in remoteTables ||
			tables.some(
				(d) =>
					!remoteTables.some(
						(t) => t.id === d.remoteId && t.tag === d.pushedIdentity,
					),
			)
		)
			refuse(
				"Nova couldn't confirm the published data tables on this project space. Check the tables, then publish again.",
			);
	}
	const places = manifest.dependencies.filter((d) => d.kind === "location");
	if (places.length) {
		const remotePlaces = await listHqLocations(creds, target.domain);
		if (
			"success" in remotePlaces ||
			places.some(
				(d) =>
					!remotePlaces.some(
						(p) =>
							p.locationId === d.remoteId && p.siteCode === d.pushedIdentity,
					),
			)
		)
			refuse(
				"Nova couldn't confirm the published places on this project space. Check the organization, then publish again.",
			);
	}
	const confirmedVersion = await readAppVersions(
		creds,
		target.domain,
		remote.remoteId,
	);
	if (
		"success" in confirmedVersion ||
		confirmedVersion.latestReleasedVersion !== released.version
	)
		refuse(
			"The released build changed while Nova checked it. Try creating the link again.",
		);
	const checkedAt = new Date().toISOString();
	if (
		!(await recordEntryPointObservation(scope, target, {
			generation: manifest.generation,
			remoteAppId: remote.remoteId,
			entryPointUuid: entry.uuid,
			sourceSequence: input.sourceSequence,
			checkedAt,
			releasedBuildId: released.id,
			releasedVersion: released.version,
		}))
	)
		refuse(
			"The app or deployment changed while Nova checked it. Try creating the link again.",
		);
	const url = new URL(
		`${COMMCARE_SERVERS[target.server].baseUrl}/a/${encodeURIComponent(target.domain)}/app/v1/${encodeURIComponent(remote.remoteId)}/${encodeURIComponent(entry.id)}/`,
	);
	url.search = args.toString();
	return {
		url: url.toString(),
		checkedAt,
		releasedBuildId: released.id,
		releasedVersion: released.version,
	};
}
