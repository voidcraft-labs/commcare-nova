import type { ReactNode } from "react";
import { TooltipProvider } from "@/components/shadcn/tooltip";
import { AnatomyNav } from "./_components/AnatomyNav";

/**
 * The agent anatomy shell: a reading room for how Nova's model roles are
 * composed. Dev-only through the parent route group; no app chrome, so the
 * tooltip provider mounts here.
 */
export default function AgentsLayout({ children }: { children: ReactNode }) {
	return (
		<TooltipProvider>
			<div className="min-h-dvh bg-nova-void text-nova-text">
				<header className="border-nova-border border-b">
					<div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6">
						<a
							href="/agents"
							className="nova-focusable rounded-xl font-display text-[17px] font-semibold tracking-[-0.015em]"
						>
							Agent anatomy
						</a>
						<AnatomyNav />
						<p className="ml-auto hidden text-nova-text-muted text-xs sm:block">
							Rendered from the production code on every view. Local only.
						</p>
					</div>
				</header>
				<main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">
					{children}
				</main>
			</div>
		</TooltipProvider>
	);
}
