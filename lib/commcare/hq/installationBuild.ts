import "server-only";

import { type HqBuildProfile, readBuildProfiles } from "./appSource";
import { HQ_APP_SOURCE_MAX_BYTES, HQ_APPLICATION_MAX_BYTES } from "./bounds";
import { baseUrl, type CommCareCredentials, isValidDomainSlug } from "./http";
import { isHqObject } from "./readCollection";
import { readHqJson } from "./readJson";

export type InstallationFileState =
	| "prepared"
	| "cold"
	| "incomplete"
	| "different";

/** Match the relative paths ApplicationBase.create_all_files writes. A language
 * file and a module/form file have one directory beneath their physical key.
 * Other native files are at the root of that profile. Keys may contain slashes. */
function installationFileOwner(
	path: string,
): { key: string; languageFile: boolean } | null {
	if (!path.startsWith("files/")) return null;
	const last = path.lastIndexOf("/");
	if (last <= 5) return null;
	const leaf = path.slice(last + 1);
	const parent = path.slice(6, last);
	if (leaf === "app_strings.txt" || /^forms-[0-9]+\.xml$/.test(leaf)) {
		const child = parent.lastIndexOf("/");
		if (
			leaf === "app_strings.txt" ||
			/^modules-[0-9]+$/.test(parent.slice(child + 1))
		) {
			if (child < 1) return null;
			return {
				key: parent.slice(0, child),
				languageFile: leaf === "app_strings.txt",
			};
		}
	}
	return { key: parent, languageFile: false };
}

/** ApplicationResource.dehydrate(extras=true) merges the stored document into
 * the top-level response. Files are the BlobMixin's stored metadata. A named
 * download (including HEAD) can create those files and save this build. */
export async function readInstallationBuild(
	creds: CommCareCredentials,
	domain: string,
	workingId: string,
	build: { id: string; version: number; isReleased: boolean },
	expected: readonly HqBuildProfile[],
): Promise<ReadonlyMap<string, InstallationFileState> | null> {
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
	const profiles = readBuildProfiles(raw.build_profiles);
	if (!profiles) return null;
	const blobs = raw.external_blobs;
	const byOwner = new Map<string, { languageFiles: number }>();
	for (const path of Object.keys(blobs)) {
		const owner = installationFileOwner(path);
		if (!owner) continue;
		const item = byOwner.get(owner.key) ?? { languageFiles: 0 };
		if (owner.languageFile) item.languageFiles++;
		byOwner.set(owner.key, item);
	}
	const profilesById = new Map(
		profiles.map((profile) => [profile.id, profile]),
	);
	const positive = (path: string) => {
		const blob = Object.hasOwn(blobs, path) ? blobs[path] : undefined;
		return (
			isHqObject(blob) &&
			typeof blob.content_length === "number" &&
			Number.isSafeInteger(blob.content_length) &&
			blob.content_length > 0
		);
	};
	if (!positive("files/profile.ccpr") || !positive("files/suite.xml"))
		return null;
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
			actual.langs.some((lang, i) => lang !== profile.langs[i])
		) {
			states.set(profile.id, "different");
			continue;
		}
		const prefix = `files/${profile.id}/`;
		const languageFiles = new Set(
			["default", ...profile.langs].map(
				(lang) => `${prefix}${lang}/app_strings.txt`,
			),
		);
		const paths = [
			`${prefix}profile.ccpr`,
			`${prefix}suite.xml`,
			...languageFiles,
		];
		const restore = `${prefix}practice_user_restore.xml`;
		if (profile.practiceWorkerId) paths.push(restore);
		const files = byOwner.get(profile.id);
		const namedStrings = files?.languageFiles ?? 0;
		let presentStrings = 0;
		for (const path of languageFiles)
			if (Object.hasOwn(blobs, path)) presentStrings += 1;
		const unexpected =
			namedStrings !== presentStrings ||
			(!profile.practiceWorkerId && Object.hasOwn(blobs, restore));
		const hasNamedFile = files !== undefined;
		states.set(
			profile.id,
			unexpected
				? "different"
				: paths.every(positive)
					? "prepared"
					: hasNamedFile
						? "incomplete"
						: "cold",
		);
	}
	return states;
}
