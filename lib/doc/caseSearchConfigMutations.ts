import type { Mutation } from "@/lib/doc/types";
import {
	type CaseSearchConfig,
	caseSearchConfigAfterFinalInputRemoval,
	normalizeOwnerOnlyCaseSearchConfig,
	type Uuid,
} from "@/lib/domain";

type ModuleUpdateMutation = Extract<Mutation, { kind: "updateModule" }>;

/** Strict origin/main `caseSearchConfigSchema` fallback for Nova's private bit. */
export function legacyCompatibleCaseSearchConfig(
	config: CaseSearchConfig,
): CaseSearchConfig {
	const normalized = normalizeOwnerOnlyCaseSearchConfig(config);
	if (normalized.searchActionEnabled !== false) return normalized;
	const { searchActionEnabled: _intent, ...legacy } = normalized;
	return {
		...legacy,
		// Origin/main understands this predicate and therefore keeps the Search
		// action inaccessible if an old server strips the semantic extension.
		searchButtonDisplayCondition: { kind: "match-none" },
	};
}

/**
 * Encode Search presence on the established `updateModule` discriminator.
 *
 * The snapshot is deliberately redundant: origin/main parsers strip the
 * optional operation and origin/main reducers apply this enabled projection,
 * while current reducers preserve fresh peer settings and clear only the
 * owner-only no-action provenance bit.
 */
export function enableCaseSearchMutation(
	uuid: Uuid,
	config: CaseSearchConfig | undefined,
): ModuleUpdateMutation {
	const normalized =
		config === undefined
			? undefined
			: normalizeOwnerOnlyCaseSearchConfig(config);
	const {
		searchActionEnabled: _previousIntent,
		searchButtonDisplayCondition: legacyCondition,
		...rest
	} = normalized ?? {};
	const enabled =
		normalized !== undefined &&
		normalized.searchActionEnabled === false &&
		legacyCondition?.kind === "match-none"
			? rest
			: {
					...rest,
					...(legacyCondition && {
						searchButtonDisplayCondition: legacyCondition,
					}),
				};
	return {
		kind: "updateModule",
		uuid,
		patch: { caseSearchConfig: enabled },
		caseSearchConfigOperation: "enable",
	};
}

/**
 * Deliberately store assigned-case availability without enabling Search.
 * The desired value lives in an optional top-level extension (stripped whole
 * by old parsers); the recognized patch carries the behavior-equivalent
 * match-none fallback that origin/main's strict nested schema accepts.
 */
export function setOwnerOnlyCaseSearchMutation(
	uuid: Uuid,
	config: CaseSearchConfig,
): ModuleUpdateMutation {
	const desired = normalizeOwnerOnlyCaseSearchConfig(config);
	if (
		desired.searchActionEnabled !== false ||
		desired.excludedOwnerIds === undefined
	) {
		throw new Error(
			"Owner-only Search config must carry disabled assigned-case provenance.",
		);
	}
	return {
		kind: "updateModule",
		uuid,
		patch: { caseSearchConfig: legacyCompatibleCaseSearchConfig(desired) },
		caseSearchConfigOperation: "set-owner-only",
		caseSearchConfigValue: desired,
	};
}

/** Conditional removal of only an empty, unused Search marker. */
export function disableUnusedCaseSearchMutation(
	uuid: Uuid,
): ModuleUpdateMutation {
	return {
		kind: "updateModule",
		uuid,
		patch: { caseSearchConfig: null },
		caseSearchConfigOperation: "disable-if-unused",
	};
}

/**
 * Remove an explicitly-cleared Search bag only when fresh replay-time state has
 * no authored settings left. Unlike `disable-if-unused`, this operation is the
 * semantic form of an intentional config-to-absent edit and therefore may
 * remove an empty marker while inputs still exist. A peer-authored title,
 * action condition, or owner rule keeps the fresh bag alive.
 */
export function removeCaseSearchConfigIfNoAuthoredSettingsMutation(
	uuid: Uuid,
): ModuleUpdateMutation {
	return {
		kind: "updateModule",
		uuid,
		patch: { caseSearchConfig: null },
		caseSearchConfigOperation: "remove-if-no-authored-settings",
	};
}

/**
 * Remove the final prompt screen against replay-time state. The fallback is
 * the same local projection an origin/main receiver can safely apply without
 * encountering an unknown discriminator.
 */
export function cleanupCaseSearchAfterFinalInputMutation(args: {
	readonly uuid: Uuid;
	readonly config: CaseSearchConfig | undefined;
	readonly hasCasesAvailableCondition: boolean;
}): ModuleUpdateMutation {
	const fallback = caseSearchConfigAfterFinalInputRemoval(
		args.config,
		args.hasCasesAvailableCondition,
	);
	return {
		kind: "updateModule",
		uuid: args.uuid,
		patch: {
			caseSearchConfig:
				fallback === undefined
					? null
					: legacyCompatibleCaseSearchConfig(fallback),
		},
		caseSearchConfigOperation: "cleanup-after-final-input",
	};
}
