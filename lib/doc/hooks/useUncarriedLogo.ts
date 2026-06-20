/**
 * Named hook — the app logo's asset id IF it won't reach the device on its
 * own, otherwise `undefined`.
 *
 * CommCare HQ's bulk upload excludes app-level logos from its match set, so an
 * image used ONLY as the logo never carries to the device — the banner stays
 * blank. `uncarriedLogoAsset` walks the doc's media references to decide; it
 * returns `undefined` the moment the logo image is reused by any form/menu
 * carrier (which DOES carry). The app-settings appearance section reads this to
 * warn proactively, before the user ever uploads.
 *
 * Returns a string primitive (asset id) or `undefined`, so the default
 * `Object.is` comparison inside `useBlueprintDoc` is sufficient — the section
 * re-renders only when the carried/not-carried answer actually flips.
 */

"use client";

import { uncarriedLogoAsset } from "@/lib/domain/mediaRefs";
import { useBlueprintDoc } from "./useBlueprintDoc";

export function useUncarriedLogo(): string | undefined {
	return useBlueprintDoc((s) => uncarriedLogoAsset(s));
}
