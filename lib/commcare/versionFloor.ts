/**
 * The oldest CommCare version an app Nova writes runs on.
 *
 * One constant, so every place that names the version names the same one:
 * the publish's check on the app it updates, the `.ccz` profile's required
 * version, and the manual import guide's version step.
 */
export const COMMCARE_VERSION_FLOOR = { major: 2, minor: 57 } as const;

/**
 * How an app's CommCare version (`build_spec.version` as HQ's source read
 * serves it) stands against the floor. `unreadable` is a string that is not
 * HQ's `major.minor[.patch]`; a publish never reads that as being at or above
 * the floor.
 */
export function compareToVersionFloor(
	version: string,
): "at-or-above" | "below" | "unreadable" {
	const parts = version.split(".");
	if (
		parts.length < 2 ||
		parts.length > 3 ||
		!parts.every((part) => /^\d+$/.test(part))
	) {
		return "unreadable";
	}
	const major = Number(parts[0]);
	const minor = Number(parts[1]);
	if (major !== COMMCARE_VERSION_FLOOR.major) {
		return major > COMMCARE_VERSION_FLOOR.major ? "at-or-above" : "below";
	}
	return minor >= COMMCARE_VERSION_FLOOR.minor ? "at-or-above" : "below";
}
