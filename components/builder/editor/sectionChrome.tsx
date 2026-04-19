/**
 * Shared chrome for editor sections — the card wrapper class and the
 * uppercase micro-label with a violet accent bar.
 *
 * Extracted so every panel that composes labelled settings cards
 * shares one visual definition. Style-drift between panels would
 * be a silent UI bug; single ownership here prevents it.
 */
"use client";

/** Card styling for a labelled settings section: rounded, frosted
 *  violet-tinted background, hairline border. Keep this in sync
 *  across every panel that composes sections so the inspector and
 *  form-detail panels share one visual language. */
export const SECTION_CARD_CLASS =
	"rounded-md bg-nova-surface/40 border border-white/[0.04] px-3 py-2.5";

/** Uppercase micro-label with a left-aligned violet accent bar.
 *  Used as the heading of a settings-section card — pairs with
 *  `SECTION_CARD_CLASS`. */
export function SectionLabel({ label }: { label: string }) {
	return (
		<div className="flex items-center gap-2 mb-2">
			<div className="w-0.5 h-3 rounded-full bg-nova-violet/40" />
			<span className="text-[10px] font-semibold uppercase tracking-widest text-nova-text-muted/70">
				{label}
			</span>
		</div>
	);
}
