"use client";
import { Icon } from "@iconify/react/offline";
import tablerListDetails from "@iconify-icons/tabler/list-details";
import { motion } from "motion/react";
import { ProjectMediaImage } from "@/components/builder/media/ProjectMediaResource";
import { Badge } from "@/components/shadcn/badge";
import type { Form } from "@/lib/domain";
import { formTypeIcons } from "@/lib/domain/formTypeIcons";
import type { PreviewCaseListMenuEntry } from "@/lib/preview/menuProjection";
import { PreviewMenuChoice } from "./MenuLayout";

const ROW_CLASS =
	"nova-focusable w-full flex items-center gap-3 p-3 rounded-lg bg-pv-surface border border-pv-input-border hover:border-pv-input-focus transition-all duration-200 cursor-pointer text-left group";

function rowTransition(index: number) {
	return {
		delay: index * 0.06,
		duration: 0.3,
		ease: [0.16, 1, 0.3, 1] as const,
	};
}

/** The image on a form command in any worker menu, with the type glyph as fallback. */
export function PreviewFormChoiceIcon({
	form,
}: {
	readonly form: Pick<Form, "icon" | "type">;
}) {
	return form.icon ? (
		// Form menu-tile icon: CommCare shows it on the form's command.
		<ProjectMediaImage
			assetId={form.icon}
			alt=""
			className="size-7 rounded-lg object-cover shrink-0"
		/>
	) : (
		<Icon
			icon={formTypeIcons[form.type]}
			width="18"
			height="18"
			className="text-nova-text-muted group-hover:text-pv-accent-bright transition-colors shrink-0"
		/>
	);
}

/** One form a running screen lists: the form's name, icon and type glyph,
 *  whichever menu holds it. */
export function PreviewFormRow({
	form,
	badge,
	label,
	index,
	onClick,
}: {
	readonly badge?: string | undefined;
	readonly form: Pick<Form, "uuid" | "icon" | "type" | "audioLabel">;
	readonly label: string;
	readonly index: number;
	readonly onClick: () => void;
}) {
	return (
		<PreviewMenuChoice audioLabel={form.audioLabel} label={label}>
			<motion.button
				type="button"
				data-menu-screen-form={form.uuid}
				initial={{ opacity: 0, y: 12 }}
				animate={{ opacity: 1, y: 0 }}
				transition={rowTransition(index)}
				onClick={onClick}
				className={ROW_CLASS}
			>
				<PreviewFormChoiceIcon form={form} />
				<div className="flex-1 min-w-0">
					<div className="text-sm font-medium text-nova-text">{label}</div>
				</div>
				{badge && <Badge variant="muted">{badge}</Badge>}
			</motion.button>
		</PreviewMenuChoice>
	);
}

/** One menu's case list entry a running screen lists, after that menu's
 *  forms (`menuProjection.ts::previewCaseListMenuEntry`). */
export function PreviewCaseListRow({
	entry,
	label,
	index,
	onClick,
}: {
	readonly entry: Pick<PreviewCaseListMenuEntry, "icon" | "audioLabel">;
	readonly label: string;
	readonly index: number;
	readonly onClick: () => void;
}) {
	return (
		<PreviewMenuChoice audioLabel={entry.audioLabel} label={label}>
			<motion.button
				type="button"
				data-case-list-menu-entry
				initial={{ opacity: 0, y: 12 }}
				animate={{ opacity: 1, y: 0 }}
				transition={rowTransition(index)}
				onClick={onClick}
				className={ROW_CLASS}
			>
				{entry.icon ? (
					<ProjectMediaImage
						assetId={entry.icon}
						alt=""
						className="size-7 rounded-lg object-cover shrink-0"
					/>
				) : (
					<Icon
						icon={tablerListDetails}
						width="18"
						height="18"
						className="text-nova-text-muted group-hover:text-pv-accent-bright transition-colors shrink-0"
					/>
				)}
				<div className="flex-1 min-w-0">
					<div className="text-sm font-medium text-nova-text">{label}</div>
				</div>
			</motion.button>
		</PreviewMenuChoice>
	);
}
