/**
 * Roles — reusable templates that fill worker information with defaults.
 *
 * A role is not a person and never becomes one: it says what every worker
 * in that role carries. Personas hold a role; a deployed worker is created
 * from one. Removing a role personas still hold is refused rather than
 * quietly unassigning them (`removeUserTypePlan`).
 */
"use client";

import { useId, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import { Textarea } from "@/components/shadcn/textarea";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import {
	usePersonas,
	useUserProperties,
	useUserTypes,
} from "@/lib/doc/hooks/useUserCollections";
import type { Uuid } from "@/lib/doc/types";
import type { UserDataValues, UserType } from "@/lib/domain";
import { useCanEdit } from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import {
	EntryRow,
	Subsection,
	SubsectionEmpty,
	useInlineConfirmFocus,
} from "./subsection";
import { ValueField } from "./ValueField";

export function RolesSubsection() {
	const roles = useUserTypes();
	const properties = useUserProperties();
	const personas = usePersonas();
	const canEdit = useCanEdit();
	const sessionApi = useBuilderSessionApi();
	const mutations = useBlueprintMutations();
	const [openUuid, setOpenUuid] = useState<string | undefined>(undefined);

	const add = () => {
		if (!sessionApi.getState().canEdit) return;
		const result = mutations.addUserType({ name: uniqueName(roles) });
		if (result.ok) setOpenUuid(result.uuid);
	};

	return (
		<Subsection
			id="app-setup-roles"
			title="Roles"
			description="A role bundles the worker information a kind of worker carries — every community health worker starts with the same defaults. A persona holds a role; a role on its own is a template, not a person."
			addLabel="Add role"
			onAdd={add}
			canEdit={canEdit}
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
}: {
	role: UserType;
	properties: ReturnType<typeof useUserProperties>;
	holderCount: number;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const canEdit = useCanEdit();
	const sessionApi = useBuilderSessionApi();
	const mutations = useBlueprintMutations();
	const nameId = useId();
	const descriptionId = useId();
	const [confirmingRemove, setConfirmingRemove] = useState(false);
	const [refusal, setRefusal] = useState<string | undefined>(undefined);
	const { triggerRef, panelRef } = useInlineConfirmFocus(confirmingRemove);

	const write = (patch: Parameters<typeof mutations.updateUserType>[1]) => {
		if (!sessionApi.getState().canEdit) return;
		mutations.updateUserType(role.uuid as Uuid, patch);
	};

	const setValue = (propertyUuid: string, value: string) => {
		const next: UserDataValues = { ...(role.values ?? {}) };
		if (value === "") delete next[propertyUuid];
		else next[propertyUuid] = value;
		write({ values: Object.keys(next).length > 0 ? next : null });
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
					<Input
						id={nameId}
						value={role.name}
						disabled={!canEdit}
						autoComplete="off"
						data-1p-ignore
						onChange={(e) => write({ name: e.target.value })}
						className="min-h-11"
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
								value={role.values?.[property.uuid] ?? ""}
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
									size="lg"
									className="h-11"
									onClick={() => {
										if (!sessionApi.getState().canEdit) return;
										const outcome = mutations.inline.removeUserType(
											role.uuid as Uuid,
										);
										if (!outcome.ok) setRefusal(outcome.messages[0]);
									}}
								>
									Remove
								</Button>
								<Button
									type="button"
									variant="ghost"
									size="lg"
									className="h-11"
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
							variant="ghost"
							size="lg"
							onClick={() => setConfirmingRemove(true)}
							className="h-11 self-start px-2.5 text-[13px] text-nova-rose hover:bg-nova-rose/[0.1] hover:text-nova-rose"
						>
							Remove role
						</Button>
					))}
			</div>
		</EntryRow>
	);
}
