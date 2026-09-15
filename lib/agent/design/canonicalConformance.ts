import { z } from "zod";
import type { ModuleHandleBinding } from "@/lib/agent/build/acceptedModulePlacement";
import { assertExactCommittedSliceReceipts } from "@/lib/agent/build/authoritativeCompletion";
import { deriveSliceExecutionBrief } from "@/lib/agent/build/executionBrief";
import { orderSlicesForExecution } from "@/lib/agent/build/sliceOrder";
import type { CommittedSliceReceipt } from "@/lib/agent/change-set/types";
import type { BlueprintDoc } from "@/lib/domain";
import type { LookupTableDefinition } from "@/lib/lookup/types";
import type {
	DesignBuildPlanRecord,
	DesignRevisionRecord,
} from "./artifactStore";
import {
	assessAcceptedWorkflow,
	CONFORMANCE_RULE_VERSION,
	conformanceFindingSchema,
} from "./conformance";
import { designIdSchema } from "./ids";
import { projectBlueprintImplementation } from "./projection/blueprint";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** No success status: an absence/type assessment is one input to completion. */
export const canonicalConformanceSchema = z
	.object({
		schemaVersion: z.literal(1),
		designRevisionId: z.string().uuid(),
		designRevisionDigest: digestSchema,
		buildPlanId: z.string().uuid(),
		buildPlanDigest: digestSchema,
		appId: z.string().min(1),
		appSeq: z.number().int().positive(),
		snapshotDigest: digestSchema,
		projectionVersion: z.number().int().positive(),
		projectionDigest: digestSchema,
		ruleVersion: z.literal(CONFORMANCE_RULE_VERSION),
		committedReceipts: z.array(
			z
				.object({
					id: z.string().uuid(),
					sliceId: designIdSchema,
					seq: z.number().int().positive(),
					snapshotDigest: digestSchema,
				})
				.strict(),
		),
		findings: z.array(conformanceFindingSchema),
		unreadable: z.array(
			z
				.object({ kind: z.string(), id: z.string(), reason: z.string() })
				.strict(),
		),
	})
	.strict();
export type CanonicalConformance = z.infer<typeof canonicalConformanceSchema>;

/** The caller authorizes one canonical snapshot. Reassess every constructed
 * workflow against that same head so a later slice cannot silently remove an
 * earlier input or write. Persistence must recheck the sequence and digest
 * against the authorized canonical head before accepting this assessment. */
export function assessCanonicalPlan(args: {
	designSessionId: string;
	revision: DesignRevisionRecord;
	plan: DesignBuildPlanRecord;
	doc: BlueprintDoc;
	appSeq: number;
	bindings: readonly ModuleHandleBinding[];
	receipts: readonly CommittedSliceReceipt[];
	tables?: readonly LookupTableDefinition[];
}): CanonicalConformance {
	const slices = orderSlicesForExecution(args.plan.envelope.payload);
	assertExactCommittedSliceReceipts({
		expectedSlices: slices,
		receipts: args.receipts,
		lineage: {
			designSessionId: args.designSessionId,
			designRevisionId: args.revision.id,
			designRevisionDigest: args.revision.artifactDigest,
			buildPlanId: args.plan.id,
			buildPlanDigest: args.plan.artifactDigest,
			appId: args.doc.appId,
		},
	});
	if (args.receipts.some((receipt) => receipt.seq > args.appSeq))
		throw new Error("A conformance snapshot precedes a committed workflow.");
	const projection = projectBlueprintImplementation(args.doc, args.tables);
	const briefs = slices.map((slice) =>
		deriveSliceExecutionBrief({
			contract: args.revision.envelope.payload,
			revision: { id: args.revision.id, digest: args.revision.artifactDigest },
			plan: args.plan.envelope.payload,
			sliceId: slice.id,
		}),
	);
	return canonicalConformanceSchema.parse({
		schemaVersion: 1,
		designRevisionId: args.revision.id,
		designRevisionDigest: args.revision.artifactDigest,
		buildPlanId: args.plan.id,
		buildPlanDigest: args.plan.artifactDigest,
		appId: args.doc.appId,
		appSeq: args.appSeq,
		snapshotDigest: projection.snapshotDigest,
		projectionVersion: projection.version,
		projectionDigest: projection.digest,
		ruleVersion: CONFORMANCE_RULE_VERSION,
		committedReceipts: args.receipts.map((receipt) => ({
			id: receipt.id,
			sliceId: receipt.sliceId,
			seq: receipt.seq,
			snapshotDigest: receipt.committedSnapshotDigest,
		})),
		findings: briefs.flatMap((brief) =>
			assessAcceptedWorkflow({
				doc: args.doc,
				brief,
				bindings: args.bindings,
			}),
		),
		unreadable: projection.unreadable,
	});
}
