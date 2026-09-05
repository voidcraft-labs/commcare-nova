import { z } from "zod";
import { type EntryPointTarget, uuidSchema } from "@/lib/domain";
import { deploymentTargetSchema } from "./types";

export const getEntryPointLinkSchema = deploymentTargetSchema
	.extend({
		entryPointUuid: uuidSchema,
		selections: z.array(
			z
				.object({
					moduleUuid: uuidSchema,
					caseIds: z.array(z.string().min(1)).min(1),
				})
				.strict(),
		),
	})
	.strict();

export interface PublishedEntryPoint {
	readonly target: EntryPointTarget;
	readonly uuid: string;
	readonly id: string;
	readonly signature: string;
	readonly requiredSelections: readonly {
		readonly moduleUuid: string;
		readonly caseType: string;
		readonly cardinality: "one" | "multiple";
		readonly maximum: number;
		readonly argumentId: string;
	}[];
}

export interface PublishedEntryPointManifest {
	readonly generation: string;
	readonly remoteAppId: string;
	readonly sourceSequence: number;
	readonly entries: readonly PublishedEntryPoint[];
	readonly dependencies: readonly {
		kind: "lookup-table" | "location";
		novaResourceId: string;
		remoteId: string;
		pushedIdentity: string | null;
	}[];
}

export interface EntryPointLink {
	readonly url: string;
	readonly checkedAt: string;
	readonly releasedBuildId: string;
	readonly releasedVersion: number;
}

export interface EntryPointObservation {
	readonly sourceSequence: number;
	readonly generation: string;
	readonly remoteAppId: string;
	readonly entryPointUuid: string;
	readonly checkedAt: string;
	readonly releasedBuildId: string;
	readonly releasedVersion: number;
}
