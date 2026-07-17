/**
 * Reactive view of the no-writer advisories
 * (`lib/doc/noWriterAdvisories.ts`) — a workflow dead-end is a property
 * that gates behavior while nothing in the app writes it (and no
 * external declaration says another system does).
 *
 * Referential stability rides the domain-side memo (per doc
 * reference, same convention as `useEffectiveCaseTypes`), so
 * `Object.is` sees one stable value per doc state. Only the
 * per-carrier flavor exists — a flat whole-app hook has no consumer
 * yet (an app-level advisory rail would be its first), and an
 * unconsumed hook is pure maintenance cost.
 */

"use client";

import type { Uuid } from "@/lib/domain";
import {
	type NoWriterAdvisory,
	noWriterAdvisoriesByCarrier,
} from "../noWriterAdvisories";
import { useBlueprintDoc } from "./useBlueprintDoc";

const EMPTY: readonly NoWriterAdvisory[] = [];

/**
 * The advisories a specific carrier (field / form / module) gate-reads
 * — what that entity's chip announces. Stable `EMPTY` for the common
 * no-advisory case so memoized rows skip re-rendering.
 */
export function useCarrierNoWriterAdvisories(
	uuid: Uuid,
): readonly NoWriterAdvisory[] {
	return useBlueprintDoc(
		(s) => noWriterAdvisoriesByCarrier(s).get(uuid) ?? EMPTY,
	);
}
