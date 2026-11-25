"use client";
import { useState } from "react";
import { Button } from "@/components/shadcn/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogTitle,
} from "@/components/shadcn/dialog";
import { Input } from "@/components/shadcn/input";
import { deviceLocationSchema } from "@/lib/domain/locationCapture";
import {
	usePreviewLocationFix,
	useSetPreviewLocationFix,
} from "@/lib/session/hooks";

export function PreviewLocationDialog({ onClose }: { onClose: () => void }) {
	const current = usePreviewLocationFix();
	const setFix = useSetPreviewLocationFix();
	const [latitude, setLatitude] = useState(current?.latitude.toString() ?? "");
	const [longitude, setLongitude] = useState(
		current?.longitude.toString() ?? "",
	);
	const [altitude, setAltitude] = useState(current?.altitude.toString() ?? "0");
	const [accuracy, setAccuracy] = useState(current?.accuracy.toString() ?? "0");
	const fix = deviceLocationSchema.safeParse({
		latitude: latitude.trim() ? Number(latitude) : NaN,
		longitude: longitude.trim() ? Number(longitude) : NaN,
		altitude: altitude.trim() ? Number(altitude) : NaN,
		accuracy: accuracy.trim() ? Number(accuracy) : NaN,
	});
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
		>
			<DialogContent>
				<DialogTitle>Device location</DialogTitle>
				<DialogDescription>
					Choose the location this Preview phone can provide when the next
					Android form opens. A phone without a fix can still send its form.
				</DialogDescription>
				<DialogBody>
					<div className="grid grid-cols-2 gap-2">
						<label htmlFor="preview-device-latitude">
							Latitude
							<Input
								id="preview-device-latitude"
								type="number"
								step="any"
								min="-90"
								max="90"
								value={latitude}
								onChange={(e) => setLatitude(e.target.value)}
							/>
						</label>
						<label htmlFor="preview-device-longitude">
							Longitude
							<Input
								id="preview-device-longitude"
								type="number"
								step="any"
								min="-180"
								max="180"
								value={longitude}
								onChange={(e) => setLongitude(e.target.value)}
							/>
						</label>
						<label htmlFor="preview-device-altitude">
							Altitude (m)
							<Input
								id="preview-device-altitude"
								type="number"
								step="any"
								value={altitude}
								onChange={(e) => setAltitude(e.target.value)}
							/>
						</label>
						<label htmlFor="preview-device-accuracy">
							Accuracy (m)
							<Input
								id="preview-device-accuracy"
								type="number"
								step="any"
								min="0"
								value={accuracy}
								onChange={(e) => setAccuracy(e.target.value)}
							/>
						</label>
					</div>
				</DialogBody>
				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => {
							setFix(undefined);
							onClose();
						}}
					>
						Use unavailable location
					</Button>
					<Button
						disabled={!fix.success}
						onClick={() => {
							if (fix.success) {
								setFix(fix.data);
								onClose();
							}
						}}
					>
						Use this location
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
