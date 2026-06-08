// lib/commcare/multimedia/logoEntry.ts
//
// The app logo (web-apps banner slot). Two wire surfaces, both fed from
// `blueprintDoc.logo` (a single image `AssetId`):
//
//   1. HQ-JSON `logo_refs` (the upload path — CCHQ regenerates the
//      profile from this on import):
//        "logo_refs": { "hq_logo_web_apps": { "path": "jr://file/commcare/<hash>.png" } }
//
//   2. The local `profile.ccpr` `<property>` (the local-CCZ diagnostics
//      path — Nova emits the profile directly):
//        <property key="brand-banner-web-apps" value="jr://file/commcare/<hash>.png" force="true"/>
//
// Verified against `commcare-hq/.../app_manager/models.py`
// (`ANDROID_LOGO_PROPERTY_MAPPING['hq_logo_web_apps'] = 'brand-banner-web-apps'`,
// and `create_profile` reading `logo_refs[name]['path']` into an
// app_profile property with `force=True`) and the profile template
// `templates/app_manager/profile.xml` (the property renders attribute-
// style: `<property key="..." value="..." force="true"/>`).

import type { Element } from "domhandler";
import { el } from "@/lib/commcare/elementBuilders";
import { type AssetManifest, requireAssetRef } from "./assetWirePath";

/**
 * The `logo_refs` key for the web-apps logo slot — Nova's only logo
 * slot (CommCare also has Android home/login/demo banner slots; Nova
 * targets web apps).
 */
const LOGO_REFS_KEY = "hq_logo_web_apps";

/**
 * The `profile.ccpr` property key the `hq_logo_web_apps` ref maps to,
 * per CCHQ's `ANDROID_LOGO_PROPERTY_MAPPING`. The mapping is what turns
 * the logo into a profile property the runtime honors.
 */
const LOGO_PROFILE_KEY = "brand-banner-web-apps";

/** One `logo_refs` entry value — CCHQ reads `['path']`; other keys it
 *  fills post-upload are not needed on the inbound import payload. */
export interface LogoRef {
	readonly path: string;
}

/**
 * Build the `logo_refs` map for the HQ-JSON application. Returns `{}`
 * when there's no logo or media emission is off — CCHQ accepts an empty
 * `logo_refs`, and the type slot widens from the shell's empty default.
 */
export function buildLogoRefs(
	logo: string | undefined,
	manifest: AssetManifest | undefined,
	where: string,
): Record<string, LogoRef> {
	if (!logo || !manifest) return {};
	return { [LOGO_REFS_KEY]: { path: requireAssetRef(logo, manifest, where) } };
}

/**
 * Build the local `profile.ccpr` `<property>` element for the logo, or
 * `undefined` when there's no logo / media is off (the compiler then
 * emits no logo property). `force="true"` matches CCHQ's emission —
 * the logo overrides any client default banner.
 */
export function buildLogoProfileProperty(
	logo: string | undefined,
	manifest: AssetManifest | undefined,
	where: string,
): Element | undefined {
	if (!logo || !manifest) return undefined;
	return el("property", {
		key: LOGO_PROFILE_KEY,
		value: requireAssetRef(logo, manifest, where),
		force: "true",
	});
}
