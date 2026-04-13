/**
 * Entity lookup hooks — one hook per entity kind.
 *
 * Each returns the entity for a given uuid, or `undefined` if absent.
 * The returned reference is stable across mutations that don't touch
 * this specific entity (Immer structural sharing).
 */

import type {
	FormEntity,
	ModuleEntity,
	QuestionEntity,
	Uuid,
} from "@/lib/doc/types";
import { useBlueprintDoc } from "./useBlueprintDoc";

export function useModule(uuid: Uuid): ModuleEntity | undefined {
	return useBlueprintDoc((s) => s.modules[uuid]);
}

export function useForm(uuid: Uuid): FormEntity | undefined {
	return useBlueprintDoc((s) => s.forms[uuid]);
}

export function useQuestion(uuid: Uuid): QuestionEntity | undefined {
	return useBlueprintDoc((s) => s.questions[uuid]);
}
