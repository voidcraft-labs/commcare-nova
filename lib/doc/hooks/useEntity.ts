/**
 * Entity lookup hooks — one hook per entity kind.
 *
 * Each returns the entity for a given uuid, or `undefined` if absent.
 * Accepts `Uuid | undefined` so call sites that derive the uuid from
 * a discriminated union (e.g. `useLocation()`) don't need unsound casts.
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

export function useModule(uuid: Uuid | undefined): ModuleEntity | undefined {
	return useBlueprintDoc((s) => (uuid ? s.modules[uuid] : undefined));
}

export function useForm(uuid: Uuid | undefined): FormEntity | undefined {
	return useBlueprintDoc((s) => (uuid ? s.forms[uuid] : undefined));
}

export function useQuestion(
	uuid: Uuid | undefined,
): QuestionEntity | undefined {
	return useBlueprintDoc((s) => (uuid ? s.questions[uuid] : undefined));
}
