import { z } from "zod";
import type { BlueprintDoc } from "./blueprint";
import type { Form } from "./forms";

/** Android requests a fix when a form opens. Connect requires this on every form. */
export function capturesDeviceLocation(
	app: Pick<BlueprintDoc, "connectRoles" | "appSettings">,
	form?: Pick<Form, "captureLocation">,
): boolean {
	return (
		app.connectRoles.length > 0 ||
		app.appSettings.captureLocation === true ||
		form?.captureLocation === true
	);
}

/** A simulated Android sensor fix. The worker's answers stay separate. */
export const deviceLocationSchema = z.strictObject({
	latitude: z.number().min(-90).max(90),
	longitude: z.number().min(-180).max(180),
	altitude: z.number(),
	accuracy: z.number().min(0),
});
export type DeviceLocation = z.infer<typeof deviceLocationSchema>;
