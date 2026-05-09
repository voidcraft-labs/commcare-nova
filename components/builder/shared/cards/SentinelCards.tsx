// components/builder/shared/cards/SentinelCards.tsx
//
// Discriminator-only sentinel cards — `match-all` (always true)
// and `match-none` (always false). Each renders a no-config status
// row; the kind-picker chrome lives in the parent group.

"use client";
import { Icon } from "@iconify/react/offline";
import tablerAsterisk from "@iconify-icons/tabler/asterisk";
import tablerSlash from "@iconify-icons/tabler/slash";
import type { Predicate } from "@/lib/domain/predicate";
import type { EditorPath } from "../path";

/** Props for `MatchAllCard`. The `kind: "match-all"` arm is
 *  discriminator-only at the AST layer, so the props carry the
 *  precisely-narrowed shape rather than the wider `Predicate`
 *  union — matches the per-arm typing convention every other
 *  card uses. */
interface MatchAllCardProps {
	readonly value: Extract<Predicate, { kind: "match-all" }>;
	readonly onChange: (next: Predicate) => void;
	readonly path: EditorPath;
}

/** Props for `MatchNoneCard`. Mirrors `MatchAllCardProps`. */
interface MatchNoneCardProps {
	readonly value: Extract<Predicate, { kind: "match-none" }>;
	readonly onChange: (next: Predicate) => void;
	readonly path: EditorPath;
}

export function MatchAllCard(_props: MatchAllCardProps) {
	return (
		<div className="flex items-center gap-2 px-2 py-2 rounded-md border border-dashed border-white/[0.06] bg-nova-surface/20">
			<Icon
				icon={tablerAsterisk}
				width="14"
				height="14"
				className="text-nova-violet-bright/70"
			/>
			<div className="text-xs">
				<div className="text-nova-text">Always true — matches every case.</div>
				<div className="text-[10px] text-nova-text-muted/70">
					The boolean-algebra identity element. Combine with other clauses to
					keep them as no-ops.
				</div>
			</div>
		</div>
	);
}

export function MatchNoneCard(_props: MatchNoneCardProps) {
	return (
		<div className="flex items-center gap-2 px-2 py-2 rounded-md border border-dashed border-white/[0.06] bg-nova-surface/20">
			<Icon
				icon={tablerSlash}
				width="14"
				height="14"
				className="text-nova-text-muted"
			/>
			<div className="text-xs">
				<div className="text-nova-text">Always false — matches no case.</div>
				<div className="text-[10px] text-nova-text-muted/70">
					The boolean-algebra absorbing element. Useful as an explicit
					"disabled" filter state.
				</div>
			</div>
		</div>
	);
}
