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

/** Each arm of a commit request with its mutations unadmitted. The
 * conditional distributes over the request's arms, so each keeps its own
 * `kind` (an `Omit` over the union would merge them into one field neither
 * arm accepts). */
export type Unadmitted<Request> = Request extends unknown
	? Omit<Request, "mutations"> & { readonly mutations: unknown }
	: never;

export type CommitGuardedBatchProposalArgs = Unadmitted<CommitGuardedBatchArgs>;

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
