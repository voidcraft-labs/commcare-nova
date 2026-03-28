/**
 * Toast notification store — module-level singleton following the builder pattern.
 * Callable from anywhere (React components, callbacks, catch blocks) via `showToast()`.
 * Consumed by `useToasts()` hook + `ToastContainer` component.
 */

export type ToastSeverity = 'error' | 'warning' | 'info'

export interface Toast {
  id: string
  severity: ToastSeverity
  title: string
  message?: string
  persistent: boolean
  createdAt: number
}

const MAX_VISIBLE = 3

class ToastStore {
  private _toasts: Toast[] = []
  private _version = 0
  private _listeners = new Set<() => void>()

  subscribe = (fn: () => void) => {
    this._listeners.add(fn)
    return () => { this._listeners.delete(fn) }
  }

  getSnapshot = () => this._version

  get toasts(): Toast[] {
    return this._toasts
  }

  add(
    severity: ToastSeverity,
    title: string,
    message?: string,
    persistent?: boolean,
  ): string {
    const id = crypto.randomUUID()
    const toast: Toast = {
      id,
      severity,
      title,
      message,
      persistent: persistent ?? severity === 'error',
      createdAt: Date.now(),
    }
    this._toasts = [...this._toasts, toast].slice(-MAX_VISIBLE)
    this.notify()
    return id
  }

  dismiss(id: string) {
    this._toasts = this._toasts.filter(t => t.id !== id)
    this.notify()
  }

  clear() {
    this._toasts = []
    this.notify()
  }

  private notify() {
    this._version++
    for (const fn of this._listeners) fn()
  }
}

export const toastStore = new ToastStore()

/** Call from anywhere to show a toast notification. */
export function showToast(
  severity: ToastSeverity,
  title: string,
  message?: string,
): string {
  return toastStore.add(severity, title, message)
}
