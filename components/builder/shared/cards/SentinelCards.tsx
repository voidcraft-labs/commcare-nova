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
import { PredicateVerbMenu } from "./PredicateVerbMenu";

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

export function MatchAllCard({ value, onChange }: MatchAllCardProps) {
	return (
		<div className="flex flex-wrap items-center gap-2.5">
			<PredicateVerbMenu value={value} onChange={onChange} />
			<div className="flex items-center gap-1.5 text-[11px] text-nova-text-muted leading-snug">
				<Icon
					icon={tablerAsterisk}
					width="13"
					height="13"
					className="text-nova-violet-bright/70 shrink-0"
				/>
				Matches every case — pick a verb above to start filtering.
			</div>
		</div>
	);
}

export function MatchNoneCard({ value, onChange }: MatchNoneCardProps) {
	return (
		<div className="flex flex-wrap items-center gap-2.5">
			<PredicateVerbMenu value={value} onChange={onChange} />
			<div className="flex items-center gap-1.5 text-[11px] text-nova-text-muted leading-snug">
				<Icon
					icon={tablerSlash}
					width="13"
					height="13"
					className="text-nova-text-muted shrink-0"
				/>
				Hides every case — an explicit off switch.
			</div>
		</div>
	);
}
