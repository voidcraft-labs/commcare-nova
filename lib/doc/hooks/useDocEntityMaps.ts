/**
 * Named hook — return all three normalized entity maps as one shallow-
 * stable object.
 *
 * Consumers that need to walk entities by uuid (search filters, blueprint
 * validators, XPath hashtag resolvers, compound domain selectors) read
 * all three maps together. An inline selector like
 * `useBlueprintDoc((s) => ({ modules: s.modules, forms: s.forms, fields: s.fields }))`
 * allocates a new object every store change, so the default `Object.is`
 * comparison inside zustand fails and the caller re-renders even for
 * unrelated state transitions.
 *
 * This hook uses `useBlueprintDocShallow`, which runs shallow equality
 * across the selector output — so long as the three maps are all the
 * same reference as last render, the caller gets the same object back
 * and skips the re-render.
 *
 * Consumers should NOT memoize the returned object by wrapping it in
 * `useMemo` — it is already reference-stable when the underlying data
 * hasn't changed, courtesy of Immer structural sharing + shallow
 * equality. A `useMemo` wrap would just add overhead.
 */

"use client";

import type { Uuid } from "@/lib/doc/types";
import type { Field, Form, Module } from "@/lib/domain";
import { useBlueprintDocShallow } from "./useBlueprintDoc";

/**
 * Shape of `useDocEntityMaps()` output — all three normalized entity
 * maps keyed by uuid. Read-only because the maps live inside the
 * Zustand store; mutations flow through `applyMany`, not direct writes.
 */
export interface DocEntityMaps {
	modules: Readonly<Record<Uuid, Module>>;
	forms: Readonly<Record<Uuid, Form>>;
	fields: Readonly<Record<Uuid, Field>>;
}

export function useDocEntityMaps(): DocEntityMaps {
	return useBlueprintDocShallow((s) => ({
		modules: s.modules,
		forms: s.forms,
		fields: s.fields,
	}));
}
