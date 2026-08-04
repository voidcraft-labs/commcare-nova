/**
 * Personas: named workers you can run the app as.
 *
 * A persona is somebody: a stable identity, a role, and any values that
 * differ from that role's defaults. It is what Preview runs as, and the
 * cases it creates are owned by it.
 *
 * Each row shows the session that persona would carry, with values it sets
 * itself told apart from ones it inherits. That is the whole reason roles
 * and personas are separate collections, made visible rather than
 * explained.
 */
"use client";

import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { Field, FieldDescription, FieldLabel } from "@/components/shadcn/field";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import {
	usePersonas,
	useUserProperties,
	useUserTypes,
} from "@/lib/doc/hooks/useUserCollections";
import { asUuid } from "@/lib/doc/types";
import type { Persona, UserProperty, UserType } from "@/lib/domain";
import { hasOwnRecordKey, ownRecordValue } from "@/lib/domain";
import { useOrganization } from "@/lib/organization/useOrganization";
import { useAppId, useCanEdit } from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { DraftCommitInput } from "./DraftCommitField";
import { PersonaLocations } from "./PersonaLocations";
import { PersonaRemoveConfirm } from "./PersonaRemoveConfirm";
import { EntryRow, Subsection, SubsectionEmpty } from "./subsection";
import { ValueField } from "./ValueField";

export function PersonasSubsection() {
	const personas = usePersonas();
	const roles = useUserTypes();
	const properties = useUserProperties();
	const canEdit = useCanEdit();
	const sessionApi = useBuilderSessionApi();
	const appId = useAppId();
	const organization = useOrganization(appId ?? "");
	const mutations = useBlueprintMutations();
	const [openUuid, setOpenUuid] = useState<string | undefined>(undefined);
	const [focusUuid, setFocusUuid] = useState<string | undefined>(undefined);
	const addButtonRef = useRef<HTMLButtonElement>(null);

	const add = () => {
		if (!sessionApi.getState().canEdit) return;
		const result = mutations.addPersona({
			name: uniqueName(personas),
			...(roles[0] !== undefined && { userTypeUuid: roles[0].uuid }),
		});
		if (result.ok) {
			setOpenUuid(result.uuid);
			setFocusUuid(result.uuid);
		}
	};

	return (
		<Subsection
			id="app-setup-personas"
			title="Personas"
			description="Named workers you can use in Preview. Choose one to test worker information, place assignments, and case ownership."
			addLabel="Add persona"
			onAdd={add}
			canEdit={canEdit}
			addButtonRef={addButtonRef}
		>
			{personas.length === 0 ? (
				<SubsectionEmpty>
					No personas yet. Add one to preview the app as a particular worker
					instead of as yourself.
				</SubsectionEmpty>
			) : (
				personas.map((persona) => (
					<PersonaRow
						key={persona.uuid}
						persona={persona}
						roles={roles}
						properties={properties}
						open={openUuid === persona.uuid}
						onOpenChange={(next) =>
							setOpenUuid(next ? persona.uuid : undefined)
						}
						focusOnMount={focusUuid === persona.uuid}
						onFocused={() => setFocusUuid(undefined)}
						returnFocusRef={addButtonRef}
						locations={organization.locations}
						locationsLoading={organization.loading}
						locationsError={organization.error}
						locationsWarning={organization.warning}
						locationsRefreshing={organization.refreshing}
						onReloadLocations={organization.reload}
					/>
				))
			)}
		</Subsection>
	);
}

function uniqueName(peers: readonly Persona[]): string {
	const taken = new Set(peers.map((p) => p.name.trim().toLowerCase()));
	if (!taken.has("new persona")) return "New persona";
	for (let n = 2; ; n++) {
		const candidate = `New persona ${n}`;
		if (!taken.has(candidate.toLowerCase())) return candidate;
	}
}

function PersonaRow({
	persona,
	roles,
	properties,
	open,
	onOpenChange,
	focusOnMount,
	onFocused,
	returnFocusRef,
	locations,
	locationsLoading,
	locationsError,
	locationsWarning,
	locationsRefreshing,
	onReloadLocations,
}: {
	persona: Persona;
	roles: readonly UserType[];
	properties: readonly UserProperty[];
	open: boolean;
	onOpenChange: (open: boolean) => void;
	focusOnMount: boolean;
	onFocused: () => void;
	returnFocusRef: RefObject<HTMLButtonElement | null>;
	locations: Parameters<typeof PersonaLocations>[0]["locations"];
	locationsLoading: boolean;
	locationsError: string | undefined;
	locationsWarning: string | undefined;
	locationsRefreshing: boolean;
	onReloadLocations: () => void;
}) {
	const canEdit = useCanEdit();
	const sessionApi = useBuilderSessionApi();
	const mutations = useBlueprintMutations();
	const nameId = useId();
	const roleId = useId();
	const roleDescriptionId = useId();
	const nameRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!focusOnMount) return;
		nameRef.current?.focus();
		onFocused();
	}, [focusOnMount, onFocused]);

	const role =
		persona.userTypeUuid === undefined
			? undefined
			: roles.find((r) => r.uuid === persona.userTypeUuid);

	const write = (patch: Parameters<typeof mutations.updatePersona>[1]) => {
		if (!sessionApi.getState().canEdit) return;
		mutations.updatePersona(persona.uuid, patch);
	};

	const setOverride = (propertyUuid: string, value: string | undefined) => {
		if (!sessionApi.getState().canEdit) return;
		mutations.updatePersonaValue(persona.uuid, asUuid(propertyUuid), value);
	};
	const selectedRoleIndex =
		persona.userTypeUuid === undefined
			? -1
			: roles.findIndex((candidate) => candidate.uuid === persona.userTypeUuid);

	return (
		<EntryRow
			open={open}
			onOpenChange={onOpenChange}
			summary={
				<span className="text-[13px] font-medium text-nova-text">
					{persona.name}
				</span>
			}
			detail={role?.name ?? "No role"}
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
						value={persona.name}
						disabled={!canEdit}
						validate={(value) =>
							value === "" ? "Enter a name for this persona." : undefined
						}
						onCommit={(name) => {
							if (!sessionApi.getState().canEdit) {
								return {
									ok: false,
									messages: ["You no longer have edit access."],
								};
							}
							return mutations.inline.updatePersona(persona.uuid, {
								name,
							});
						}}
					/>
				</div>

				<Field>
					<FieldLabel htmlFor={roleId}>Role</FieldLabel>
					<Select
						value={selectedRoleIndex + 1}
						disabled={!canEdit || roles.length === 0}
						onValueChange={(next) => {
							const index = Number(next);
							const selectedRole = roles[index - 1];
							if (index !== 0 && selectedRole === undefined) return;
							write({
								userTypeUuid: index === 0 ? null : selectedRole.uuid,
							});
						}}
					>
						<SelectTrigger
							id={roleId}
							aria-describedby={
								roles.length === 0 ? roleDescriptionId : undefined
							}
							className="w-full"
						>
							<SelectValue>{role?.name ?? "No role"}</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={0}>No role</SelectItem>
							{roles.map((r, index) => (
								<SelectItem key={r.uuid} value={index + 1}>
									{r.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{roles.length === 0 && (
						<FieldDescription id={roleDescriptionId}>
							Add a role above to give this persona one.
						</FieldDescription>
					)}
				</Field>

				<div className="flex flex-col gap-3">
					<h4 className="text-[12px] font-medium text-nova-text-secondary">
						What this worker carries
					</h4>
					{properties.length === 0 ? (
						<p className="text-[13px] leading-relaxed text-nova-text-muted">
							Add worker information above and this persona can carry it.
						</p>
					) : (
						properties.map((property) => (
							<PersonaValueRow
								key={property.uuid}
								property={property}
								persona={persona}
								role={role}
								disabled={!canEdit}
								onChange={(next) => setOverride(property.uuid, next)}
							/>
						))
					)}
				</div>

				{open && (
					<PersonaLocations
						persona={persona}
						locations={locations}
						loading={locationsLoading}
						error={locationsError}
						warning={locationsWarning}
						refreshing={locationsRefreshing}
						reload={onReloadLocations}
					/>
				)}

				{canEdit && (
					<PersonaRemoveConfirm
						persona={persona}
						returnFocusRef={returnFocusRef}
					/>
				)}
			</div>
		</EntryRow>
	);
}

/**
 * One property on a persona: the editable override plus the fact of where
 * the effective value comes from. An inherited value shows as the input's
 * placeholder: present but not typed here, and a required property with
 * nothing behind it says so, without blocking anything: whether a persona
 * can become a real worker is a question the deployment answers, against a
 * project whose plan and field schema Nova cannot see from here.
 */
function PersonaValueRow({
	property,
	persona,
	role,
	disabled,
	onChange,
}: {
	property: UserProperty;
	persona: Persona;
	role: UserType | undefined;
	disabled: boolean;
	onChange: (value: string | undefined) => void;
}) {
	const hasOwnValue = hasOwnRecordKey(persona.values, property.uuid);
	const own = hasOwnValue
		? ownRecordValue(persona.values, property.uuid)
		: undefined;
	const inherited = ownRecordValue(role?.values, property.uuid);
	const effective = own === undefined ? (inherited ?? "") : own;
	const noteId = `${persona.uuid}-${property.uuid}-note`;

	const note =
		own !== undefined && inherited !== undefined && own === inherited
			? `Set here. Matches ${role?.name ?? "the role"}.`
			: own !== undefined && inherited !== undefined
				? `Set here. ${role?.name ?? "The role"} uses “${inherited}”.`
				: own === undefined && inherited !== undefined
					? `From ${role?.name ?? "the role"}.`
					: property.required === true && effective.trim() === ""
						? `Required. A worker created from ${persona.name} would need a ${property.label.toLowerCase()}.`
						: undefined;

	return (
		<div className="flex flex-col gap-1">
			<ValueField
				property={property}
				value={own}
				disabled={disabled}
				onChange={onChange}
				inheritedValue={inherited}
				describedBy={note === undefined ? undefined : noteId}
			/>
			{note !== undefined && (
				<span
					id={noteId}
					className={`text-[12px] ${
						property.required === true && effective === ""
							? "text-nova-amber"
							: "text-nova-text-muted"
					}`}
				>
					{note}
				</span>
			)}
		</div>
	);
}
