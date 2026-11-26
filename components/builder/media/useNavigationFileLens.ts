"use client";

import { useFileLanguageLens } from "@/components/builder/localization/BuilderLocalizationProvider";
import { useAppLocalization } from "@/lib/doc/hooks/useLocalization";
import type { IconRef } from "@/lib/domain/builtinIcons";
import { effectiveAppLocalization } from "@/lib/domain/localization";
import {
	type NavigationMedia,
	navigationFilesInLanguage,
	navigationMediaOverride,
} from "@/lib/domain/navigationMedia";

export function useNavigationFileLens<T extends IconRef>(
	carrier: NavigationMedia<T> | undefined,
) {
	const { language, isSource } = useFileLanguageLens();
	const app = effectiveAppLocalization(useAppLocalization());
	const override = (role: "icon" | "audioLabel") =>
		carrier === undefined
			? undefined
			: navigationMediaOverride(carrier, role, language);
	return {
		language,
		reading: (role: "icon" | "audioLabel") => {
			if (isSource || override(role) !== undefined) return undefined;
			const own = carrier?.mediaByLanguage?.[language]?.[role];
			if (own === undefined) return "Shared file";
			return own === null || own === "blank"
				? "From this installation’s default"
				: undefined;
		},
		removalLabel: (role: "icon" | "audioLabel") =>
			isSource
				? undefined
				: carrier?.mediaByLanguage?.[language]?.[role] === undefined &&
						override(role) === undefined
					? null
					: role === "icon"
						? "Use shared icon"
						: "Use shared spoken label",
		...navigationFilesInLanguage(carrier ?? {}, language, app),
	};
}
