/**
 * Named hook — the platforms the app declares it runs on
 * (`appSettings.runsOnlyOn`, read through `declaredPlatforms`).
 *
 * Selects the stored key itself, a primitive, so an unrelated edit never
 * re-renders a consumer. `declaredPlatforms` returns one of three frozen
 * arrays, so the result is stable by reference for one declaration and a
 * consumer may put it in a dependency list.
 */

"use client";

import { useMemo } from "react";
import { NEW_APP_SETTINGS } from "@/lib/domain";
import { declaredPlatforms, type Platform } from "@/lib/domain/platforms";
import { useBlueprintDoc } from "./useBlueprintDoc";

export function useDeclaredPlatforms(): readonly Platform[] {
	const runsOnlyOn = useBlueprintDoc((s) => s.appSettings.runsOnlyOn);
	return useMemo(
		() =>
			declaredPlatforms({
				appSettings:
					runsOnlyOn === undefined
						? NEW_APP_SETTINGS
						: { ...NEW_APP_SETTINGS, runsOnlyOn },
			}),
		[runsOnlyOn],
	);
}
