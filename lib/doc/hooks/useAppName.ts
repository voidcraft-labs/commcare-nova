/**
 * Named hook — subscribe to the app's display name.
 *
 * Selects a string primitive, so the default `Object.is` comparison
 * inside `useBlueprintDoc` is sufficient (no shallow wrapper needed).
 * Re-renders only when `appName` itself changes reference — `setAppName`
 * is the only mutation that touches it, so consumers stay quiet for
 * every unrelated edit.
 */

"use client";

import { useContext } from "react";
import { BlueprintAuthoringLanguageContext } from "@/lib/doc/authoringLanguageContext";
import { projectLocalizedAppName } from "@/lib/domain";
import { useBlueprintDoc } from "./useBlueprintDoc";

export function useAppName(): string {
	const language = useContext(BlueprintAuthoringLanguageContext);
	return useBlueprintDoc((doc) =>
		language === null ? doc.appName : projectLocalizedAppName(doc, language),
	);
}
