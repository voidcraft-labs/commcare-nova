"use client";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { CASE_MAP_LAYER_KINDS, type Column } from "@/lib/domain";
import { mapLayerLabels } from "../../MapLayerSetupDialog";
import { FormattedTextColumnCard } from "./FormattedTextColumnCard";

export function MapLayerColumnCard(props: {
	value: Extract<Column, { kind: "map-layer" }>;
	onChange: (next: Column) => void;
	errors?: readonly string[];
}) {
	return (
		<div className="space-y-4">
			<FormattedTextColumnCard {...props} />
			<Select
				value={props.value.layer}
				onValueChange={(layer) => {
					if (layer) props.onChange({ ...props.value, layer });
				}}
			>
				<SelectTrigger aria-label="Map layer">
					<SelectValue>{mapLayerLabels[props.value.layer]}</SelectValue>
				</SelectTrigger>
				<SelectContent>
					{CASE_MAP_LAYER_KINDS.map((role) => (
						<SelectItem value={role} key={role}>
							{mapLayerLabels[role]}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</div>
	);
}
