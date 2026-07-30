import type { Mutation } from "@/lib/doc/types";
import type { Module, Uuid } from "@/lib/domain";

type AddModuleMutation = Extract<Mutation, { kind: "addModule" }>;
type UpdateModuleMutation = Extract<Mutation, { kind: "updateModule" }>;

export function updateModuleMutation(
	uuid: Uuid,
	patch: UpdateModuleMutation["patch"],
): UpdateModuleMutation {
	return { kind: "updateModule", uuid, patch };
}

export function addModuleMutation(
	module: Module,
	after?: Uuid | null,
): AddModuleMutation {
	return {
		kind: "addModule",
		module,
		...(after !== undefined && { after }),
	};
}
