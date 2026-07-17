/**
 * Reactive views of the no-writer advisories
 * (`lib/doc/noWriterAdvisories.ts`) — a workflow dead-end is a property
 * that gates behavior while nothing in the app writes it (and no
 * external declaration says another system does).
 *
 * Referential stability rides the domain-side memo (per doc
 * reference, same convention as `useEffectiveCaseTypes`), so
 * `Object.is` sees one stable value per doc state.
 */

"use client";

import type { Uuid } from "@/lib/domain";
import {
	type NoWriterAdvisory,
	noWriterAdvisories,
	noWriterAdvisoriesByCarrier,
} from "../noWriterAdvisories";
import { useBlueprintDoc } from "./useBlueprintDoc";

const EMPTY: readonly NoWriterAdvisory[] = [];

/** Every advisory the doc currently carries, in catalog order. */
export function useNoWriterAdvisories(): readonly NoWriterAdvisory[] {
	return useBlueprintDoc((s) => noWriterAdvisories(s));
}

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
