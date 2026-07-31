/**
 * React chip component for rendering a reference as a styled inline pill.
 *
 * Used by TipTap's React NodeView (CommcareRefView), LabelContent (preview
 * canvas labels), and ExpressionContent (hidden field expressions). Visual
 * dimensions are driven by the shared CHIP constants in config.ts to stay in
 * sync with chipDom.ts (CodeMirror). Colors come from the per-type
 * ReferenceTypeConfig via Tailwind classes.
 */

import { Icon } from "@iconify/react/offline";
import { CHIP, displayId, REF_TYPE_CONFIG } from "./config";
import type { UnresolvedReferenceProjection } from "./provider";
import type { Reference } from "./types";

interface ReferenceChipProps {
	reference: Reference;
}

export function ReferenceChip({ reference }: ReferenceChipProps) {
	const config = REF_TYPE_CONFIG[reference.type];

	return (
		<span
			className={`inline-flex items-center font-mono font-medium leading-none border ${config.bgClass} ${config.textClass} ${config.borderClass} select-none align-baseline`}
			style={{
				gap: CHIP.gap,
				paddingInline: CHIP.paddingX,
				height: CHIP.height,
				borderRadius: CHIP.borderRadius,
				fontSize: CHIP.fontSize,
			}}
			data-ref-raw={reference.raw}
		>
			<Icon
				icon={reference.icon ?? config.icon}
				width={CHIP.iconSize}
				height={CHIP.iconSize}
				className="shrink-0"
			/>
			<span
				className="whitespace-nowrap overflow-hidden text-ellipsis"
				style={{ maxWidth: CHIP.maxLabelWidth }}
			>
				{displayId(reference)}
			</span>
		</span>
	);
}

/** Identity-free human repair state for a typed reference that no longer
 * resolves through its owning document. The stored UUID is intentionally not
 * accepted as a prop, so this renderer cannot leak it into text, attributes,
 * tooltips, or accessible names. */
export function UnresolvedReferenceChip({
	unresolved,
}: {
	unresolved: UnresolvedReferenceProjection;
}) {
	const config = REF_TYPE_CONFIG[unresolved.type];
	const accessibleKind =
		unresolved.type === "form"
			? "Form field"
			: unresolved.type === "user"
				? "Worker information"
				: "Case property";

	return (
		<span
			className={`inline-flex items-center font-medium leading-none border border-dashed ${config.bgClass} ${config.textClass} ${config.borderClass} select-none align-baseline`}
			style={{
				gap: CHIP.gap,
				paddingInline: CHIP.paddingX,
				height: CHIP.height,
				borderRadius: CHIP.borderRadius,
				fontSize: CHIP.fontSize,
			}}
			data-reference-repair={unresolved.referenceKind}
			role="img"
			aria-label={`${accessibleKind} reference needs repair`}
		>
			<Icon
				icon={config.icon}
				width={CHIP.iconSize}
				height={CHIP.iconSize}
				className="shrink-0"
			/>
			<span className="whitespace-nowrap">Reference needs repair</span>
		</span>
	);
}
