/**
 * Structured logger for GCP Cloud Logging.
 *
 * Cloud Run captures stdout/stderr and auto-parses JSON lines with known
 * fields. By emitting structured JSON instead of plain `console.error`, we get:
 *
 * - **Severity filtering** — `severity` field maps to Cloud Logging levels
 * - **Error grouping** — `stack_trace` field feeds GCP Error Reporting
 * - **Searchable labels** — `logging.googleapis.com/labels` for filtering
 * - **Single-line entries** — no split log lines from multi-line stack traces
 *
 * In local dev, `NODE_ENV !== 'production'` falls back to `console.*` for
 * readable terminal output. In production (Cloud Run), emits JSON to
 * stdout/stderr for Cloud Logging ingestion.
 */

// ── Types ──────────────────────────────────────────────────────────────

type Severity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL'

/** Structured log entry matching Cloud Logging's JSON payload format. */
interface LogPayload {
  severity: Severity
  message: string
  time: string
  /** GCP Error Reporting uses this field to group related errors by stack. */
  stack_trace?: string
  /** Custom labels — appear as filterable fields in Cloud Logging Explorer. */
  'logging.googleapis.com/labels'?: Record<string, string>
}

// ── Internal ───────────────────────────────────────────────────────────

const isProduction = process.env.NODE_ENV === 'production'

/**
 * Extract a clean stack trace from an error, stripping the first line
 * (which is just the error message repeated) so `stack_trace` contains
 * only the frame information GCP Error Reporting needs for grouping.
 */
function extractStack(error: unknown): string | undefined {
  if (!(error instanceof Error) || !error.stack) return undefined
  return error.stack
}

/**
 * Emit a structured JSON log entry to the appropriate stream.
 * ERROR/CRITICAL go to stderr, everything else to stdout — matching
 * Cloud Logging's default severity mapping for Cloud Run.
 */
function emit(payload: LogPayload): void {
  const stream = payload.severity === 'ERROR' || payload.severity === 'CRITICAL'
    ? process.stderr
    : process.stdout
  stream.write(JSON.stringify(payload) + '\n')
}

/**
 * Format a message with optional labels context for local dev output.
 * Reproduces the bracket-tag pattern used by existing console.error calls.
 */
function formatLocal(message: string, labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return message
  const pairs = Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(' ')
  return `${message} (${pairs})`
}

// ── Public API ─────────────────────────────────────────────────────────

export const log = {
  /**
   * Log an informational message. Useful for request lifecycle events,
   * startup diagnostics, or audit trail entries.
   */
  info(message: string, labels?: Record<string, string>): void {
    if (!isProduction) {
      console.log(formatLocal(message, labels))
      return
    }
    emit({
      severity: 'INFO',
      message,
      time: new Date().toISOString(),
      ...(labels && { 'logging.googleapis.com/labels': labels }),
    })
  },

  /**
   * Log a warning — something unexpected happened but the operation can
   * continue. Retryable failures, degraded functionality, fallback paths.
   */
  warn(message: string, labels?: Record<string, string>): void {
    if (!isProduction) {
      console.warn(formatLocal(message, labels))
      return
    }
    emit({
      severity: 'WARNING',
      message,
      time: new Date().toISOString(),
      ...(labels && { 'logging.googleapis.com/labels': labels }),
    })
  },

  /**
   * Log an error with optional error object for stack trace extraction.
   * The stack trace is placed in `stack_trace` so GCP Error Reporting
   * can group related errors by their origin point.
   *
   * @param message - Human-readable description of what went wrong
   * @param error - The caught error/exception (stack extracted automatically)
   * @param labels - Key-value pairs for Cloud Logging filtering
   */
  error(message: string, error?: unknown, labels?: Record<string, string>): void {
    if (!isProduction) {
      if (error) {
        console.error(formatLocal(message, labels), error)
      } else {
        console.error(formatLocal(message, labels))
      }
      return
    }
    emit({
      severity: 'ERROR',
      message,
      time: new Date().toISOString(),
      stack_trace: extractStack(error),
      ...(labels && { 'logging.googleapis.com/labels': labels }),
    })
  },

  /**
   * Log a critical/fatal error — the process or request is in an
   * unrecoverable state. Use sparingly; most errors should use `error()`.
   */
  critical(message: string, error?: unknown, labels?: Record<string, string>): void {
    if (!isProduction) {
      if (error) {
        console.error(`[CRITICAL] ${formatLocal(message, labels)}`, error)
      } else {
        console.error(`[CRITICAL] ${formatLocal(message, labels)}`)
      }
      return
    }
    emit({
      severity: 'CRITICAL',
      message,
      time: new Date().toISOString(),
      stack_trace: extractStack(error),
      ...(labels && { 'logging.googleapis.com/labels': labels }),
    })
  },
}
