/** ApplicationBase.create_all_files writes these files for ordinary and named
 * installations. hqmedia.iter_index_files selects the matching media profile
 * as the offline archive's profile.ccpr. */
export const INSTALLATION_RESOURCES = [
	"profile.xml",
	"profile.ccpr",
	"media_profile.xml",
	"media_profile.ccpr",
	"suite.xml",
	"media_suite.xml",
] as const;
const ordinaryFiles = new Set<string>([
	...INSTALLATION_RESOURCES,
	"practice_user_restore.xml",
]);

/** download_index_files selects whole folders, and iter_index_files removes
 * key + "/" even inside relative names. Keep the ordinary install and each
 * named install's locales and enabled form filenames independent. */
export function nativeInstallationKey(
	key: string,
	ordinaryLanguages?: ReadonlySet<string>,
	profileLanguages: readonly string[] = [],
	moduleCount?: number,
): boolean {
	for (let i = 0; i < key.length; i++) {
		const code = key.charCodeAt(i);
		if (code < 32 || code === 127) return false;
	}
	if (
		!key ||
		key === "." ||
		key === ".." ||
		/[/\\]/u.test(key) ||
		ordinaryFiles.has(key) ||
		/^(?:media_)?profile-(?:commcare|commcare_lts)\.(?:xml|ccpr)$/.test(key) ||
		"default".endsWith(key) ||
		ordinaryLanguages?.has(key) ||
		profileLanguages.some((lang) => lang.endsWith(key))
	)
		return false;
	const module = /^(\D*)(\d+)$/.exec(key);
	if (moduleCount !== undefined && module && "modules-".endsWith(module[1])) {
		const digits = module[2];
		// A proper suffix can start with zero inside the module's decimal index.
		const first =
			digits.length > 1 && digits.startsWith("0")
				? module[1]
					? Infinity
					: Number(`1${digits}`)
				: Number(digits);
		if (first < moduleCount) return false;
	}
	const link = new URL(`https://hq.invalid/suite.xml?profile=${key}`);
	return !link.hash && link.searchParams.get("profile") === key;
}

export const INSTALLATION_KEY_RECOVERY =
	"An installation profile needs a new ID so CommCare HQ can keep its files separate and open the right installation. On the app’s Releases page, open Application Profiles, recreate the affected profile with its languages and practice worker, and remove the old entry.";
