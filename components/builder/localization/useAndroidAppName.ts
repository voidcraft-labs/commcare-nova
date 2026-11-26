"use client";

import { useDeploymentTargetFacts } from "@/components/builder/DeploymentTargetProvider";
import { useAppLocalization } from "@/lib/doc/hooks/useLocalization";
import {
	effectiveAppLocalization,
	resolveAppLanguage,
} from "@/lib/domain/localization";
import {
	androidAppName,
	type RequiredAndroidApp,
} from "@/lib/domain/requiredAndroidApps";
import { useBuilderLanguage } from "./BuilderLocalizationProvider";

export function useAndroidAppName() {
	const { language } = useBuilderLanguage();
	const localization = useAppLocalization();
	const effective = effectiveAppLocalization(localization);
	const code = effective.wireCodes[resolveAppLanguage(localization, language)];
	const labels = useDeploymentTargetFacts()?.androidAppLabels;
	return (app: RequiredAndroidApp) => androidAppName(app, code, labels);
}
