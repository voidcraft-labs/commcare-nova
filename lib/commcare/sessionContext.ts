/**
 * The complete closed namespace CommCare Core materializes under
 * `instance('commcaresession')/session/context`.
 *
 * This runtime/wire set is intentionally broader than Nova's typed authoring
 * enum. Authoring omits device-dependent values such as `window_width`, while
 * raw XPath still has to see every node Core recognizes.
 */
export const COMMCARE_SESSION_CONTEXT_FIELDS = [
	"deviceid",
	"appversion",
	"username",
	"userid",
	"drift",
	"window_width",
	"applanguage",
] as const;
