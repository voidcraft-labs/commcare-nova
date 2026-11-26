"use client";
import { useId, useState } from "react";
import { ToggleRow } from "@/components/builder/inspector/inspectorChrome";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useModule } from "@/lib/doc/hooks/useEntity";
import {
	useOrderedMenuForms,
	useOrderedModules,
} from "@/lib/doc/hooks/useModuleIds";
import { type Uuid, uuidSchema } from "@/lib/domain";
import { useCanEdit } from "@/lib/session/hooks";

export function ListedFormsSection({ moduleUuid }: { moduleUuid: Uuid }) {
	const route = useModule(moduleUuid);
	const source = useModule(route?.formsFromMenu?.menuUuid);
	const forms = useOrderedMenuForms(source?.uuid);
	const { inline } = useBlueprintMutations();
	const canEdit = useCanEdit();
	const sourceField = useId();
	const options = useOrderedModules().filter(
		(menu) => !menu.formsFromMenu && menu.uuid !== moduleUuid,
	);
	const parent = useModule(route?.parentModuleUuid);
	const [message, setMessage] = useState<string>();
	if (!source || !route?.formsFromMenu) return null;
	const hidden = new Set(route.formsFromMenu.excludedFormUuids);
	return (
		<section aria-label="Forms in this menu" className="space-y-3">
			<h3 className="text-sm font-medium text-nova-text-secondary">
				Forms in this menu
			</h3>
			<p className="text-[13px] text-nova-text-muted">
				These forms also appear in {source.name}. Edits to a form appear in both
				places.
			</p>
			{!parent?.formsFromMenu && (
				<div>
					<label
						htmlFor={sourceField}
						className="text-sm text-nova-text-secondary"
					>
						Source menu
					</label>
					<Select
						value={source.uuid}
						disabled={!canEdit}
						onValueChange={(value) => {
							const id = uuidSchema.safeParse(value);
							if (!id.success) return;
							const result = inline.setListedMenuSource(
								route.uuid,
								source.uuid,
								id.data,
							);
							setMessage(result.ok ? undefined : result.messages.join(" "));
						}}
					>
						<SelectTrigger id={sourceField} className="w-full">
							<SelectValue>{source.name}</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{options.map((menu) => (
								<SelectItem key={menu.uuid} value={menu.uuid}>
									{menu.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			)}

			{forms.map((form) => (
				<ToggleRow
					key={form.uuid}
					label={form.name}
					checked={!hidden.has(form.uuid)}
					disabledReason={canEdit ? undefined : "You can view this app."}
					onChange={(included) => {
						const result = inline.setFormListed(
							route.uuid,
							source.uuid,
							form.uuid,
							included,
						);
						setMessage(result.ok ? undefined : result.messages.join(" "));
					}}
				/>
			))}
			{message && (
				<p role="alert" className="text-[13px] text-nova-rose">
					{message}
				</p>
			)}
		</section>
	);
}
