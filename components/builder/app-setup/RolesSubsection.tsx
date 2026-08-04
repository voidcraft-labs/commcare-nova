/**
 * Roles: reusable templates that fill worker information with defaults.
 *
 * A role is not a person and never becomes one: it says what every worker
 * in that role carries. Personas hold a role; a deployed worker is created
 * from one. Removing a role personas still hold is refused rather than
 * quietly unassigning them (`removeUserTypePlan`).
 */
"use client";

import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Textarea } from "@/components/shadcn/textarea";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import {
	usePersonas,
	useUserProperties,
	useUserTypes,
} from "@/lib/doc/hooks/useUserCollections";
import { asUuid } from "@/lib/doc/types";
import { ownRecordValue, type UserType } from "@/lib/domain";
import { useCanEdit } from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { useInlineConfirmFocus } from "@/lib/ui/hooks/useInlineConfirmFocus";
import { DraftCommitInput } from "./DraftCommitField";
import { EntryRow, Subsection, SubsectionEmpty } from "./subsection";
import { ValueField } from "./ValueField";

export function RolesSubsection() {
	const roles = useUserTypes();
	const properties = useUserProperties();
	const personas = usePersonas();
	const canEdit = useCanEdit();
	const sessionApi = useBuilderSessionApi();
	const mutations = useBlueprintMutations();
	const [openUuid, setOpenUuid] = useState<string | undefined>(undefined);
	const [focusUuid, setFocusUuid] = useState<string | undefined>(undefined);
	const addButtonRef = useRef<HTMLButtonElement>(null);

	const add = () => {
		if (!sessionApi.getState().canEdit) return;
		const result = mutations.addUserType({ name: uniqueName(roles) });
		if (result.ok) {
			setOpenUuid(result.uuid);
			setFocusUuid(result.uuid);
		}
	};

	return (
		<Subsection
			id="app-setup-roles"
			title="Roles"
			description="A role holds the default information for one kind of worker. Personas can use a role and still override individual values."
			addLabel="Add role"
			onAdd={add}
			canEdit={canEdit}
			addButtonRef={addButtonRef}
		>
			{roles.length === 0 ? (
				<SubsectionEmpty>
					No roles yet. Add one when more than one kind of worker uses this app.
				</SubsectionEmpty>
			) : (
				roles.map((role) => (
					<RoleRow
						key={role.uuid}
						role={role}
						properties={properties}
						holderCount={
							personas.filter((p) => p.userTypeUuid === role.uuid).length
						}
						open={openUuid === role.uuid}
						onOpenChange={(next) => setOpenUuid(next ? role.uuid : undefined)}
						focusOnMount={focusUuid === role.uuid}
						onFocused={() => setFocusUuid(undefined)}
						returnFocusRef={addButtonRef}
					/>
				))
			)}
		</Subsection>
	);
}

function uniqueName(peers: readonly UserType[]): string {
	const taken = new Set(peers.map((p) => p.name.trim().toLowerCase()));
	if (!taken.has("new role")) return "New role";
	for (let n = 2; ; n++) {
		const candidate = `New role ${n}`;
		if (!taken.has(candidate.toLowerCase())) return candidate;
	}
}

function RoleRow({
	role,
	properties,
	holderCount,
	open,
	onOpenChange,
	focusOnMount,
	onFocused,
	returnFocusRef,
}: {
	role: UserType;
	properties: ReturnType<typeof useUserProperties>;
	holderCount: number;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	focusOnMount: boolean;
	onFocused: () => void;
	returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
	const canEdit = useCanEdit();
	const sessionApi = useBuilderSessionApi();
	const mutations = useBlueprintMutations();
	const nameId = useId();
	const descriptionId = useId();
	const [confirmingRemove, setConfirmingRemove] = useState(false);
	const [refusal, setRefusal] = useState<string | undefined>(undefined);
	const nameRef = useRef<HTMLInputElement>(null);
	const { triggerRef, panelRef } = useInlineConfirmFocus(confirmingRemove);

	useEffect(() => {
		if (!focusOnMount) return;
		nameRef.current?.focus();
		onFocused();
	}, [focusOnMount, onFocused]);

	const write = (patch: Parameters<typeof mutations.updateUserType>[1]) => {
		if (!sessionApi.getState().canEdit) return;
		mutations.updateUserType(role.uuid, patch);
	};

	const setValue = (propertyUuid: string, value: string | undefined) => {
		if (!sessionApi.getState().canEdit) return;
		mutations.updateUserTypeValue(role.uuid, asUuid(propertyUuid), value);
	};

	return (
		<EntryRow
			open={open}
			onOpenChange={onOpenChange}
			summary={
				<span className="text-[13px] font-medium text-nova-text">
					{role.name}
				</span>
			}
			detail={
				holderCount > 0
					? `${holderCount} ${holderCount === 1 ? "persona" : "personas"}`
					: undefined
			}
		>
			<div className="flex flex-col gap-4">
				<div className="flex flex-col gap-1.5">
					<label
						htmlFor={nameId}
						className="text-[12px] font-medium text-nova-text-secondary"
					>
						Name
					</label>
					<DraftCommitInput
						inputRef={nameRef}
						id={nameId}
						value={role.name}
						disabled={!canEdit}
						validate={(value) =>
							value === "" ? "Enter a name for this role." : undefined
						}
						onCommit={(name) => {
							if (!sessionApi.getState().canEdit) {
								return {
									ok: false,
									messages: ["You no longer have edit access."],
								};
							}
							return mutations.inline.updateUserType(role.uuid, {
								name,
							});
						}}
					/>
				</div>

				<div className="flex flex-col gap-1.5">
					<label
						htmlFor={descriptionId}
						className="text-[12px] font-medium text-nova-text-secondary"
					>
						What this role does
					</label>
					<Textarea
						id={descriptionId}
						value={role.description ?? ""}
						disabled={!canEdit}
						autoComplete="off"
						data-1p-ignore
						rows={2}
						placeholder="A note for whoever reads this app next."
						onChange={(e) =>
							write({
								description: e.target.value === "" ? null : e.target.value,
							})
						}
						className="text-[13px]"
					/>
				</div>

				<div className="flex flex-col gap-3">
					<h4 className="text-[12px] font-medium text-nova-text-secondary">
						Default worker information
					</h4>
					{properties.length === 0 ? (
						<p className="text-[13px] leading-relaxed text-nova-text-muted">
							Add worker information above and this role can set defaults for
							it.
						</p>
					) : (
						properties.map((property) => (
							<ValueField
								key={property.uuid}
								property={property}
								value={ownRecordValue(role.values, property.uuid)}
								disabled={!canEdit}
								onChange={(next) => setValue(property.uuid, next)}
							/>
						))
					)}
				</div>

				{canEdit &&
					(confirmingRemove ? (
						<div
							ref={panelRef}
							tabIndex={-1}
							className="flex flex-col gap-2 rounded-lg border border-nova-rose/40 bg-nova-rose/[0.06] p-3 outline-none"
						>
							<p className="text-[13px] leading-relaxed text-nova-text">
								Remove {role.name}?
							</p>
							{/* `role="alert"` rather than a polite region: this appears
							 * only after someone presses Remove and nothing else on
							 * screen changes, so a passive announcement would let the
							 * refusal pass unnoticed and the press read as a no-op. */}
							{refusal !== undefined && (
								<p
									role="alert"
									className="text-[13px] leading-relaxed text-nova-rose"
								>
									{refusal}
								</p>
							)}
							<div className="flex items-center gap-2">
								<Button
									type="button"
									variant="destructive"
									onClick={() => {
										if (!sessionApi.getState().canEdit) return;
										const outcome = mutations.inline.removeUserType(role.uuid);
										if (!outcome.ok) setRefusal(outcome.messages[0]);
										else returnFocusRef.current?.focus();
									}}
								>
									Remove
								</Button>
								<Button
									type="button"
									variant="ghost"
									onClick={() => {
										setConfirmingRemove(false);
										setRefusal(undefined);
									}}
								>
									Cancel
								</Button>
							</div>
						</div>
					) : (
						<Button
							ref={triggerRef}
							type="button"
							variant="ghost-destructive"
							onClick={() => setConfirmingRemove(true)}
							className="self-start"
						>
							Remove role
						</Button>
					))}
			</div>
		</EntryRow>
	);
}
