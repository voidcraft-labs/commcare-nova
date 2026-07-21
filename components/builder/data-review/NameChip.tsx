import type { IconifyIcon } from "@iconify/react/offline";
import { Icon } from "@iconify/react/offline";
import tabler123 from "@iconify-icons/tabler/123";
import tablerCalendar from "@iconify-icons/tabler/calendar";
import tablerCircleDot from "@iconify-icons/tabler/circle-dot";
import tablerClock from "@iconify-icons/tabler/clock";
import tablerDatabase from "@iconify-icons/tabler/database";
import tablerDecimal from "@iconify-icons/tabler/decimal";
import tablerForms from "@iconify-icons/tabler/forms";
import tablerMapPin from "@iconify-icons/tabler/map-pin";
import tablerSquareCheck from "@iconify-icons/tabler/square-check";
import type { CasePropertyDataType } from "@/lib/preview/engine/caseDataBindingTypes";
import { CHIP, REF_TYPE_CONFIG } from "@/lib/references/config";

/**
 * The property's current data type as a chip icon — the same icons
 * the field palette uses for the kinds that write each type, so the
 * chip shows what the property holds NOW in vocabulary the builder
 * already taught. `datetime` shares the clock with `time` exactly as
 * the field kinds do.
 */
export const DATA_TYPE_ICONS: Record<CasePropertyDataType, IconifyIcon> = {
	text: tablerForms,
	int: tabler123,
	decimal: tablerDecimal,
	date: tablerCalendar,
	time: tablerClock,
	datetime: tablerClock,
	single_select: tablerCircleDot,
	multi_select: tablerSquareCheck,
	geopoint: tablerMapPin,
};

/**
 * A case identifier — a property id, a case-type name — rendered as a
 * variant of the `#case/property` reference chip (`lib/references`):
 * the case family's violet tint, mono id, and 4px radius, sharing the
 * `CHIP` dimension constants so the two can't drift. Two deliberate
 * departures from the editor chip: the label wraps instead of
 * ellipsizing (review surfaces must keep long authored ids legible),
 * and text stays selectable (these are data screens, not documents).
 *
 * `icon` defaults to the case family's database mark; pass a
 * `DATA_TYPE_ICONS` entry with an `iconLabel` to show the property's
 * current type instead (the label is the icon's screen-reader name —
 * without it the icon is decorative).
 */
export function NameChip({
	label,
	icon,
	iconLabel,
}: {
	readonly label: string;
	readonly icon?: IconifyIcon;
	readonly iconLabel?: string;
}) {
	const config = REF_TYPE_CONFIG.case;
	return (
		<span
			className={`inline-flex items-center border align-middle font-mono font-medium ${config.bgClass} ${config.textClass} ${config.borderClass}`}
			style={{
				gap: CHIP.gap,
				paddingInline: CHIP.paddingX,
				minHeight: CHIP.height,
				borderRadius: CHIP.borderRadius,
				fontSize: CHIP.fontSize,
			}}
		>
			<Icon
				icon={icon ?? tablerDatabase}
				width={CHIP.iconSize}
				height={CHIP.iconSize}
				className="shrink-0"
				{...(iconLabel === undefined
					? { "aria-hidden": true }
					: { role: "img", "aria-label": iconLabel })}
			/>
			<span className="whitespace-normal [overflow-wrap:anywhere]">
				{label}
			</span>
		</span>
	);
}
