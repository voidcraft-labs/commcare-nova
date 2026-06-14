/**
 * App-wide Connect-id subscription for the authoring commit guards.
 *
 * Connect ids must be unique across the whole app (each keys a per-kind DB
 * slug on the Connect side and an XForm element name), so the field-level
 * validity check in `LearnConfig` / `DeliverConfig` needs every OTHER
 * form's connect ids — not just the co-located block's. This hook is the
 * named domain entry point for that read; components must not reach the raw
 * selector hook directly (Biome `noRestrictedImports` enforces).
 *
 * Returns a flat, document-ordered list of every connect id currently set
 * anywhere in the app, tagged with its owning form + kind so a caller can
 * exclude the slot it's editing (its own id must not read as a self-
 * conflict). The list is compared by value (`useBlueprintDocEq` with a
 * structural comparator) so an edit elsewhere in the doc that leaves the
 * connect ids unchanged doesn't re-render the guard.
 */
import { useBlueprintDocEq } from "@/lib/doc/hooks/useBlueprintDoc";
import type { Uuid } from "@/lib/doc/types";

/** The four Connect sub-config kinds whose ids share the app-wide namespace. */
export type ConnectIdKind =
	| "learn_module"
	| "assessment"
	| "deliver_unit"
	| "task";

/**
 * The connect kinds that are "live" for an app mode. Only these count toward
 * the uniqueness scope — matching the emit resolver (`buildConnectSlugMap`)
 * and the `CONNECT_ID_DUPLICATE` validator rule, which both process only
 * mode-matching kinds. A stray cross-mode block (e.g. a `deliver_unit` left
 * on a form after switching to learn) is therefore not "taken", so all four
 * uniqueness scopes agree. `null` (not in Connect mode) → no live kinds.
 */
function liveKindsFor(
	connectType: "learn" | "deliver" | null,
): readonly ConnectIdKind[] {
	if (connectType === "learn") return ["learn_module", "assessment"];
	if (connectType === "deliver") return ["deliver_unit", "task"];
	return [];
}

/** One set connect id, located by the form + kind that owns it. */
export interface AppConnectId {
	formUuid: Uuid;
	kind: ConnectIdKind;
	id: string;
}

/** Stable structural comparison — re-render only when the located id set
 *  actually changes (Immer reallocates the forms map on unrelated edits). */
function sameIds(
	a: readonly AppConnectId[],
	b: readonly AppConnectId[],
): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (x.formUuid !== y.formUuid || x.kind !== y.kind || x.id !== y.id) {
			return false;
		}
	}
	return true;
}

/**
 * Every connect id set across the app, in document order. Empty when the
 * app has no connect blocks.
 */
export function useAppConnectIds(): readonly AppConnectId[] {
	return useBlueprintDocEq((s) => {
		const liveKinds = liveKindsFor(s.connectType);
		const out: AppConnectId[] = [];
		for (const moduleUuid of s.moduleOrder) {
			for (const formUuid of s.formOrder[moduleUuid] ?? []) {
				const connect = s.forms[formUuid]?.connect;
				if (!connect) continue;
				for (const kind of liveKinds) {
					const id = connect[kind]?.id;
					if (id) out.push({ formUuid, kind, id });
				}
			}
		}
		return out;
	}, sameIds);
}

/**
 * The set of connect ids that a block being edited at `(formUuid, kind)`
 * must stay distinct from — every OTHER block's id app-wide. Excludes the
 * editing slot's own id so a re-save of an unchanged id isn't a self-
 * conflict. Pure helper over {@link useAppConnectIds}'s output so the UI
 * guard and `deriveConnectId` seed share one notion of "taken".
 *
 * This yields the same effective "taken" set as the SA path's
 * `collectConnectIds` + the walk-accumulation in `enforceConnectIds`,
 * just decomposed differently: the UI knows the single `(form, kind)` slot
 * it's editing and excludes exactly that, while the tool excludes the whole
 * form and re-accumulates each co-located id as it walks the merged config.
 * Both enforce "distinct from every other connect id at any other slot."
 */
export function connectIdsExcept(
	all: readonly AppConnectId[],
	formUuid: Uuid,
	kind: ConnectIdKind,
): Set<string> {
	const ids = new Set<string>();
	for (const entry of all) {
		if (entry.formUuid === formUuid && entry.kind === kind) continue;
		ids.add(entry.id);
	}
	return ids;
}
