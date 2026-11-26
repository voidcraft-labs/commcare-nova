import "server-only";

import { installationFormFiles } from "../buildProfile";
import { readWorkingInstallationSuite } from "../client";
import {
	type HqBuildProfile,
	readBuildProfiles,
	unusableBuildProfileKey,
} from "./appSource";
import { readHqAppSaveCounter } from "./appSourceAtVersion";
import { HQ_APP_SOURCE_MAX_BYTES, HQ_APPLICATION_MAX_BYTES } from "./bounds";
import { baseUrl, type CommCareCredentials, isValidDomainSlug } from "./http";
import {
	INSTALLATION_RESOURCES,
	nativeInstallationKey,
} from "./installationKey";
import { isHqObject } from "./readCollection";
import { readHqJson } from "./readJson";

export type InstallationFileState =
	| "prepared"
	| "cold"
	| "incomplete"
	| "different"
	| "unusable";

/** ApplicationResource.dehydrate(extras=true) merges the stored document into
 * the top-level response. Files are the BlobMixin's stored metadata. A named
 * download (including HEAD) can create those files and save this build. */
export async function readInstallationBuild(
	creds: CommCareCredentials,
	domain: string,
	workingId: string,
	build: { id: string; version: number; isReleased: boolean },
	expected: readonly HqBuildProfile[],
): Promise<{
	ordinary: "prepared" | "unusable" | "incomplete" | "different";
	profiles: ReadonlyMap<string, InstallationFileState>;
} | null> {
	const unavailableFiles = (
		ordinary: "unusable" | "incomplete" | "different",
	) => ({ ordinary, profiles: new Map(expected.map((p) => [p.id, ordinary])) });
	if (expected.some((p) => !nativeInstallationKey(p.id, undefined, p.langs)))
		return unavailableFiles("unusable");
	if (
		!isValidDomainSlug(domain) ||
		!/^[\w-]+$/.test(build.id) ||
		workingId === build.id
	)
		return null;
	const answer = await readHqJson(
		creds,
		`${baseUrl(creds)}/a/${domain}/api/application/v1/${encodeURIComponent(build.id)}/?extras=true`,
		"installation build",
		{ maxBytes: HQ_APPLICATION_MAX_BYTES + HQ_APP_SOURCE_MAX_BYTES },
	);
	if ("success" in answer) return null;
	const raw = answer.data;
	if (
		!isHqObject(raw) ||
		raw._id !== build.id ||
		raw.id !== build.id ||
		raw.domain !== domain ||
		raw.doc_type !== "Application" ||
		raw.copy_of !== workingId ||
		raw.built_from_app_id !== workingId ||
		raw.version !== build.version ||
		raw.is_released !== build.isReleased ||
		!isHqObject(raw.external_blobs)
	)
		return null;
	if (
		!Array.isArray(raw.langs) ||
		!raw.langs.every((lang): lang is string => typeof lang === "string") ||
		!Array.isArray(raw.modules)
	)
		return null;
	const languages = new Set(raw.langs);
	const modules = raw.modules;
	const profiles = readBuildProfiles(
		raw.build_profiles,
		languages,
		modules.length,
	);
	if (!profiles) {
		if (unusableBuildProfileKey(raw.build_profiles, languages, modules.length))
			return unavailableFiles("unusable");
		return null;
	}
	const profilesById = new Map(
		profiles.map((profile) => [profile.id, profile]),
	);
	const ordinaryFiles = new Set<string>();
	const formCounts: number[] = [];
	for (const module of modules) {
		if (!isHqObject(module) || !Array.isArray(module.forms)) return null;
		formCounts.push(module.forms.length);
	}
	const byOwner = new Map<string, Set<string>>();
	const blobs = raw.external_blobs;
	const positive = (path: string) => {
		const blob = Object.hasOwn(blobs, path) ? blobs[path] : undefined;
		return (
			isHqObject(blob) &&
			typeof blob.content_length === "number" &&
			Number.isSafeInteger(blob.content_length) &&
			blob.content_length > 0
		);
	};
	const resources: string[] = [...INSTALLATION_RESOURCES];
	const flavor = raw.target_commcare_flavor;
	if (flavor != null && flavor !== "none") {
		if (flavor !== "commcare" && flavor !== "commcare_lts") return null;
		for (const prefix of ["profile", "media_profile"])
			for (const extension of ["xml", "ccpr"])
				resources.push(`${prefix}-${flavor}.${extension}`);
	}
	const rootFiles = new Set(resources);
	if (
		raw.practice_mobile_worker_id != null &&
		typeof raw.practice_mobile_worker_id !== "string"
	)
		return null;
	if (raw.practice_mobile_worker_id) rootFiles.add("practice_user_restore.xml");
	const formPath = /^modules-[0-9]+\/forms-[0-9]+\.xml$/;
	for (const path of Object.keys(blobs)) {
		if (!path.startsWith("files/")) continue;
		const relative = path.slice(6);
		const slash = relative.indexOf("/");
		if (slash < 0) {
			if (!rootFiles.has(relative)) return unavailableFiles("different");
			continue;
		}
		const top = relative.slice(0, slash);
		if (profilesById.has(top)) {
			const files = byOwner.get(top) ?? new Set<string>();
			files.add(relative.slice(slash + 1));
			byOwner.set(top, files);
		} else if (formPath.test(relative)) {
			if (!positive(path)) return unavailableFiles("incomplete");
			ordinaryFiles.add(relative);
		} else if (
			!(
				(top === "default" || languages.has(top)) &&
				relative.slice(slash + 1) === "app_strings.txt"
			)
		) {
			// The ordinary offline archive includes every folder outside the current named profiles.
			return unavailableFiles("different");
		}
	}
	if (
		![...rootFiles].every((name) => positive(`files/${name}`)) ||
		!["default", ...languages].every((lang) =>
			positive(`files/${lang}/app_strings.txt`),
		)
	)
		return unavailableFiles("incomplete");
	// On the working app HQ generates the suite from the form definitions. The
	// exact current save binds this inventory to the build we just identified.
	const suite = await readWorkingInstallationSuite(creds, domain, workingId);
	if (
		"success" in suite ||
		(await readHqAppSaveCounter(creds, domain, workingId)) !== build.version
	)
		return null;
	const ordinaryForms = installationFormFiles(suite.xml, formCounts);
	if (!ordinaryForms) return null;
	for (const file of ordinaryFiles)
		if (!ordinaryForms.has(file)) return unavailableFiles("different");
	if (ordinaryForms.size !== ordinaryFiles.size)
		return unavailableFiles("incomplete");
	const states = new Map<string, InstallationFileState>();
	for (const profile of expected) {
		const actual = profilesById.get(profile.id);
		if (
			!actual ||
			profiles.length !== expected.length ||
			actual.name !== profile.name ||
			actual.practiceWorkerId !== profile.practiceWorkerId ||
			!actual.langs.length ||
			actual.langs.length !== profile.langs.length ||
			actual.langs.some(
				(lang, i) => lang !== profile.langs[i] || !languages.has(lang),
			)
		) {
			states.set(profile.id, "different");
			continue;
		}
		const files = byOwner.get(profile.id);
		if (!files) {
			states.set(profile.id, "cold");
			continue;
		}
		const selectedLanguages = new Set(
			["default", ...profile.langs].map((lang) => `${lang}/app_strings.txt`),
		);
		const roots = new Set(resources);
		if (profile.practiceWorkerId) roots.add("practice_user_restore.xml");
		let unexpected = false;
		let complete =
			files.size === roots.size + selectedLanguages.size + ordinaryForms.size;
		for (const file of files) {
			if (
				!roots.has(file) &&
				!selectedLanguages.has(file) &&
				!ordinaryForms.has(file)
			)
				unexpected = true;
			if (!positive(`files/${profile.id}/${file}`)) complete = false;
		}
		states.set(
			profile.id,
			unexpected ? "different" : complete ? "prepared" : "incomplete",
		);
	}
	return { ordinary: "prepared", profiles: states };
}
