/**
 * The emission fixtures whose every form the envelope tests walk: each
 * fixture family the corpus producers build that compiles with no lookup
 * snapshot, scenario by scenario, with the media manifest a fixture's
 * media references resolve against.
 */
import type { BlueprintDoc } from "@/lib/domain";
import type { AssetManifest } from "../multimedia/assetWirePath";
import { caseCaptureFixture, caseCaptureScenarios } from "./caseCaptureFixture";
import {
	caseOperationFixture,
	operationScenarios,
} from "./caseOperationFixture";
import {
	compilerNavigationFixture,
	navigationScenarios,
} from "./compilerNavigationFixture";
import { connectWireFixtures } from "./connectWireFixtures";
import {
	constraintMessageFixture,
	constraintMessageScenarios,
} from "./constraintMessageFixture";
import {
	containerScenarios,
	containerWireFixture,
} from "./containerWireFixture";
import {
	extensionCaseFixture,
	extensionScenarios,
} from "./extensionCaseFixture";
import {
	formLinkWireFixture,
	formLinkWireScenarios,
} from "./formLinkWireFixture";
import {
	localizationScenarios,
	localizationWireFixture,
} from "./localizationWireFixture";
import {
	nestedMenuScenarios,
	nestedMenuWireFixture,
} from "./nestedMenuWireFixture";
import {
	noMatchesWireFixture,
	noMatchesWireScenarios,
} from "./noMatchesWireFixture";
import {
	relationInstanceFixture,
	relationInstanceScenarios,
} from "./relationInstanceFixture";
import { standardCaseReadsFixture } from "./standardCaseReadsFixture";
import { usercaseWriteFixture } from "./usercaseWriteFixture";

export interface EmissionFixture {
	readonly name: string;
	readonly doc: BlueprintDoc;
	readonly assets?: AssetManifest;
}

export function emissionFixtures(): EmissionFixture[] {
	return [
		...[...caseCaptureScenarios, "multiple" as const].map((scenario) => ({
			name: `case-capture-${scenario}`,
			doc: caseCaptureFixture(scenario),
		})),
		...extensionScenarios.map((scenario) => ({
			name: `case-extension-${scenario}`,
			doc: extensionCaseFixture(scenario),
		})),
		...(["survey", "followup"] as const).map((type) => ({
			name: `case-worker-${type}`,
			doc: usercaseWriteFixture(type),
		})),
		...operationScenarios.map((scenario) => ({
			name: `case-operation-${scenario}`,
			doc: caseOperationFixture(scenario),
		})),
		...connectWireFixtures().map(({ name, doc }) => ({
			name: `connect-${name}`,
			doc,
		})),
		...constraintMessageScenarios.map((scenario) => {
			const { doc, assets } = constraintMessageFixture(scenario);
			return { name: `constraint-message-${scenario}`, doc, assets };
		}),
		...containerScenarios.map((scenario) => ({
			name: `container-${scenario}`,
			doc: containerWireFixture(scenario),
		})),
		...formLinkWireScenarios.map((scenario) => ({
			name: `form-link-${scenario}`,
			doc: formLinkWireFixture(scenario),
		})),
		...localizationScenarios.map((scenario) => ({
			name: `localization-${scenario}`,
			doc: localizationWireFixture(scenario),
		})),
		...navigationScenarios.map((scenario) => ({
			name: `navigation-${scenario}`,
			doc: compilerNavigationFixture(scenario),
		})),
		...nestedMenuScenarios.map((scenario) => ({
			name: `nested-menu-${scenario}`,
			doc: nestedMenuWireFixture(scenario),
		})),
		...noMatchesWireScenarios.map((scenario) => ({
			name: `no-matches-${scenario}`,
			doc: noMatchesWireFixture(scenario),
		})),
		...relationInstanceScenarios.map((scenario) => ({
			name: `relation-instance-${scenario}`,
			doc: relationInstanceFixture(scenario),
		})),
		{ name: "standard-case-reads", doc: standardCaseReadsFixture() },
	];
}
