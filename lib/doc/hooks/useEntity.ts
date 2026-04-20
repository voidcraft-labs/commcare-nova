/**
 * Entity lookup hooks — one hook per entity kind.
 *
 * Each returns the entity for a given uuid, or `undefined` if absent.
 * Accepts `Uuid | undefined` so call sites that derive the uuid from
 * a discriminated union (e.g. `useLocation()`) don't need unsound casts.
 * The returned reference is stable across mutations that don't touch
 * this specific entity (Immer structural sharing).
 */

"use client";

import type { Field, Form, Module, Uuid } from "@/lib/domain";
import { useBlueprintDoc } from "./useBlueprintDoc";

export function useModule(uuid: Uuid | undefined): Module | undefined {
	return useBlueprintDoc((s) => (uuid ? s.modules[uuid] : undefined));
}

export function useForm(uuid: Uuid | undefined): Form | undefined {
	return useBlueprintDoc((s) => (uuid ? s.forms[uuid] : undefined));
}

export function useField(uuid: Uuid | undefined): Field | undefined {
	return useBlueprintDoc((s) => (uuid ? s.fields[uuid] : undefined));
}
