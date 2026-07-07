import type { Metadata } from "next";
import { InsertionLab } from "./InsertionLab";

export const metadata: Metadata = { title: "Insertion Lab" };

/**
 * Dev-only tuning bench for the insertion-intent model
 * (lib/ui/insertionIntent.ts). Mock field/tree rows with REAL zones, a live
 * HUD (speed / dwell / evidence), sliders over every config knob, and a
 * pointer-trace recorder for capturing real mouse data to tune against.
 */
export default function InsertionLabPage() {
	return <InsertionLab />;
}
