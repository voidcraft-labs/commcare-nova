"use client";
import { Menu } from "@base-ui/react/menu";
import { Icon } from "@iconify/react/offline";
import tablerArrowBackUp from "@iconify-icons/tabler/arrow-back-up";
import tablerHome from "@iconify-icons/tabler/home";
import tablerTable from "@iconify-icons/tabler/table";
import { useCallback, useId, useRef } from "react";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useForm } from "@/lib/doc/hooks/useEntity";
import { asUuid, type Uuid } from "@/lib/doc/types";
import { defaultPostSubmit, type PostSubmitDestination } from "@/lib/domain";
import {
	MENU_ITEM_BASE,
	MENU_ITEM_CLS,
	MENU_POPUP_CLS,
	MENU_SUBMENU_POSITIONER_CLS,
} from "@/lib/styles";

/** Panel prop shape for this section (moduleUuid carried by the shell
 *  even though this section only consumes formUuid). Declared locally —
 *  each section file owns its own contract. */
interface FormSettingsPanelProps {
	moduleUuid: Uuid;
	formUuid: Uuid;
}

/**
 * User-facing destination options. HQ also supports `root` and
 * `parent_module` as legacy equivalents of `app_home` and `module`
 * respectively; we fold those down to the canonical values via
 * `resolveUserFacing` before rendering so the menu only ever shows one
 * label per semantic destination.
 */
const AFTER_SUBMIT_OPTIONS: Array<{
	value: PostSubmitDestination;
	label: string;
	description: string;
	icon: typeof tablerHome;
}> = [
	{
		value: "app_home",
		label: "App Home",
		description: "Back to the main screen",
		icon: tablerHome,
	},
	{
		value: "module",
		label: "This Module",
		description: "Stay in this module's form list",
		icon: tablerTable,
	},
	{
		value: "previous",
		label: "Previous Screen",
		description: "Back to where the user was",
		icon: tablerArrowBackUp,
	},
];

/** Map internal-only values (root, parent_module) to their user-facing equivalent. */
function resolveUserFacing(dest: PostSubmitDestination): PostSubmitDestination {
	if (dest === "root") return "app_home";
	if (dest === "parent_module") return "module";
	return dest;
}

/**
 * Dropdown for "After Submit" — what screen the user lands on after the
 * form is submitted. Writes `undefined` when the choice matches the
 * form-type default so the doc doesn't carry redundant state (a close
 * form defaults to "parent_module"; a registration form defaults to
 * "app_home", etc.).
 */
export function AfterSubmitSection({ formUuid }: FormSettingsPanelProps) {
	const form = useForm(formUuid);
	const { updateForm } = useBlueprintMutations();
	const formType = form?.type ?? "survey";
	const current = resolveUserFacing(
		form?.postSubmit ?? defaultPostSubmit(formType),
	);
	const currentOption =
		AFTER_SUBMIT_OPTIONS.find((o) => o.value === current) ??
		AFTER_SUBMIT_OPTIONS[0];
	const triggerId = useId();
	const triggerRef = useRef<HTMLButtonElement>(null);

	const handleSelect = useCallback(
		(dest: PostSubmitDestination) => {
			updateForm(asUuid(formUuid), {
				postSubmit: dest === defaultPostSubmit(formType) ? undefined : dest,
			});
		},
		[updateForm, formUuid, formType],
	);

	const last = AFTER_SUBMIT_OPTIONS.length - 1;

	return (
		<div>
			<label
				htmlFor={triggerId}
				className="text-xs font-medium text-nova-text-secondary uppercase tracking-wider mb-1.5 block"
			>
				After Submit
			</label>
			<Menu.Root>
				<Menu.Trigger
					ref={triggerRef}
					id={triggerId}
					className="group w-full flex items-center justify-between px-2 py-1.5 text-xs rounded-md border transition-colors cursor-pointer text-nova-text bg-nova-deep/50 border-white/[0.06] hover:border-nova-violet/30"
				>
					<span>{currentOption.label}</span>
					<svg
						aria-hidden="true"
						width="10"
						height="10"
						viewBox="0 0 10 10"
						className="text-nova-text-muted transition-transform group-data-[popup-open]:rotate-180"
					>
						<path
							d="M2 3.5L5 6.5L8 3.5"
							stroke="currentColor"
							strokeWidth="1.2"
							fill="none"
							strokeLinecap="round"
							strokeLinejoin="round"
						/>
					</svg>
				</Menu.Trigger>

				<Menu.Portal>
					<Menu.Positioner
						side="bottom"
						align="start"
						sideOffset={4}
						anchor={triggerRef}
						className={MENU_SUBMENU_POSITIONER_CLS}
						style={{ minWidth: "var(--anchor-width)" }}
					>
						<Menu.Popup className={MENU_POPUP_CLS}>
							{AFTER_SUBMIT_OPTIONS.map((opt, i) => {
								const isActive = opt.value === current;
								const corners =
									i === 0 && i === last
										? "rounded-xl"
										: i === 0
											? "rounded-t-xl"
											: i === last
												? "rounded-b-xl"
												: "";

								return (
									<Menu.Item
										key={opt.value}
										onClick={() => handleSelect(opt.value)}
										className={`${corners} ${
											isActive
												? `${MENU_ITEM_BASE} text-nova-violet-bright bg-nova-violet/10 cursor-pointer`
												: MENU_ITEM_CLS
										}`}
									>
										<Icon
											icon={opt.icon}
											width="16"
											height="16"
											className={
												isActive
													? "text-nova-violet-bright"
													: "text-nova-text-muted"
											}
										/>
										<span className="flex-1 text-left">
											<div>{opt.label}</div>
											<div
												className={`text-xs leading-tight ${
													isActive
														? "text-nova-violet-bright/60"
														: "text-nova-text-muted"
												}`}
											>
												{opt.description}
											</div>
										</span>
									</Menu.Item>
								);
							})}
						</Menu.Popup>
					</Menu.Positioner>
				</Menu.Portal>
			</Menu.Root>
		</div>
	);
}
