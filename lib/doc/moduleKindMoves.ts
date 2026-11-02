/**
 * The move planner for a menu's kind: where an edit changes whether CommCare
 * HQ receives a published menu as an ordinary (basic) module or an advanced
 * one, the move a person is told about, and the hold change it needs.
 *
 * A menu published advanced holds its kind (`Module.heldKind`), which keeps
 * its forms' submission paths (`case_<tag>`) and session values
 * (`case_id_<tag>`, `LoadUpdateAction.case_session_var` in
 * `corehq/apps/app_manager/models/form_actions.py`) where the published app
 * keeps them. Two edits move a published menu's kind:
 *
 * - **A held kind a blocker meets.** The menu can no longer be an advanced
 *   module (`lib/domain/advancedModule.ts::advancedKindBlockers`), so its
 *   held kind is cleared and the menu becomes ordinary.
 * - **A published menu a carried create turns advanced.** A form of an
 *   ordinary menu whose forms hold placements now holds a create an
 *   after-submit link carries that a basic form gives no session value
 *   (`lib/commcare/moduleKind.ts::emittedModuleKind`). Nothing of the menu's
 *   own is held yet, so the move has no hold change: part 01's planner
 *   (`placementMoves.ts`) moves the forms' held basic placements, which an
 *   advanced form cannot use.
 *
 * Either way the forms' held case placements move with the kind, and
 * `withIdentityMoves` runs this planner first, applying its entries to the
 * candidate before part 01's planner reads it. Where the menu selects a
 * parent case, its forms also read the cases chosen through that parent
 * under new session names; that renaming is part of the menu's move, which
 * carries the fact, since the selections are derived and hold nothing.
 *
 * A menu whose kind changes and whose forms hold nothing a publish recorded
 * moves nothing: no move is stated, and the next publish records it.
 *
 * One of the allowlisted `lib/doc` consumers of `lib/commcare` in
 * `biome.json`: whether a menu is emitted advanced is
 * `lib/commcare/moduleKind.ts`'s answer.
 */

import { emittedModuleKind } from "@/lib/commcare/moduleKind";
import { orderedFormUuids } from "@/lib/doc/fieldWalk";
import { formHoldsPlacement } from "@/lib/doc/heldIdentity";
import type { IdentityMove } from "@/lib/doc/identityMoves";
import type { PlacementHoldEntry } from "@/lib/doc/types";
import {
	type AdvancedKindBlocker,
	advancedKindBlockers,
	type BlueprintDoc,
	ownRecordValue,
	type Uuid,
} from "@/lib/domain";

/** Why a menu's kind moves: the first blocker that keeps a held advanced
 *  menu from staying advanced, or `advanced-change`, a form of a published
 *  ordinary menu now saving a case change only an advanced menu can. */
export type ModuleKindMoveReason =
	| AdvancedKindBlocker["kind"]
	| "advanced-change";

type ModuleKindHoldEntry = Extract<
	PlacementHoldEntry,
	{ target: "module-kind" }
>;

export interface ModuleKindMoves {
	/** The `holdPlacements` entries the moves need, in module order: one
	 *  clearing each held kind a blocker meets. */
	readonly holds: readonly ModuleKindHoldEntry[];
	/** Every move of a menu's kind, in module order. */
	readonly moves: readonly IdentityMove[];
}

/**
 * The move of `moduleUuid`'s kind in `after`, to an advanced menu or to an
 * ordinary one. Its reason carries whether the menu selects a parent case
 * in `after`, so the statement can say its forms read the cases chosen
 * through it under new names.
 */
export function moduleKindMove(
	after: BlueprintDoc,
	moduleUuid: Uuid,
	to: "advanced" | "basic",
	reason: ModuleKindMoveReason,
): IdentityMove {
	return {
		subject: { kind: "module-kind", moduleUuid },
		from: to === "advanced" ? "ordinary-menu" : "advanced-menu",
		to: to === "advanced" ? "advanced-menu" : "ordinary-menu",
		reason: {
			source: "module-kind",
			reason,
			chosenCasesRenamed:
				ownRecordValue(after.modules, moduleUuid)?.parentCaseModuleUuid !==
				undefined,
		},
	};
}

/** Whether a form of `moduleUuid` holds a placement a publish recorded. */
function moduleHoldsPlacement(doc: BlueprintDoc, moduleUuid: Uuid): boolean {
	return orderedFormUuids(doc, moduleUuid).some((formUuid) =>
		formHoldsPlacement(doc, formUuid),
	);
}

/**
 * Whether a carried create turned `moduleUuid`, a published ordinary menu of
 * `before`, advanced in `after` without `after` holding the kind. A menu
 * whose kind `after` holds is advanced by its hold, which only a recording
 * or a restore of one writes, so it is no move; a menu whose forms hold
 * nothing in `before` was not published as it is.
 */
function carriedCreateTurnsAdvanced(
	before: BlueprintDoc,
	after: BlueprintDoc,
	moduleUuid: Uuid,
): boolean {
	const module = ownRecordValue(after.modules, moduleUuid);
	return (
		module !== undefined &&
		module.heldKind === undefined &&
		ownRecordValue(before.modules, moduleUuid) !== undefined &&
		moduleHoldsPlacement(before, moduleUuid) &&
		emittedModuleKind(before, moduleUuid) === "basic" &&
		emittedModuleKind(after, moduleUuid) === "advanced"
	);
}

/** The move of every published ordinary menu of `before` that a carried
 *  create turns advanced in `after`, in `after`'s module order. */
export function carriedCreateKindMoves(
	before: BlueprintDoc,
	after: BlueprintDoc,
): readonly IdentityMove[] {
	return after.moduleOrder
		.filter((moduleUuid) =>
			carriedCreateTurnsAdvanced(before, after, moduleUuid),
		)
		.map((moduleUuid) =>
			moduleKindMove(after, moduleUuid, "advanced", "advanced-change"),
		);
}

/**
 * Over `candidate`, the document an edit makes of `prev`, in module order:
 * for each menu whose held advanced kind a blocker meets, the entry clearing
 * the hold and its move to an ordinary menu, with the first blocker as its
 * reason; and for each published ordinary menu a carried create turns
 * advanced, its move to an advanced menu, with no entry. No other move.
 */
export function planModuleKindMoves(
	prev: BlueprintDoc,
	candidate: BlueprintDoc,
): ModuleKindMoves {
	const holds: ModuleKindHoldEntry[] = [];
	const moves: IdentityMove[] = [];
	for (const moduleUuid of candidate.moduleOrder) {
		if (
			ownRecordValue(candidate.modules, moduleUuid)?.heldKind === "advanced"
		) {
			const [blocker] = advancedKindBlockers(candidate, moduleUuid);
			if (blocker === undefined) continue;
			holds.push({ target: "module-kind", moduleUuid, placement: null });
			moves.push(moduleKindMove(candidate, moduleUuid, "basic", blocker.kind));
		} else if (carriedCreateTurnsAdvanced(prev, candidate, moduleUuid))
			moves.push(
				moduleKindMove(candidate, moduleUuid, "advanced", "advanced-change"),
			);
	}
	return { holds, moves };
}
