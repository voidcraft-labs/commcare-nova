/**
 * PreviewHeader — breadcrumb bar with back/up navigation for the preview pane.
 * Navigation state is read from URL-driven hooks.
 */
"use client";
import { useBreadcrumbs, useLocation, useNavigate } from "@/lib/routing/hooks";
import { ScreenNavButtons } from "./ScreenNavButtons";

interface PreviewHeaderProps {
	actions?: React.ReactNode;
}

export function PreviewHeader({ actions }: PreviewHeaderProps) {
	const loc = useLocation();
	const navigate = useNavigate();
	const breadcrumb = useBreadcrumbs();

	const canGoBack = loc.kind !== "home";
	const canGoUp = loc.kind !== "home";

	return (
		<div className="flex items-center justify-between px-6 h-12 border-b border-nova-border">
			<div className="flex items-center gap-2 min-w-0">
				<ScreenNavButtons
					canGoBack={canGoBack}
					canGoUp={canGoUp}
					onBack={() => navigate.back()}
					onUp={() => navigate.up()}
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
										onClick={() => navigate.push(breadcrumb[i].location)}
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
