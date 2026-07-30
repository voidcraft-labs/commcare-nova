import {
	type ApplyBlueprintChangeArgs,
	applyBlueprintChange,
} from "@/lib/db/applyBlueprintChange";
import {
	type CommitGuardedBatchArgs,
	type CommitGuardedBatchTransactionHooks,
	commitGuardedBatch,
} from "@/lib/db/apps";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";

export type CommitGuardedBatchProposalArgs = Omit<
	CommitGuardedBatchArgs,
	"mutations"
> & {
	readonly mutations: unknown;
};

export function commitGuardedBatchProposal(
	args: CommitGuardedBatchProposalArgs,
	hooks: CommitGuardedBatchTransactionHooks = {},
) {
	return commitGuardedBatch(
		{
			...args,
			mutations: admitMutationBatch(args.mutations),
		},
		hooks,
	);
}

export type ApplyBlueprintChangeProposalArgs = Omit<
	ApplyBlueprintChangeArgs,
	"guard"
> & {
	readonly guard: Omit<ApplyBlueprintChangeArgs["guard"], "mutations"> & {
		readonly mutations: unknown;
	};
};

export function applyBlueprintChangeProposal(
	args: ApplyBlueprintChangeProposalArgs,
) {
	return applyBlueprintChange({
		...args,
		guard: {
			...args.guard,
			mutations: admitMutationBatch(args.guard.mutations),
		},
	});
}
