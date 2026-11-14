/**
 * The chip a calculated value in text draws: its formula, printed in the
 * text's slot, in the mono face. A long formula truncates by width and shows
 * whole as the chip's title. Its dimensions are the reference chip's
 * (`config.ts::CHIP`), in neutral colors, since a value names no one source.
 */

"use client";
import { Icon } from "@iconify/react/offline";
import tablerMathFunction from "@iconify-icons/tabler/math-function";
import type { ReactNode } from "react";
import { useProseValueText } from "@/lib/doc/hooks/useXPathSlots";
import type { ProseValuePart } from "@/lib/domain";
import { CHIP } from "./config";
import { unresolvedReferenceProjection } from "./provider";
import { UnresolvedReferenceChip } from "./ReferenceChip";
import { useCurrentProseSlot } from "./ReferenceContext";

/** A calculated value as its chip, printed in the slot of the nearest
 *  `ProseSlotScope`; the repair chip where the formula no longer prints or
 *  the text has no slot. */
export function ProseValueAtom({
	part,
}: {
	readonly part: ProseValuePart;
}): ReactNode {
	const text = useProseValueText(part, useCurrentProseSlot());
	return text === undefined ? (
		<UnresolvedReferenceChip unresolved={unresolvedReferenceProjection(part)} />
	) : (
		<ValueChip text={text} />
	);
}

export function ValueChip({ text }: { readonly text: string }) {
	return (
		<span
			className="inline-flex items-center border border-nova-border bg-nova-surface font-medium font-mono text-nova-text-secondary leading-none select-none align-baseline"
			style={{
				gap: CHIP.gap,
				paddingInline: CHIP.paddingX,
				height: CHIP.height,
				borderRadius: CHIP.borderRadius,
				fontSize: CHIP.fontSize,
			}}
			title={text}
			data-prose-value=""
		>
			<Icon
				icon={tablerMathFunction}
				width={CHIP.iconSize}
				height={CHIP.iconSize}
				className="shrink-0"
			/>
			<span
				className="overflow-hidden text-ellipsis whitespace-nowrap"
				style={{ maxWidth: CHIP.maxLabelWidth }}
			>
				{text}
			</span>
		</span>
	);
}
