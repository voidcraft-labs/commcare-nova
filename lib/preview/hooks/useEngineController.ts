/**
 * useEngineController — read the active `EngineController` from context.
 *
 * The controller owns the form preview's computation engine, doc store
 * subscriptions, and the UUID-keyed runtime store. It is provisioned by
 * `BuilderFormEngineProvider` (see `lib/preview/engine/provider`) — one
 * controller per builder session. This hook is a non-subscribing
 * getter; callers that need to observe per-field runtime state use
 * `useEngineState(uuid)` instead.
 */
"use client";
import type { EngineController } from "@/lib/preview/engine/engineController";
import { useBuilderFormEngine } from "@/lib/preview/engine/provider";

export function useEngineController(): EngineController {
	return useBuilderFormEngine();
}
