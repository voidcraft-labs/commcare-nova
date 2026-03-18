const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.userAgent)

export interface Shortcut {
  key: string
  meta?: boolean
  shift?: boolean
  handler: (e: KeyboardEvent) => void
  /** If true, fires even when focus is inside text inputs */
  global?: boolean
}

interface Registration {
  id: string
  shortcuts: Shortcut[]
}

const INPUT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

function isInputFocused(): boolean {
  const el = document.activeElement
  if (!el) return false
  if (INPUT_TAGS.has(el.tagName)) return true
  if ((el as HTMLElement).contentEditable === 'true') return true
  if (el.closest('.cm-content')) return true
  return false
}

class KeyboardManager {
  private registrations: Registration[] = []
  private listening = false

  private handleKeyDown = (e: KeyboardEvent) => {
    const inInput = isInputFocused()
    const metaDown = isMac ? e.metaKey : e.ctrlKey

    for (let i = this.registrations.length - 1; i >= 0; i--) {
      for (const shortcut of this.registrations[i].shortcuts) {
        if (shortcut.key !== e.key) continue
        if (!!shortcut.meta !== metaDown) continue
        if (!!shortcut.shift !== e.shiftKey) continue
        if (inInput && !shortcut.global) continue

        e.preventDefault()
        shortcut.handler(e)
        return
      }
    }
  }

  register(id: string, shortcuts: Shortcut[]) {
    // Remove existing registration with same id
    this.registrations = this.registrations.filter(r => r.id !== id)
    this.registrations.push({ id, shortcuts })
    if (!this.listening && typeof document !== 'undefined') {
      document.addEventListener('keydown', this.handleKeyDown)
      this.listening = true
    }
  }

  unregister(id: string) {
    this.registrations = this.registrations.filter(r => r.id !== id)
    if (this.registrations.length === 0 && this.listening) {
      document.removeEventListener('keydown', this.handleKeyDown)
      this.listening = false
    }
  }
}

export const keyboardManager = new KeyboardManager()
