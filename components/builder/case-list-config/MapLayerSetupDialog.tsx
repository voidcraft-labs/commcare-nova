"use client";

import { useState } from "react";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogBody,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/shadcn/alert-dialog";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { useProseProjection } from "@/lib/doc/hooks/useProseProjection";
import {
	CASE_MAP_LAYER_KINDS,
	type CaseListConfig,
	type CaseMapLayerKind,
	type CaseProperty,
	type Column,
} from "@/lib/domain";
import { caseMapSources } from "@/lib/domain/caseMap";
import {
	friendlyPropertyDisambiguator,
	propertyDisplayLabel,
} from "@/lib/domain/propertyDisplay";

export const mapLayerLabels: Record<CaseMapLayerKind, string> = {
	boundary: "Boundary",
	"boundary-color": "Boundary color",
	points: "Points",
	"point-colors": "Point colors",
};
type LayerColumn = Extract<Column, { kind: "map-layer" }>;
export interface MapLayerSetup {
	column: LayerColumn;
	location?: string;
	geometry?: { role: "boundary" | "points"; field: string };
}

function SourcePicker({
	label,
	properties,
	value,
	onChange,
}: {
	label: string;
	properties: readonly CaseProperty[];
	value: string;
	onChange: (value: string) => void;
}) {
	const project = useProseProjection();
	return (
		<div className="space-y-1">
			<span className="text-sm font-medium">{label}</span>
			<Select
				value={value || null}
				onValueChange={(next) => onChange(next ?? "")}
			>
				<SelectTrigger aria-label={label}>
					<SelectValue placeholder="Choose case information" />
				</SelectTrigger>
				<SelectContent>
					{properties.map((property) => {
						const name = propertyDisplayLabel(property, project);
						const detail = friendlyPropertyDisambiguator(
							property,
							properties,
							project,
						);
						return (
							<SelectItem key={property.name} value={property.name}>
								{detail ? `${name} (${detail})` : name}
							</SelectItem>
						);
					})}
				</SelectContent>
			</Select>
		</div>
	);
}

export function MapLayerSetupDialog({
	config,
	properties,
	column,
	onCancel,
	onSave,
}: {
	config: CaseListConfig;
	properties: readonly CaseProperty[];
	column: LayerColumn;
	onCancel: () => void;
	onSave: (setup: MapLayerSetup) => void;
}) {
	const map = caseMapSources(config, "list");
	const availableRoles = CASE_MAP_LAYER_KINDS.filter(
		(role) => !map.layers[role]?.some((id) => id !== column.uuid),
	);
	const [role, setRole] = useState<CaseMapLayerKind>(
		availableRoles.includes(column.layer)
			? column.layer
			: (availableRoles[0] ?? column.layer),
	);
	const [location, setLocation] = useState("");
	const [geometry, setGeometry] = useState("");
	const needsLocation = !map.locations.some((id) => id !== column.uuid);
	const shape =
		role === "boundary-color"
			? "boundary"
			: role === "point-colors"
				? "points"
				: undefined;
	const needsShape =
		shape !== undefined && !map.layers[shape]?.some((id) => id !== column.uuid);
	const ready =
		availableRoles.includes(role) &&
		(!needsLocation || properties.some((p) => p.name === location)) &&
		(!needsShape || properties.some((p) => p.name === geometry));
	return (
		<AlertDialog
			open
			onOpenChange={(open) => {
				if (!open) onCancel();
			}}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Set up this map layer</AlertDialogTitle>
					<AlertDialogDescription>
						Map layers appear on Results. Each case has a location and can also
						show a boundary or a set of points.
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogBody className="space-y-4">
					<Select
						value={role}
						onValueChange={(value) => {
							if (value) setRole(value);
						}}
					>
						<SelectTrigger aria-label="Map layer">
							<SelectValue>{mapLayerLabels[role]}</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{availableRoles.map((r) => (
								<SelectItem key={r} value={r}>
									{mapLayerLabels[r]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{availableRoles.length === 0 && (
						<p>
							All four layers already have a source. You can edit one of those
							layers in Results.
						</p>
					)}
					{needsLocation && (
						<SourcePicker
							label="Case location"
							properties={properties}
							value={location}
							onChange={setLocation}
						/>
					)}
					{needsShape && shape && (
						<SourcePicker
							label={mapLayerLabels[shape]}
							properties={properties}
							value={geometry}
							onChange={setGeometry}
						/>
					)}
				</AlertDialogBody>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction
						disabled={!ready}
						onClick={(event) => {
							event.preventDefault();
							if (ready)
								onSave({
									column: { ...column, layer: role },
									...(needsLocation && { location }),
									...(needsShape &&
										shape && { geometry: { role: shape, field: geometry } }),
								});
						}}
					>
						Save map layer
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
