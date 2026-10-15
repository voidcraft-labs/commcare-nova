/**
 * The oldest CommCare version an app Nova writes runs on.
 *
 * One constant, so every place that names the version names the same one:
 * the manual import guide's version step, and the cutover's report of the
 * deployments whose app on CommCare HQ is built below it.
 */
export const COMMCARE_VERSION_FLOOR = { major: 2, minor: 57 } as const;
