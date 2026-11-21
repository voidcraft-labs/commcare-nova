/**
 * Media paths with the verdict `app_deployment_media_paths_path_shape` gives
 * each: the floor the database states for a path CommCare HQ keeps a file
 * under. The rule in TypeScript refuses every path the floor refuses and
 * agrees with it on every ASCII path here; on the non-ASCII ones it may refuse
 * more, because the floor names its control code points (Unicode's Cc) and
 * folds case under the C collation: a locale's `[:cntrl:]` would also take
 * U+2028 inside a name, which the rule holds.
 */
export const MEDIA_PATH_FLOOR_CASES: readonly {
	readonly path: string;
	readonly floorAdmits: boolean;
}[] = [
	{ path: "commcare/image/logo.png", floorAdmits: true },
	{ path: "media/logo.png", floorAdmits: true },
	{ path: "a/b/c/d.png", floorAdmits: true },
	{ path: "commcare/.hidden.png", floorAdmits: true },
	{ path: "commcare/my logo.png", floorAdmits: true },
	{ path: `commcare/${"x".repeat(242)}.png`, floorAdmits: true },
	{ path: `commcare/${"x".repeat(243)}.png`, floorAdmits: false },
	{ path: "", floorAdmits: false },
	{ path: "logo.png", floorAdmits: false },
	{ path: "/commcare/logo.png", floorAdmits: false },
	{ path: "commcare/logo.png/", floorAdmits: false },
	{ path: "commcare//logo.png", floorAdmits: false },
	{ path: "commcare/../logo.png", floorAdmits: false },
	{ path: "../logo.png", floorAdmits: false },
	{ path: "commcare/./logo.png", floorAdmits: false },
	{ path: "commcare/..", floorAdmits: false },
	{ path: "commcare\\logo.png", floorAdmits: false },
	{ path: "commcare/a\\b.png", floorAdmits: false },
	{ path: "commcare/lo\tgo.png", floorAdmits: false },
	{ path: "commcare/logo.png\n", floorAdmits: false },
	{ path: "commcare/\u007flogo.png", floorAdmits: false },
	{ path: " commcare/logo.png", floorAdmits: false },
	{ path: "commcare/logo.png ", floorAdmits: false },
	{ path: "commcare/café.png", floorAdmits: true },
	{ path: "commcare/my\u2028logo.png", floorAdmits: true },
	{ path: "commcare/my\u2029logo.png", floorAdmits: true },
	{ path: "commcare/lo\u0085go.png", floorAdmits: false },
	{ path: "commcare/lo\u009fgo.png", floorAdmits: false },
	{ path: "commcare/lo\ufffego.png", floorAdmits: false },
	{ path: "commcare/lo\uffffgo.png", floorAdmits: false },
	{ path: "commcare/lo\u00a0go.png", floorAdmits: true },
	/* The names a `.ccz` gives its own files, and names under them, in any
	 * letter case; and the near names that are no file of its own. */
	{ path: "default/app_strings.txt", floorAdmits: false },
	{ path: "FRA/App_Strings.TXT", floorAdmits: false },
	{ path: "en/app_strings.txt/x.png", floorAdmits: false },
	{ path: "modules-0/forms-0.xml", floorAdmits: false },
	{ path: "Modules-12/Forms-3.XML", floorAdmits: false },
	{ path: "modules-0/forms-0.xml/x.png", floorAdmits: false },
	{ path: "suite.xml/x.png", floorAdmits: false },
	{ path: "PROFILE.ccpr/a.png", floorAdmits: false },
	{ path: "media_suite.xml/a.png", floorAdmits: false },
	{ path: "default/logo.png", floorAdmits: true },
	{ path: "a/b/app_strings.txt", floorAdmits: true },
	{ path: "modules-0/x.png", floorAdmits: true },
	{ path: "modules-0/forms-0.xml.png", floorAdmits: true },
	{ path: "modules-x/forms-0.xml", floorAdmits: true },
	{ path: "commcare/logo.png ", floorAdmits: true },
];
