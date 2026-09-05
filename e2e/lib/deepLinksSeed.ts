/** The deep-link journey owns a fresh app and two real cases per attempt.
 * A distractor sorts first, so falling back to the first case cannot pass. */
import { buildUrl } from "@/lib/routing/location";
import { buildFormLinksBlueprint, FORM_LINKS_SEED } from "./formLinksSeed";

export const DEEP_LINKS_SEED = {
	appName: "Smoke · Deep links",
	moduleName: FORM_LINKS_SEED.moduleName,
	moduleUuid: FORM_LINKS_SEED.moduleUuid,
	target: FORM_LINKS_SEED.followUp,
	caseType: FORM_LINKS_SEED.caseType,
	distractorName: "A different patient",
	selectedName: "Z selected patient",
	renamedId: "selected_patient_follow_up",
} as const;

export function buildDeepLinksBlueprint(appId: string) {
	return {
		...buildFormLinksBlueprint(appId),
		appName: DEEP_LINKS_SEED.appName,
	};
}
export function deepLinksRoute(appId: string) {
	return buildUrl(`/build/${appId}`, {
		kind: "app-setup",
		section: "deep-links",
	});
}
