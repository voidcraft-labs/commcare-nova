/**
 * The complete closed namespace CommCare Core materializes under
 * `instance('commcaresession')/session/context`.
 *
 * Nova's typed authoring enum names the same seven fields; raw XPath still
 * has to see every node Core recognizes.
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

/**
 * The context fields a session can lack, which Nova reads under the count
 * guard (`xpath/wire/emptyRows.ts::guardAbsentNode`). Core's
 * `SessionInstanceBuilder.addData` writes no node for a null value: Android
 * builds its session with no width, and Web Apps sends one only with a menu
 * request; the language comes from the request thread's localizer. `drift`
 * is always written, and the other four are supplied on both platforms.
 */
export const ABSENT_CAPABLE_SESSION_CONTEXT_FIELDS = [
	"window_width",
	"applanguage",
] as const;

/**
 * The session data node that holds a case list's typed search text:
 * `session/data/stringquery`, which Core writes for every frame step that
 * carries a last query (`SessionInstanceBuilder.addUserQueryData`) and only
 * Android sets (`CommCareActivity.saveLastQueryString`).
 */
export const CASE_LIST_SEARCH_TEXT_DATA_NAME = "stringquery";
