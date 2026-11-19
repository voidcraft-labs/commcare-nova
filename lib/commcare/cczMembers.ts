/**
 * The names of a `.ccz`'s members, and the one writer of its members.
 *
 * Two producers name files in one archive: the compiler names its own (the
 * profile, the suite, the media suite, each language's app strings and each
 * form), and a media file takes the path CommCare HQ keeps it under on the
 * project space the archive is made for, which a person can set in CommCare
 * HQ (`lib/deployment/hqMedia.ts::isHoldableWirePath`). The compiler names
 * its files only through this module, and the rule for a media path reserves
 * every name of the shapes it gives, compared without letter case
 * (`isGeneratedMemberPath`), so a media file never takes a name the compiler
 * writes, whatever languages and menus the app gains after the path is held.
 *
 * The writer (`zipMembers.ts::zipMembers`) holds each member once by
 * `memberKey`. Pure and client-safe, so the rule for a held media path reads
 * the same names; outside the barrel.
 */

/** The profile, the first file a phone reads of an archive. */
export const PROFILE_MEMBER = "profile.ccpr";
/** The suite: menus, entries, details and the resources it names. */
export const SUITE_MEMBER = "suite.xml";
/** The media suite: one resource per bundled media file. */
export const MEDIA_SUITE_MEMBER = "media_suite.xml";

const ROOT_MEMBERS: readonly string[] = [
	PROFILE_MEMBER,
	SUITE_MEMBER,
	MEDIA_SUITE_MEMBER,
];

const APP_STRINGS_FILE = "app_strings.txt";

/** A form's member: `modules-<m>/forms-<f>.xml`, by the menu's and the form's place in the archive. */
export function formMemberPath(module: number, form: number): string {
	return `modules-${module}/forms-${form}.xml`;
}

/** A language directory's app strings: `<dir>/app_strings.txt`, `dir` a wire code or `default`. */
export function appStringsMemberPath(dir: string): string {
	return `${dir}/${APP_STRINGS_FILE}`;
}

/**
 * The key two member names share where they are one file to an archive:
 * the name with its letters lowered (`toLowerCase`), the fold CommCare HQ's
 * media upload matches paths by, so a name that only letter case tells from
 * another is one member wherever the archive is unpacked.
 */
export function memberKey(path: string): string {
	return path.toLowerCase();
}

const DIGITS = /^[0-9]+$/;

/** Whether a folded name is one the compiler gives a form: `modules-<n>/forms-<n>.xml`. */
function isFormMemberKey(module: string, form: string): boolean {
	if (!module.startsWith("modules-") || !form.startsWith("forms-"))
		return false;
	if (!form.endsWith(".xml")) return false;
	return (
		DIGITS.test(module.slice("modules-".length)) &&
		DIGITS.test(form.slice("forms-".length, -".xml".length))
	);
}

/**
 * Whether `path` is a name the compiler gives one of its own members, or a
 * name under one, compared without letter case (`memberKey`): a root member
 * (`profile.ccpr`, `suite.xml`, `media_suite.xml`) or a path under one;
 * `<any directory>/app_strings.txt` or a path under it; and
 * `modules-<n>/forms-<n>.xml` or a path under it. The reservation is by shape
 * and not by the app's current languages and forms, so a media path held
 * today never meets a member the app writes after a language or a form is
 * added.
 */
export function isGeneratedMemberPath(path: string): boolean {
	const segments = memberKey(path).split("/");
	const [first, second] = segments;
	if (first === undefined) return false;
	if (ROOT_MEMBERS.includes(first)) return true;
	if (second === undefined) return false;
	return second === APP_STRINGS_FILE || isFormMemberKey(first, second);
}
