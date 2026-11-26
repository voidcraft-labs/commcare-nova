"use client";

import { useId } from "react";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import { Input } from "@/components/shadcn/input";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useModule } from "@/lib/doc/hooks/useEntity";
import type { Uuid } from "@/lib/domain";
import { searchResultsNameSchema } from "@/lib/domain/modules";
import { useCanEdit } from "@/lib/session/hooks";
import { useCommitField } from "@/lib/ui/hooks/useCommitField";

export function SearchResultsNameSection({ moduleUuid }: { moduleUuid: Uuid }) {
	const menu = useModule(moduleUuid);
	const canEdit = useCanEdit();
	const { inline } = useBlueprintMutations();
	const id = useId();
	const field = useCommitField({
		value: menu?.searchResultsName ?? "",
		onSave: (name) => {
			const check = searchResultsNameSchema.safeParse(name);
			if (name && !check.success)
				return { ok: false, messages: [check.error.issues[0].message] };
			return inline.updateModule(moduleUuid, {
				searchResultsName: name || undefined,
			});
		},
	});
	return (
		<section>
			<label
				htmlFor={id}
				className="block text-sm font-medium text-nova-text-secondary"
			>
				Search results name
			</label>
			<p id={`${id}-help`} className="mt-1 text-[13px] text-nova-text-muted">
				A name keeps this menu’s search answers separate from a parent menu’s
				answers.
			</p>
			<Input
				id={id}
				ref={field.ref}
				value={field.draft}
				disabled={!canEdit}
				placeholder="Default"
				autoComplete="off"
				onFocus={field.handleFocus}
				onBlur={field.handleBlur}
				onKeyDown={field.handleKeyDown}
				onChange={(event) => field.setDraft(event.target.value)}
				aria-invalid={!!field.rejection}
				aria-describedby={
					field.rejection ? `${id}-help ${id}-error` : `${id}-help`
				}
				className="mt-2 h-11"
			/>
			<RejectionInline id={`${id}-error`} message={field.rejection} />
		</section>
	);
}
