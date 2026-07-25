/**
 * Personas — named workers you can run the app as.
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

import { useId, useState } from "react";
import { Input } from "@/components/shadcn/input";
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
import type { Uuid } from "@/lib/doc/types";
import type {
	Persona,
	UserDataValues,
	UserProperty,
	UserType,
} from "@/lib/domain";
import type { StoredLocation } from "@/lib/organization/types";
import { useOrganization } from "@/lib/organization/useOrganization";
import { useAppId, useCanEdit } from "@/lib/session/hooks";
import { useBuilderSessionApi } from "@/lib/session/provider";
import { PersonaLocations } from "./PersonaLocations";
import { PersonaRemoveConfirm } from "./PersonaRemoveConfirm";
import { EntryRow, Subsection, SubsectionEmpty } from "./subsection";
import { ValueField } from "./ValueField";

/** The chooser entry for a persona with no role. */
const NO_ROLE = "__nova_no_role";

export function PersonasSubsection() {
	const personas = usePersonas();
	const roles = useUserTypes();
	const properties = useUserProperties();
	const canEdit = useCanEdit();
	const sessionApi = useBuilderSessionApi();
	const mutations = useBlueprintMutations();
	const [openUuid, setOpenUuid] = useState<string | undefined>(undefined);
	// Places live in the locations store, not the document. Read once for the
	// whole list so opening several personas does not open several reads.
	const appId = useAppId();
	const organization = useOrganization(appId ?? "");

	const add = () => {
		if (!sessionApi.getState().canEdit) return;
		const result = mutations.addPersona({
			name: uniqueName(personas),
			...(roles[0] !== undefined && { userTypeUuid: roles[0].uuid }),
		});
		if (result.ok) setOpenUuid(result.uuid);
	};

	return (
		<Subsection
			id="app-setup-personas"
			title="Personas"
			description="Named workers you can run the app as. Preview signs in as the persona you pick, so conditions on worker information behave the way they will for a real person — and the cases it creates belong to that persona."
			addLabel="Add persona"
			onAdd={add}
			canEdit={canEdit}
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
						locations={organization.locations}
						locationsLoading={organization.loading}
						open={openUuid === persona.uuid}
						onOpenChange={(next) =>
							setOpenUuid(next ? persona.uuid : undefined)
						}
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
	locations,
	locationsLoading,
	open,
	onOpenChange,
}: {
	persona: Persona;
	roles: readonly UserType[];
	properties: readonly UserProperty[];
	locations: readonly StoredLocation[];
	locationsLoading: boolean;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const canEdit = useCanEdit();
	const sessionApi = useBuilderSessionApi();
	const mutations = useBlueprintMutations();
	const nameId = useId();

	const role =
		persona.userTypeUuid === undefined
			? undefined
			: roles.find((r) => r.uuid === persona.userTypeUuid);

	const write = (patch: Parameters<typeof mutations.updatePersona>[1]) => {
		if (!sessionApi.getState().canEdit) return;
		mutations.updatePersona(persona.uuid as Uuid, patch);
	};

	const setOverride = (propertyUuid: string, value: string) => {
		const next: UserDataValues = { ...(persona.values ?? {}) };
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
					<Input
						id={nameId}
						value={persona.name}
						disabled={!canEdit}
						autoComplete="off"
						data-1p-ignore
						onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
							write({ name: e.target.value })
						}
						className="min-h-11"
					/>
				</div>

				<div className="flex flex-col gap-1.5">
					<span className="text-[12px] font-medium text-nova-text-secondary">
						Role
					</span>
					<Select
						value={persona.userTypeUuid ?? NO_ROLE}
						disabled={!canEdit || roles.length === 0}
						onValueChange={(next) =>
							write({
								userTypeUuid: next === NO_ROLE ? null : (String(next) as Uuid),
							})
						}
					>
						<SelectTrigger aria-label="Role" className="min-h-11 w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={NO_ROLE}>No role</SelectItem>
							{roles.map((r) => (
								<SelectItem key={r.uuid} value={r.uuid}>
									{r.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{roles.length === 0 && (
						<span className="text-[12px] text-nova-text-muted">
							Add a role above to give this persona one.
						</span>
					)}
				</div>

				<PersonaLocations
					persona={persona}
					locations={locations}
					loading={locationsLoading}
				/>

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

				{canEdit && <PersonaRemoveConfirm persona={persona} />}
			</div>
		</EntryRow>
	);
}

/**
 * One property on a persona: the editable override plus the fact of where
 * the effective value comes from. An inherited value shows as the input's
 * placeholder — present but not typed here — and a required property with
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
	onChange: (value: string) => void;
}) {
	const own = persona.values?.[property.uuid] ?? "";
	const inherited = role?.values?.[property.uuid] ?? "";
	const effective = own !== "" ? own : inherited;
	const noteId = `${persona.uuid}-${property.uuid}-note`;

	const note =
		own !== "" && inherited !== "" && own !== inherited
			? `Set here. ${role?.name ?? "The role"} uses “${inherited}”.`
			: own === "" && inherited !== ""
				? `From ${role?.name ?? "the role"}.`
				: property.required === true && effective === ""
					? `Required. A worker created from ${persona.name} would need a ${property.label.toLowerCase()}.`
					: undefined;

	return (
		<div className="flex flex-col gap-1">
			<ValueField
				property={property}
				value={own}
				disabled={disabled}
				onChange={onChange}
				placeholder={inherited === "" ? undefined : inherited}
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
