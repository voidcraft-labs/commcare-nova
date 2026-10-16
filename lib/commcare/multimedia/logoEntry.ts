// lib/commcare/multimedia/logoEntry.ts
//
// The app logo in the local `profile.ccpr`, fed from `blueprintDoc.logo`
// (a single image `MediaAssetId`). Nova emits the profile directly on the
// local `.ccz` path, so it writes the property CCHQ's build would write for
// the web-apps slot:
//   <property key="brand-banner-web-apps" value="jr://file/commcare/<hash>.png" force="true"/>
//
// Verified against `commcare-hq/.../app_manager/const.py`
// (`ANDROID_LOGO_PROPERTY_MAPPING['hq_logo_web_apps'] = 'brand-banner-web-apps'`)
// and `models/applications.py` (`Application.create_profile` reading
// `logo_refs[name]['path']` into an app_profile property with
// `force=True`), and the profile template
// `templates/app_manager/profile.xml` (the property renders attribute-
// style: `<property key="..." value="..." force="true"/>`).
//
// The HQ JSON carries no `logo_refs`: HQ's own uploader writes a full
// media record per slot, and a logo reaches an app built on CommCare HQ
// when a person adds it there.

import type { Element } from "domhandler";
import { el } from "@/lib/commcare/elementBuilders";
import type { MediaAssetId } from "@/lib/domain/multimedia";
import { type AssetManifest, requireAssetRef } from "./assetWirePath";

/**
 * The `profile.ccpr` property key CCHQ's `ANDROID_LOGO_PROPERTY_MAPPING`
 * gives the `hq_logo_web_apps` slot.
 */
const LOGO_PROFILE_KEY = "brand-banner-web-apps";

/**
 * Build the local `profile.ccpr` `<property>` element for the logo, or
 * `undefined` when there's no logo / media is off (the compiler then
 * emits no logo property). `force="true"` matches CCHQ's emission —
 * the logo overrides any client default banner.
 */
export function buildLogoProfileProperty(
	logo: MediaAssetId | undefined,
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
