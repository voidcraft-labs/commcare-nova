import type { Metadata } from "next";
import { TooltipProvider } from "@/components/shadcn/tooltip";
import { HeaderLab } from "./HeaderLab";

export const metadata: Metadata = { title: "Header Lab" };

/**
 * Dev-only bench for the one shared header band (`components/ui/AppHeader`)
 * and the brand handoff that collapses its lockup into the sphere. Renders
 * the real component with stand-in slot contents, so the animation can be
 * replayed without creating an app each time.
 *
 * `TooltipProvider` mounts here because the app shell's own lives under
 * `(app)/layout.tsx`, which this route group is deliberately outside of.
 */
export default function HeaderLabPage() {
	return (
		<TooltipProvider>
			<HeaderLab />
		</TooltipProvider>
	);
}
