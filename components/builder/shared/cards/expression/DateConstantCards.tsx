// components/builder/shared/cards/expression/DateConstantCards.tsx
//
// Discriminator-only cards for the two date constants — `today`
// (project-timezone ISO date) and `now` (UTC ISO datetime). No
// authoring controls; the kind picker chrome on the surrounding
// `ExpressionPicker` shell carries the kind-replace menu.
//
// Same visual language as `SentinelCards` on the Predicate side —
// a one-line status row inside the card body that explains what the
// constant resolves to. The card is intentionally inert so an author
// glancing at the editor reads "this slot is the current date /
// time" without scanning for editable controls.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerCalendarEvent from "@iconify-icons/tabler/calendar-event";
import tablerClock from "@iconify-icons/tabler/clock";
import { now, today, type ValueExpression } from "@/lib/domain/predicate";
import type { ExpressionEditContext } from "../../expressionEditorSchemas";
import type { EditorPath } from "../../path";

/** Default value for the `today` arm. Discriminator-only, so the
 *  factory returns the bare arm shape directly via the builder. */
export function todayDefault(
	_ctx: ExpressionEditContext,
): Extract<ValueExpression, { kind: "today" }> {
	return today();
}

/** Default value for the `now` arm. */
export function nowDefault(
	_ctx: ExpressionEditContext,
): Extract<ValueExpression, { kind: "now" }> {
	return now();
}

interface TodayCardProps {
	readonly value: Extract<ValueExpression, { kind: "today" }>;
	readonly onChange: (next: ValueExpression) => void;
	readonly path: EditorPath;
}

interface NowCardProps {
	readonly value: Extract<ValueExpression, { kind: "now" }>;
	readonly onChange: (next: ValueExpression) => void;
	readonly path: EditorPath;
}

/** Today constant — resolves to the project-timezone ISO date at
 *  evaluation time. The card body is inert; the kind picker on the
 *  parent shell handles the kind-replace affordance. */
export function TodayCard(_props: TodayCardProps) {
	return (
		<div className="flex items-center gap-2 px-2 py-2 rounded-md border border-dashed border-white/[0.06] bg-nova-surface/20">
			<Icon
				icon={tablerCalendarEvent}
				width="14"
				height="14"
				className="text-nova-violet-bright"
			/>
			<div className="text-xs">
				<div className="text-nova-text">
					Resolves to today's date at evaluation time.
				</div>
				<div className="text-[10px] text-nova-text-muted">
					Project-timezone ISO 8601 date (`YYYY-MM-DD`).
				</div>
			</div>
		</div>
	);
}

/** Now constant — resolves to the UTC ISO datetime at evaluation
 *  time. Inert body; same shape as `TodayCard`. */
export function NowCard(_props: NowCardProps) {
	return (
		<div className="flex items-center gap-2 px-2 py-2 rounded-md border border-dashed border-white/[0.06] bg-nova-surface/20">
			<Icon
				icon={tablerClock}
				width="14"
				height="14"
				className="text-nova-violet-bright"
			/>
			<div className="text-xs">
				<div className="text-nova-text">
					Resolves to the current datetime at evaluation time.
				</div>
				<div className="text-[10px] text-nova-text-muted">
					UTC ISO 8601 datetime (`YYYY-MM-DDTHH:MM:SSZ`).
				</div>
			</div>
		</div>
	);
}
