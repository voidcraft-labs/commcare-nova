/**
 * Toast notification store — module-level singleton following the builder pattern.
 * Callable from anywhere (React components, callbacks, catch blocks) via `showToast()`.
 * Consumed by `useToasts()` hook + `ToastContainer` component.
 */

export type ToastSeverity = "error" | "warning" | "info";

/**
 * One follow-up action rendered as a labeled button under the toast
 * body ("Review data", "Undo"). Pressing it runs
 * `onPress` and dismisses the toast — the toast is the ephemeral
 * announcement; the action hands off to a durable surface.
 */
export interface ToastAction {
	label: string;
	onPress: () => void;
}

/** Provenance for a notice whose content or action belongs to one builder's
 * current Project generation. `scopeId` distinguishes remounted builders whose
 * local epochs both start at zero. */
export interface ProjectToastScope {
	readonly scopeId: string;
	readonly epoch: number;
}

export interface Toast {
	id: string;
	severity: ToastSeverity;
	title: string;
	message?: string;
	/**
	 * Structured detail rows rendered one per line with their own list
	 * chrome — the shape multi-finding rejections arrive in (commit gate,
	 * export boundary). Distinct from `message` so the renderer can mark
	 * each row instead of relying on embedded newlines in one paragraph.
	 */
	lines?: string[];
	action?: ToastAction;
	projectScope?: ProjectToastScope;
	persistent: boolean;
	createdAt: number;
}

/** Presentation extras beyond the title + message. */
export interface ToastOptions {
	lines?: string[];
	action?: ToastAction;
	persistent?: boolean;
	/** Internal provenance supplied by `showProjectToast`; ordinary app-global
	 * notices omit it and survive a builder Project boundary. */
	projectScope?: ProjectToastScope;
}

const MAX_VISIBLE = 3;

class ToastStore {
	private _toasts: Toast[] = [];
	private _version = 0;
	private _listeners = new Set<() => void>();
	private _projectScopeRetirementListeners = new Set<
		(scope: ProjectToastScope | null) => void
	>();
	private _activeProjectScope: ProjectToastScope | null = null;

	subscribe = (fn: () => void) => {
		this._listeners.add(fn);
		return () => {
			this._listeners.delete(fn);
		};
	};

	getSnapshot = () => this._version;

	get toasts(): Toast[] {
		return this._toasts;
	}

	/** Imperative DOM owners use this seam to quarantine retired scoped content
	 * inside the same reset call stack, before React/AnimatePresence can commit
	 * its removal animation. */
	subscribeProjectScopeRetirement = (
		fn: (scope: ProjectToastScope | null) => void,
	) => {
		this._projectScopeRetirementListeners.add(fn);
		return () => this._projectScopeRetirementListeners.delete(fn);
	};

	add(
		severity: ToastSeverity,
		title: string,
		message?: string,
		options?: ToastOptions,
	): string {
		const id = crypto.randomUUID();
		/* An async source-generation completion may arrive after reset. Refuse it
		 * at the singleton boundary so no stale content briefly enters the global
		 * stack before a React owner can notice. */
		if (
			options?.projectScope !== undefined &&
			!sameProjectScope(options.projectScope, this._activeProjectScope)
		) {
			return id;
		}
		const toast: Toast = {
			id,
			severity,
			title,
			message,
			lines: options?.lines,
			action: options?.action,
			projectScope: options?.projectScope,
			persistent: options?.persistent ?? severity === "error",
			createdAt: Date.now(),
		};
		this._toasts = [...this._toasts, toast].slice(-MAX_VISIBLE);
		this.notify();
		return id;
	}

	/** Synchronous builder infrastructure that cannot use React hooks (the doc
	 * reducer's rejection notifier) still tags its notice with the currently
	 * active runtime. Outside a builder it degrades to a normal global toast. */
	addForActiveProject(
		severity: ToastSeverity,
		title: string,
		message?: string,
		options?: Omit<ToastOptions, "projectScope">,
	): string {
		return this.add(severity, title, message, {
			...options,
			...(this._activeProjectScope
				? { projectScope: this._activeProjectScope }
				: {}),
		});
	}

	dismiss(id: string) {
		this._toasts = this._toasts.filter((t) => t.id !== id);
		this.notify();
	}

	clear() {
		this._toasts = [];
		this.notify();
	}

	/** Activate or advance one builder's Project generation. Every scoped toast
	 * from another builder/generation is removed synchronously; global notices
	 * are preserved. */
	activateProjectScope(scope: ProjectToastScope) {
		this._activeProjectScope = scope;
		this.notifyProjectScopeRetirement(scope);
		const next = this._toasts.filter(
			(toast) =>
				toast.projectScope === undefined ||
				sameProjectScope(toast.projectScope, scope),
		);
		if (next.length === this._toasts.length) return;
		this._toasts = next;
		this.notify();
	}

	/** End one builder lifetime. Ignore a stale cleanup if another runtime has
	 * already become active. */
	deactivateProjectScope(scopeId: string) {
		if (this._activeProjectScope?.scopeId !== scopeId) return;
		this._activeProjectScope = null;
		this.notifyProjectScopeRetirement(null);
		const next = this._toasts.filter(
			(toast) => toast.projectScope === undefined,
		);
		if (next.length === this._toasts.length) return;
		this._toasts = next;
		this.notify();
	}

	/** Run an action only while its Project provenance is still current. The
	 * toast is dismissed even when the stale-action guard refuses the closure. */
	invokeAction(id: string) {
		const toast = this._toasts.find((candidate) => candidate.id === id);
		if (!toast?.action) return;
		try {
			if (
				toast.projectScope === undefined ||
				sameProjectScope(toast.projectScope, this._activeProjectScope)
			) {
				toast.action.onPress();
			}
		} finally {
			this.dismiss(id);
		}
	}

	private notify() {
		this._version++;
		for (const fn of this._listeners) fn();
	}

	private notifyProjectScopeRetirement(scope: ProjectToastScope | null) {
		for (const fn of this._projectScopeRetirementListeners) fn(scope);
	}
}

export const toastStore = new ToastStore();

function sameProjectScope(
	a: ProjectToastScope,
	b: ProjectToastScope | null,
): boolean {
	return b !== null && a.scopeId === b.scopeId && a.epoch === b.epoch;
}

/** Call from anywhere to show a toast notification. */
export function showToast(
	severity: ToastSeverity,
	title: string,
	message?: string,
	options?: ToastOptions,
): string {
	return toastStore.add(severity, title, message, options);
}

/** Show a notice whose payload/action is authorized only for one Project
 * generation. Stale async callers are rejected by the store. */
export function showProjectToast(
	projectScope: ProjectToastScope,
	severity: ToastSeverity,
	title: string,
	message?: string,
	options?: Omit<ToastOptions, "projectScope">,
): string {
	return toastStore.add(severity, title, message, {
		...options,
		projectScope,
	});
}

/** Project-tag a synchronous builder notice from non-React infrastructure. */
export function showActiveProjectToast(
	severity: ToastSeverity,
	title: string,
	message?: string,
	options?: Omit<ToastOptions, "projectScope">,
): string {
	return toastStore.addForActiveProject(severity, title, message, options);
}
