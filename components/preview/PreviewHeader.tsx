/**
 * PreviewHeader — breadcrumb bar with back/up navigation for the preview pane.
 * All navigation state is read from the Zustand store via hooks — no props
 * needed except an optional `actions` slot for toolbar buttons.
 */
"use client";
import { useBreadcrumbs, useBuilderStore } from "@/hooks/useBuilder";
import {
	selectCanGoBack,
	selectCanGoUp,
} from "@/lib/services/builderSelectors";
import { ScreenNavButtons } from "./ScreenNavButtons";

interface PreviewHeaderProps {
	actions?: React.ReactNode;
}

export function PreviewHeader({ actions }: PreviewHeaderProps) {
	const breadcrumb = useBreadcrumbs();
	const canGoBack = useBuilderStore(selectCanGoBack);
	const canGoUp = useBuilderStore(selectCanGoUp);
	const navBack = useBuilderStore((s) => s.navBack);
	const navUp = useBuilderStore((s) => s.navUp);
	const navPush = useBuilderStore((s) => s.navPush);
	return (
		<div className="flex items-center justify-between px-6 h-12 border-b border-nova-border">
			<div className="flex items-center gap-2 min-w-0">
				<ScreenNavButtons
					canGoBack={canGoBack}
					canGoUp={canGoUp}
					onBack={navBack}
					onUp={navUp}
					compact
				/>
				<nav
					aria-label="Breadcrumb"
					className="flex items-center gap-1.5 text-sm min-w-0 truncate"
				>
					{breadcrumb.map((item, i) => {
						const isLast = i === breadcrumb.length - 1;
						return (
							<span key={item.key} className="flex items-center gap-1.5">
								{i > 0 && (
									<span aria-hidden="true" className="text-nova-text-muted">
										/
									</span>
								)}
								{isLast ? (
									<span
										aria-current="page"
										className="text-nova-text font-medium"
									>
										{item.label}
									</span>
								) : (
									<button
										type="button"
										onClick={() => {
											if (i < breadcrumb.length - 1)
												navPush(breadcrumb[i].screen);
										}}
										className="text-nova-text-muted hover:text-nova-text transition-colors cursor-pointer"
									>
										{item.label}
									</button>
								)}
							</span>
						);
					})}
				</nav>
			</div>
			{actions && (
				<div className="flex items-center gap-2 shrink-0">{actions}</div>
			)}
		</div>
	);
}
