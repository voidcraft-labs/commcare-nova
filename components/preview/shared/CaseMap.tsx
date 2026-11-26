"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/shadcn/button";
import type { CaseListConfig, Platform } from "@/lib/domain";
import { caseMapSources } from "@/lib/domain/caseMap";
import { caseMapRows, workerMapOffered } from "@/lib/preview/caseMap";
import type { ColumnDisplayContext } from "@/lib/preview/columnDisplay";
import type { CaseRowWithCalculated } from "@/lib/preview/engine/caseDataBindingTypes";
import {
	googleMapsConfigured,
	googleMapsMapId,
	loadMaps,
	loadMarker,
} from "../form/fields/geopoint/googleMaps";
import { useWorkerMessage } from "./WorkerText";

export function CaseMap({
	config,
	platform,
	confirmed,
	rows,
	context,
	onOpenCase,
}: {
	config: CaseListConfig;
	platform: Platform;
	confirmed: boolean | null | undefined;
	rows: readonly CaseRowWithCalculated[];
	context: ColumnDisplayContext;
	onOpenCase: (row: CaseRowWithCalculated, trigger: HTMLButtonElement) => void;
}) {
	const [open, setOpen] = useState(false);
	const [selected, setSelected] = useState<string>();
	const [failed, setFailed] = useState(false);
	const container = useRef<HTMLElement>(null);
	const message = useWorkerMessage();
	const sources = useMemo(() => caseMapSources(config, "list"), [config]);
	const offered = workerMapOffered(
		platform,
		sources.locations.length > 0,
		rows.length > 0,
		confirmed,
	);
	const geometry = useMemo(() => {
		if (!offered || !open) return [];
		return caseMapRows(platform, config, rows, context.reading);
	}, [offered, open, config, rows, platform, context.reading]);
	useEffect(() => {
		const host = container.current;
		if (!offered || !open || !host || !googleMapsConfigured()) return;
		let disposed = false;
		const cleanup: Array<() => void> = [];
		setFailed(false);
		async function mount(element: HTMLElement) {
			const [maps, markers] = await Promise.all([loadMaps(), loadMarker()]);
			if (disposed) return;
			const map = new maps.Map(element, {
				center: { lat: 0, lng: 0 },
				zoom: 2,
				mapId: googleMapsMapId(),
				streetViewControl: false,
			});
			const bounds = new google.maps.LatLngBounds();
			for (const { row, geometry: info } of geometry) {
				if (info.location) {
					const marker = new markers.AdvancedMarkerElement({
						map,
						position: info.location,
						title: row.case_name,
					});
					const click = marker.addListener("click", () =>
						setSelected(row.case_id),
					);
					bounds.extend(info.location);
					cleanup.push(() => {
						click.remove();
						marker.map = null;
					});
				}
				if (info.boundary.length) {
					const boundary = new maps.Polygon({
						map,
						paths: info.boundary,
						strokeColor: "#808080",
						strokeWeight: 5,
						fillOpacity: 64 / 255,
						fillColor: info.boundaryColor,
					});
					const click = boundary.addListener("click", () =>
						setSelected(row.case_id),
					);
					for (const point of info.boundary) bounds.extend(point);
					cleanup.push(() => {
						click.remove();
						boundary.setMap(null);
					});
				}
				for (const [i, point] of info.points.entries()) {
					const color = info.pointColors[i] ?? "#ffffff";
					const opacity =
						color.length === 9 ? Number.parseInt(color.slice(7), 16) / 255 : 1;
					const circle = new maps.Circle({
						map,
						center: point,
						radius: 3,
						strokeColor: color.slice(0, 7),
						fillColor: color.slice(0, 7),
						strokeOpacity: opacity,
						fillOpacity: opacity,
					});
					bounds.extend(point);
					cleanup.push(() => circle.setMap(null));
				}
			}
			if (!bounds.isEmpty()) {
				if (bounds.getNorthEast().equals(bounds.getSouthWest())) {
					map.setCenter(bounds.getCenter());
					map.setZoom(15);
				} else map.fitBounds(bounds);
			}
		}
		void mount(host).catch(() => {
			if (!disposed) setFailed(true);
		});
		return () => {
			disposed = true;
			for (const release of cleanup) release();
			host.replaceChildren();
		};
	}, [geometry, offered, open]);
	if (!offered) return null;
	const chosen = geometry.find((item) => item.row.case_id === selected);
	return (
		<section className="mb-4">
			<Button
				variant="outline"
				aria-expanded={open}
				onClick={() => {
					setFailed(false);
					setOpen(!open);
				}}
			>
				{message(open ? "hideCaseMap" : "showCaseMap")}
			</Button>
			{open && (
				<>
					{googleMapsConfigured() && !failed && (
						<section
							ref={container}
							className="mt-2 h-72 rounded-lg border"
							aria-label={message("caseMap")}
						/>
					)}
					{(!googleMapsConfigured() || failed) && (
						<p className="mt-2 text-sm">{message("caseMapUnavailable")}</p>
					)}
					{geometry.some((item) => item.geometry.invalid) && (
						<p className="mt-2 text-sm">{message("invalidMapInformation")}</p>
					)}
					{chosen && (
						<Button
							variant="outline"
							onClick={(event) => onOpenCase(chosen.row, event.currentTarget)}
						>
							{message("viewCaseDetails", { name: chosen.row.case_name })}
						</Button>
					)}
				</>
			)}
		</section>
	);
}
