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
 * `catalogDigest` is the drift tripwire: the source test
 * (`__tests__/capabilityCatalog.test.ts`) pins it in a checked-in snapshot,
 * so a shared tool, field kind, data shape, or platform constraint changing
 * without a reviewed catalog update fails CI. Gap constraints additionally
 * pin against the complex-app unit FILES: a gap code must name a unit file
 * that still exists, and a remaining unit file must have a gap code —
 * shipping a unit forces this vocabulary to shed its code.
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

export interface CatalogToolEntry {
	readonly saName: string;
	readonly mcpName: string;
	readonly effect: string;
	readonly staging: string;
}

export interface CapabilityCatalog {
	readonly catalogVersion: 2;
	/** Canonical digest over everything below — the drift tripwire. */
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
		externalPrerequisites: [
			"uploading or recording media before Nova can attach it",
			"provisioning workers and shared resources",
			"CommCare HQ feature, build, release, and deployment steps that require a person",
		],
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
	lines.push(
		`## Nova capability catalog (version ${catalog.catalogVersion}, digest ${catalog.catalogDigest.slice(0, 16)})`,
	);
	lines.push("");
	lines.push("### Constructible vocabulary");
	lines.push(`Field kinds: ${catalog.fieldKinds.join(", ")}.`);
	lines.push(
		`Case property data shapes: ${catalog.caseDataShapes.join(", ")}.`,
	);
	lines.push(
		`Authoring surface (${catalog.toolSurface.length} shared tools): ` +
			catalog.toolSurface.map((tool) => tool.saName).join(", ") +
			".",
	);
	lines.push(
		"Session boundary: exactly one app in the current Project. If the source asks for multiple apps, ask which single app to build first; never offer Projects or HQ spaces as an app topology.",
	);
	lines.push(
		`Existing references: ${catalog.existingReferenceable.join("; ")}.`,
	);
	lines.push(
		"Project lookup data: a reviewed design may define a new source-grounded table before build, then accepted-design finalization mints its stable identities. Existing tables are referenced only by inspected stable UUIDs plus a constant-size, revision-bound choice attestation whose digest and metrics Nova recomputes from the complete ordered projection before persistence; they change only after a direct request or explicit approval. Draft and review calls have no Project-data side effects.",
	);
	lines.push(
		`External prerequisites: ${catalog.externalPrerequisites.join("; ")}.`,
	);
	lines.push(`Unsupported promises: ${catalog.unsupported.join("; ")}.`);
	lines.push(
		"Localization: app languages are ISO 639:2023 Set 3 individual living-language identities, each carrying an ISO 15924 script where the language is written in more than one and an ISO 3166-1 region where regional conventions differ. Manual authoring, copy, Preview, and export support every such identity; automatic translation is a separate launch policy.",
	);
	lines.push(
		`Automatic translation is Available in every direction between two distinct languages in this ${catalog.localization.automaticLanguages.length}-language launch set (the language axis alone decides — script and region never do, so two written forms of one language stay a copy-only pair): ${catalog.localization.automaticLanguages
			.map((language) => `${language.name} (${language.code})`)
			.join(
				", ",
			)}. Every machine-authored value starts Needs review. For any language outside this set, use copy-only localization and record human translation as the remaining content task.`,
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
