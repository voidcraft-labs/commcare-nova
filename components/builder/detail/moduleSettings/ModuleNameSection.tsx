"use client";

import { useCallback, useId } from "react";
import { SavedCheck } from "@/components/builder/EditableTitle";
import { RejectionInline } from "@/components/builder/RejectionNotice";
import { Input } from "@/components/shadcn/input";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import { useModule } from "@/lib/doc/hooks/useEntity";
import type { Uuid } from "@/lib/doc/types";
import { useCommitField } from "@/lib/ui/hooks/useCommitField";
import { useRejectionShake } from "@/lib/ui/hooks/useShake";

/**
 * A bare case-list module has no separate module screen, so its name belongs in
 * the settings panel reached from the workspace tabs. Form-bearing modules keep
 * their existing inline title on the module screen; rendering this only for the
 * bare shape prevents a duplicated setting.
 */
export function ModuleNameSection({
	moduleUuid,
}: {
	readonly moduleUuid: Uuid;
}) {
	const module = useModule(moduleUuid);
	const { inline } = useBlueprintMutations();
	const fieldId = useId();
	const saveName = useCallback(
		(name: string) => inline.updateModule(moduleUuid, { name }),
		[inline, moduleUuid],
	);
	const {
		draft,
		setDraft,
		focused,
		saved,
		rejection,
		rejectionNonce,
		ref,
		handleFocus,
		handleBlur,
		handleKeyDown,
	} = useCommitField({
		value: module?.name ?? "",
		onSave: saveName,
		required: true,
	});
	const shakeProps = useRejectionShake(rejectionNonce);

	if (!module?.caseListOnly) return null;
	const rejectionId = `${fieldId}-rejection`;

	return (
		<section aria-labelledby={`${fieldId}-label`}>
			<label
				id={`${fieldId}-label`}
				htmlFor={fieldId}
				className="flex items-center gap-1.5 text-sm font-medium text-nova-text-secondary"
			>
				Module name
				<SavedCheck
					visible={saved && !focused}
					size={14}
					className="shrink-0"
				/>
			</label>
			<Input
				id={fieldId}
				ref={ref}
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
				onFocus={handleFocus}
				onBlur={handleBlur}
				onKeyDown={handleKeyDown}
				onAnimationEnd={shakeProps.onAnimationEnd}
				required
				autoComplete="off"
				data-1p-ignore
				aria-invalid={rejection ? true : undefined}
				aria-describedby={rejection ? rejectionId : undefined}
				className={`mt-2 h-11 text-[14px] ${shakeProps.className}`}
			/>
			<RejectionInline id={rejectionId} message={rejection} />
		</section>
	);
}
