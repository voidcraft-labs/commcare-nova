"use client";
import { Icon } from "@iconify/react/offline";
import tablerArrowBackUp from "@iconify-icons/tabler/arrow-back-up";
import tablerHome from "@iconify-icons/tabler/home";
import tablerTable from "@iconify-icons/tabler/table";
import { useCallback, useId } from "react";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useForm } from "@/lib/doc/hooks/useEntity";
import { asUuid } from "@/lib/doc/types";
import { defaultPostSubmit, type PostSubmitDestination } from "@/lib/domain";
import { SelectMenu, type SelectMenuOption } from "./SelectMenu";
import type { FormSettingsSectionProps } from "./types";

/**
 * User-facing destination options. HQ also supports `root` and
 * `parent_module` as legacy equivalents of `app_home` and `module`
 * respectively; we fold those down to the canonical values via
 * `resolveUserFacing` before rendering so the menu only ever shows one
 * label per semantic destination.
 */
const AFTER_SUBMIT_OPTIONS: ReadonlyArray<
	SelectMenuOption<PostSubmitDestination> & {
		description: string;
		icon: typeof tablerHome;
	}
> = [
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
export function AfterSubmitSection({ formUuid }: FormSettingsSectionProps) {
	const form = useForm(formUuid);
	const { updateForm } = useBlueprintMutations();
	const formType = form?.type ?? "survey";
	const current = resolveUserFacing(
		form?.postSubmit ?? defaultPostSubmit(formType),
	);
	const triggerId = useId();

	const handleSelect = useCallback(
		(dest: PostSubmitDestination) => {
			updateForm(asUuid(formUuid), {
				postSubmit: dest === defaultPostSubmit(formType) ? undefined : dest,
			});
		},
		[updateForm, formUuid, formType],
	);

	return (
		<div>
			<label
				htmlFor={triggerId}
				className="text-xs font-medium text-nova-text-secondary uppercase tracking-wider mb-1.5 block"
			>
				After Submit
			</label>
			<SelectMenu
				triggerId={triggerId}
				value={current}
				options={AFTER_SUBMIT_OPTIONS}
				onChange={handleSelect}
				renderTrigger={(v, opts) => {
					const opt = opts.find((o) => o.value === v) ?? opts[0];
					return <span>{opt.label}</span>;
				}}
				renderItem={(opt, isActive) => {
					// Every AFTER_SUBMIT_OPTIONS entry carries `icon` + `description`;
					// the cast narrows from the base SelectMenuOption shape. Safe
					// because `options` above is typed as the extended shape.
					const rich = opt as (typeof AFTER_SUBMIT_OPTIONS)[number];
					return (
						<>
							<Icon
								icon={rich.icon}
								width="16"
								height="16"
								className={
									isActive ? "text-nova-violet-bright" : "text-nova-text-muted"
								}
							/>
							<span className="flex-1 text-left">
								<div>{rich.label}</div>
								<div
									className={`text-xs leading-tight ${
										isActive
											? "text-nova-violet-bright/60"
											: "text-nova-text-muted"
									}`}
								>
									{rich.description}
								</div>
							</span>
						</>
					);
				}}
			/>
		</div>
	);
}
