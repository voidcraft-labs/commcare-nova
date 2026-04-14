/**
 * Builder URL location types.
 *
 * `Location` is a discriminated union over every valid URL shape the builder
 * can occupy. The URL is path-based and navigated via the browser History
 * API (pushState/replaceState) — no server round-trips for intra-builder
 * navigation.
 *
 * URL schema (path segments after /build/[id]):
 *
 *   /build/[id]                                   → home
 *   /build/[id]/{moduleUuid}                      → module
 *   /build/[id]/{moduleUuid}/cases                → case list
 *   /build/[id]/{moduleUuid}/cases/{caseId}       → case detail
 *   /build/[id]/{formUuid}                        → form
 *   /build/[id]/{formUuid}/{questionUuid}          → form + selected question
 *
 * All entity UUIDs are globally unique in the doc store. A single UUID
 * segment identifies the entity type by checking `doc.modules[uuid]`,
 * `doc.forms[uuid]`, `doc.questions[uuid]`. For questions, the parent
 * form is derived from the doc's ordering maps.
 */

import type { Uuid } from "@/lib/doc/types";

/**
 * Every valid builder location. Home is the default when the path is
 * empty or unrecognized. Cases and Form require their respective UUID
 * params; a missing or unresolvable UUID collapses to home.
 */
export type Location =
	| { kind: "home" }
	| { kind: "module"; moduleUuid: Uuid }
	| { kind: "cases"; moduleUuid: Uuid; caseId?: string }
	| {
			kind: "form";
			moduleUuid: Uuid;
			formUuid: Uuid;
			selectedUuid?: Uuid;
	  };
