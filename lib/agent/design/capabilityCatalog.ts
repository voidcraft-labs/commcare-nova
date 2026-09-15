/**
 * The versioned capability catalog — what Nova can construct, what the
 * platform constrains, and which gaps are deliberate (plan §7.6).
 *
 * GENERATED from code-owned registries, never freehand prose:
 *
 *  - the constructible tool surface projects from `SHARED_TOOL_REGISTRY`
 *    (names + reviewed effect/staging policy);
 *  - the field vocabulary projects from `lib/domain/fields::fieldKinds`;
 *  - the case data shapes project from
 *    `lib/domain/casePropertyTypes::casePropertyDataTypes`;
 *  - the constraint entries (Preview/runtime limits, external setup, HQ
 *    closures, deliberate target gaps) are the closed
 *    `platformConstraints.ts` vocabulary.
 *
 * The catalog may EXPLAIN capability to a reviewer or planner; it cannot
 * emit mutations, and nothing here executes.
 *
 * `catalogDigest` binds the complete generated body to durable design evidence.
 * It changes with its registries and constraints; a checked-in copy cannot prove
 * those capabilities. Tests cover the actual reviewer projection, while owning
 * domain and native consumer suites prove the facts represented here.
 */

import {
	PLATFORM_CONSTRAINTS,
	type PlatformConstraint,
} from "@/lib/agent/design/platformConstraints";
import { SHARED_TOOL_REGISTRY } from "@/lib/agent/sharedToolRegistry";
import { casePropertyDataTypes } from "@/lib/domain/casePropertyTypes";
import { fieldKinds } from "@/lib/domain/fields";
import { AUTOMATIC_TRANSLATION_LAUNCH_LANGUAGES } from "@/lib/translation/capabilityPolicy";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

export const EXTERNAL_PREREQUISITES = {
	media: "uploading or recording media before Nova can attach it",
	provisioning: "provisioning workers and shared resources",
	deployment:
		"CommCare HQ feature, build, release, and deployment steps that require a person",
} as const;

export interface CatalogToolEntry {
	readonly saName: string;
	readonly mcpName: string;
	readonly effect: string;
	readonly staging: string;
}

export interface CapabilityCatalog {
	readonly catalogVersion: 2;
	/** Canonical digest over everything below — the durable capability identity. */
	readonly catalogDigest: string;
	readonly toolSurface: readonly CatalogToolEntry[];
	readonly fieldKinds: readonly string[];
	readonly caseDataShapes: readonly string[];
	readonly constraints: readonly PlatformConstraint[];
	readonly sessionBoundary: {
		readonly appCount: 1;
		readonly projectScope: "current-project";
	};
	readonly existingReferenceable: readonly string[];
	readonly externalPrerequisites: readonly string[];
	readonly unsupported: readonly string[];
	readonly projectDataDesign: {
		readonly newTables: "reviewed-before-build";
		readonly existingReferences: "inspected-stable-uuid";
		readonly existingChanges: "direct-request-or-explicit-approval";
		readonly draftEffects: "none";
	};
	readonly localization: {
		readonly manualAuthoring: "individual-living-languages";
		readonly automaticPolicy: "all-directions-within-launch-set";
		readonly automaticLanguages: readonly {
			readonly code: string;
			readonly name: string;
		}[];
	};
}

export function buildCapabilityCatalog(): CapabilityCatalog {
	const toolSurface = SHARED_TOOL_REGISTRY.map((entry) => ({
		saName: entry.saName,
		mcpName: entry.mcpName,
		effect: entry.policy.effect,
		staging: entry.policy.staging,
	})).sort((a, b) => a.saName.localeCompare(b.saName));
	const body = {
		catalogVersion: 2 as const,
		toolSurface,
		fieldKinds: [...fieldKinds],
		caseDataShapes: [...casePropertyDataTypes],
		constraints: Object.values(PLATFORM_CONSTRAINTS),
		sessionBoundary: {
			appCount: 1 as const,
			projectScope: "current-project" as const,
		},
		existingReferenceable: [
			"Project lookup tables and columns inspected by stable UUID",
			"ready media assets already uploaded to the current Project",
			"existing organization levels, places, workers, roles, and user properties",
		],
		externalPrerequisites: Object.values(EXTERNAL_PREREQUISITES),
		unsupported: [
			"creating more than one app in one design session",
			"creating or choosing Projects or CommCare HQ project spaces",
			"recording, synthesizing, validating, or uploading audio or other media",
			"promising runtime or deployment resources that do not already exist",
			"placing one canonical form in several menus through linked or shadow form reuse; use separate modules, filtered lists, and deliberate workflow composition instead",
			"guessing or name-resolving an existing Project lookup identity, or changing shared Project data without a direct request or explicit approval",
		],
		projectDataDesign: {
			newTables: "reviewed-before-build" as const,
			existingReferences: "inspected-stable-uuid" as const,
			existingChanges: "direct-request-or-explicit-approval" as const,
			draftEffects: "none" as const,
		},
		localization: {
			manualAuthoring: "individual-living-languages" as const,
			automaticPolicy: "all-directions-within-launch-set" as const,
			automaticLanguages: AUTOMATIC_TRANSLATION_LAUNCH_LANGUAGES.map(
				(language) => ({ code: language.code, name: language.name }),
			),
		},
	};
	return { ...body, catalogDigest: canonicalJsonDigest(body) };
}

/**
 * The reviewer/planner prompt projection: compact text a model reads,
 * derived from the same catalog object — never a second hand-written list.
 */
export function renderCapabilityCatalog(catalog: CapabilityCatalog): string {
	const lines: string[] = [];
	lines.push("## What Nova can build");
	lines.push("");
	lines.push("### Constructible vocabulary");
	lines.push(`Field kinds: ${catalog.fieldKinds.join(", ")}.`);
	lines.push(
		`Case property data shapes: ${catalog.caseDataShapes.join(", ")}.`,
	);

	lines.push(
		"Session boundary: exactly one app in the current Project. If the source asks for multiple apps, ask which single app to build first; never offer Projects or HQ spaces as an app topology.",
	);
	lines.push(
		`Existing references: ${catalog.existingReferenceable.join("; ")}.`,
	);
	lines.push(
		"Project tables may be designed with source-grounded rows or referenced after inspection. Nova binds and checks the inspection evidence. Changes to existing shared tables require a direct request or explicit approval. Drafting and review do not change Project data.",
	);
	lines.push(
		`External prerequisites: ${catalog.externalPrerequisites.join("; ")}.`,
	);
	lines.push(`Unsupported promises: ${catalog.unsupported.join("; ")}.`);
	lines.push(
		"Manual app authoring, copying, Preview, and export support individual living languages, with script and regional variants where relevant. Automatic translation has a narrower language set.",
	);
	lines.push(
		`Automatic translation supports every direction between distinct languages in this set (variants of one language remain copy-only): ${catalog.localization.automaticLanguages
			.map((language) => `${language.name} (${language.code})`)
			.join(
				", ",
			)}. Machine translations need review. Other languages use copy-only localization followed by human translation.`,
	);
	lines.push("");
	lines.push("### Platform constraints and deliberate gaps");
	lines.push(
		"Each entry is a binding fact with a stable code. A critical platform-constraint finding must cite one of these codes; nothing outside this list is citable platform grounding.",
	);
	for (const constraint of catalog.constraints) {
		lines.push(`- ${constraint.code}: ${constraint.statement}`);
	}
	return lines.join("\n");
}
