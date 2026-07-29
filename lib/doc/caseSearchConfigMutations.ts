import type { Mutation } from "@/lib/doc/types";
import {
	type CaseSearchConfig,
	normalizeOwnerOnlyCaseSearchConfig,
	type Uuid,
} from "@/lib/domain";

type ModuleUpdateMutation = Extract<Mutation, { kind: "updateModule" }>;

/** Encode Search presence as one fresh-state semantic operation. */
export function enableCaseSearchMutation(
	uuid: Uuid,
	_config: CaseSearchConfig | undefined,
): ModuleUpdateMutation {
	return {
		kind: "updateModule",
		uuid,
		patch: {},
		caseSearchConfigOperation: "enable",
	};
}

/** Deliberately store assigned-case availability without enabling Search. */
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
		patch: {},
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
		patch: {},
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
		patch: {},
		caseSearchConfigOperation: "remove-if-no-authored-settings",
	};
}

/** Remove the final prompt screen against replay-time state. */
export function cleanupCaseSearchAfterFinalInputMutation(args: {
	readonly uuid: Uuid;
	readonly config: CaseSearchConfig | undefined;
	readonly hasCasesAvailableCondition: boolean;
}): ModuleUpdateMutation {
	return {
		kind: "updateModule",
		uuid: args.uuid,
		patch: {},
		caseSearchConfigOperation: "cleanup-after-final-input",
	};
}
