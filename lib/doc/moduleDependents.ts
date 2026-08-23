import {
	type BlueprintDoc,
	childModuleUuids,
	entityTargetKey,
	type Uuid,
} from "@/lib/domain";
import { referencingSlotsOf } from "./referenceIndex";

export type ModuleChildDependentsPlan =
	| { readonly kind: "clear" }
	| {
			readonly kind: "blocked";
			readonly childUuids: readonly Uuid[];
			readonly message: string;
			readonly userMessage: string;
	  };

/** Child menus that must be moved or removed before their parent can leave. */
export function planModuleChildDependentsOnRemove(
	doc: BlueprintDoc,
	parentModuleUuid: Uuid,
): ModuleChildDependentsPlan {
	const indexed = referencingSlotsOf(doc, entityTargetKey(parentModuleUuid));
	const children = childModuleUuids(doc, parentModuleUuid).filter((uuid) =>
		indexed.get(uuid)?.includes("module_parent"),
	);
	if (children.length === 0) return { kind: "clear" };
	const names = children.map((uuid) => `"${doc.modules[uuid]?.name ?? uuid}"`);
	const listed = names.join(", ");
	return {
		kind: "blocked",
		childUuids: children,
		message: `This module still contains ${children.length === 1 ? "the child menu" : "child menus"} ${listed}. Move or remove ${children.length === 1 ? "it" : "them"} first.`,
		userMessage: `${children.length === 1 ? "Move or remove the child menu" : "Move or remove the child menus"} ${listed} before removing this menu.`,
	};
}
