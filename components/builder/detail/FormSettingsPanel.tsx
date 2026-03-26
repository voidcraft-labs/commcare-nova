'use client'
import { useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react'
import { useFloating, offset, flip, shift, autoUpdate, FloatingPortal } from '@floating-ui/react'
import { motion, AnimatePresence } from 'motion/react'
import { Icon } from '@iconify/react'
import ciSettings from '@iconify-icons/ci/settings'
import ciClose from '@iconify-icons/ci/close-md'
import type { BlueprintForm, ConnectConfig } from '@/lib/schemas/blueprint'
import type { MutableBlueprint } from '@/lib/services/mutableBlueprint'
import { FormDetail } from './FormDetail'
import { ConnectLogomark } from '@/components/icons/ConnectLogomark'
import { Toggle } from '@/components/ui/Toggle'
import { useDismissRef } from '@/hooks/useDismissRef'
import { XPathField } from '@/components/builder/XPathField'
import { XPathEditorModal } from '@/components/builder/XPathEditorModal'

// ── Types ─────────────────────────────────────────────────────────────

interface FormSettingsPanelProps {
  form: BlueprintForm
  moduleIndex: number
  formIndex: number
  mb: MutableBlueprint
  notifyBlueprintChanged: () => void
}

type ConnectType = 'learn' | 'deliver'

// ── Toggle Button (for FormScreen header) ─────────────────────────────

export function FormSettingsButton({ form, moduleIndex, formIndex, mb, notifyBlueprintChanged }: FormSettingsPanelProps) {
  const [open, setOpen] = useState(false)
  const hasConnect = !!form.connect && !!mb.getBlueprint().connect_type
  const animRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const { refs, floatingStyles } = useFloating({
    placement: 'bottom-start',
    middleware: [
      offset(8),
      flip(),
      shift({ padding: 12 }),
    ],
    whileElementsMounted: autoUpdate,
  })

  // Manually set reference from the button element — same pattern as ContextualEditor
  useLayoutEffect(() => {
    if (buttonRef.current) {
      refs.setReference(buttonRef.current)
    }
  }, [refs])

  // Entrance animation via Web Animations API (matches ContextualEditor pattern)
  useLayoutEffect(() => {
    if (open) {
      animRef.current?.animate(
        [
          { opacity: 0, transform: 'scale(0.97) translateY(-4px)' },
          { opacity: 1, transform: 'scale(1) translateY(0)' },
        ],
        { duration: 150, easing: 'ease-out' },
      )
    }
  }, [open])

  return (
    <>
      <button
        ref={buttonRef}
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1 p-1.5 rounded-md transition-colors cursor-pointer text-nova-text-muted hover:text-nova-text hover:bg-white/5"
        aria-label="Form settings"
      >
        <Icon icon={ciSettings} width="18" height="18" />
        {hasConnect && (
          <ConnectLogomark size={12} className="text-nova-violet-bright" />
        )}
      </button>

      {open && (
        <FloatingPortal>
          <div
            ref={(el) => { animRef.current = el; refs.setFloating(el) }}
            style={floatingStyles}
            className="z-popover"
          >
            <FormSettingsPanel
              form={form}
              moduleIndex={moduleIndex}
              formIndex={formIndex}
              mb={mb}
              notifyBlueprintChanged={notifyBlueprintChanged}
              onClose={() => setOpen(false)}
            />
          </div>
        </FloatingPortal>
      )}
    </>
  )
}

// ── Panel ──────────────────────────────────────────────────────────────

function FormSettingsPanel({
  form, moduleIndex, formIndex, mb, notifyBlueprintChanged, onClose,
}: FormSettingsPanelProps & { onClose: () => void }) {
  const [modalOpen, setModalOpen] = useState(false)
  const dismissRef = useDismissRef(() => { if (!modalOpen) onClose() })

  return (
    <div
      ref={dismissRef}
      className="w-80 rounded-xl bg-[rgba(10,10,26,0.85)] backdrop-blur-[12px] [-webkit-backdrop-filter:blur(12px)] border border-white/[0.08] shadow-[0_24px_48px_rgba(0,0,0,0.6)]"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-white/[0.06]">
        <span className="text-xs font-medium text-nova-text-secondary uppercase tracking-wider">Form Settings</span>
        <button
          onClick={onClose}
          className="p-1 -mr-1 rounded-md text-nova-text-muted hover:text-nova-text hover:bg-white/[0.06] transition-colors cursor-pointer"
        >
          <Icon icon={ciClose} width="14" height="14" />
        </button>
      </div>

      {/* Content */}
      <div className="px-3.5 py-3 space-y-3 overflow-y-auto max-h-[480px]">
        <FormDetail
          form={form}
          moduleIndex={moduleIndex}
          formIndex={formIndex}
          mb={mb}
          notifyBlueprintChanged={notifyBlueprintChanged}
        />

        <ConnectSection
          form={form}
          moduleIndex={moduleIndex}
          formIndex={formIndex}
          mb={mb}
          notifyBlueprintChanged={notifyBlueprintChanged}
          onModalChange={setModalOpen}
        />
      </div>
    </div>
  )
}

// ── Connect Configuration Section ──────────────────────────────────────

function ConnectSection({ form, moduleIndex, formIndex, mb, notifyBlueprintChanged, onModalChange }: FormSettingsPanelProps & { onModalChange: (open: boolean) => void }) {
  const connectType = mb.getBlueprint().connect_type
  const connect = form.connect
  const enabled = !!connect

  const save = useCallback((config: ConnectConfig | null) => {
    mb.updateForm(moduleIndex, formIndex, { connect: config })
    notifyBlueprintChanged()
  }, [mb, moduleIndex, formIndex, notifyBlueprintChanged])

  // Store the last config so toggling off/on doesn't lose values
  const lastConfigRef = useRef(connect)
  if (connect) lastConfigRef.current = connect

  const toggle = useCallback(() => {
    if (enabled) {
      save(null)
    } else {
      // Restore previous config, or create a sensible default
      const restored = lastConfigRef.current
      if (restored && Object.keys(restored).length > 0) {
        save(restored)
      } else {
        save(connectType === 'learn' ? { assessment: { user_score: '100' } } : {})
      }
    }
  }, [enabled, connectType, save])

  if (!connectType) return null

  return (
    <div className="border-t border-white/[0.06] pt-3">
      {/* Header row with toggle */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-nova-text-secondary uppercase tracking-wider">
            Connect
          </span>
          <span className="h-[18px] px-1.5 text-[10px] font-medium rounded bg-nova-violet/10 text-nova-violet-bright border border-nova-violet/20 flex items-center capitalize">
            {connectType}
          </span>
        </div>
        <Toggle enabled={enabled} onToggle={toggle} />
      </div>

      <AnimatePresence>
        {connect && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="pt-2.5 space-y-3">
              {/* Name — shared across learn/deliver */}
              <ConnectName connect={connect} connectType={connectType} save={save} />

              {/* Learn config */}
              {connectType === 'learn' && (
                <LearnConfig connect={connect} save={save} mb={mb} moduleIndex={moduleIndex} formIndex={formIndex} onModalChange={onModalChange} />
              )}

            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Connect Name (shared) ──────────────────────────────────────────────

function ConnectName({ connect, connectType, save }: { connect: ConnectConfig; connectType: ConnectType; save: (c: ConnectConfig) => void }) {
  const name = connectType === 'learn'
    ? (connect.learn_module?.name ?? '')
    : (connect.deliver_unit?.name ?? '')

  const onChange = useCallback((v: string) => {
    if (connectType === 'learn') {
      const current = connect.learn_module ?? { name: '', description: '', time_estimate: 5 }
      save({ ...connect, learn_module: { ...current, name: v } })
    } else {
      const current = connect.deliver_unit ?? { name: '', entity_id: '', entity_name: '' }
      save({ ...connect, deliver_unit: { ...current, name: v } })
    }
  }, [connect, connectType, save])

  return <InlineField label="Name" value={name} onChange={onChange} required />
}

// ── Shared types for sub-configs ───────────────────────────────────────

interface ConnectSubConfigProps {
  connect: ConnectConfig
  save: (c: ConnectConfig) => void
  mb: MutableBlueprint
  moduleIndex: number
  formIndex: number
  onModalChange: (open: boolean) => void
}

function useXPathModal(mb: MutableBlueprint, moduleIndex: number, formIndex: number, onModalChange: (open: boolean) => void) {
  const [modal, setModalRaw] = useState<{ label: string; value: string; onSave: (v: string) => void }>()
  const setModal = useCallback((m: typeof modal) => {
    setModalRaw(m)
    onModalChange(!!m)
  }, [onModalChange])
  const getLintContext = useCallback(() => {
    const blueprint = mb.getBlueprint()
    const form = mb.getForm(moduleIndex, formIndex)
    const mod = mb.getModule(moduleIndex)
    if (!form) return undefined
    return { blueprint, form, moduleCaseType: mod?.case_type ?? undefined }
  }, [mb, moduleIndex, formIndex])
  return { modal, setModal, getLintContext }
}

// ── Learn Config Fields ────────────────────────────────────────────────

function LearnConfig({ connect, save, mb, moduleIndex, formIndex, onModalChange }: ConnectSubConfigProps) {
  const lm = connect.learn_module
  const { modal, setModal, getLintContext } = useXPathModal(mb, moduleIndex, formIndex, onModalChange)

  const updateLearnModule = useCallback((field: string, value: string | number) => {
    const current = connect.learn_module ?? { name: '', description: '', time_estimate: 5 }
    save({ ...connect, learn_module: { ...current, [field]: value } })
  }, [connect, save])

  return (
    <>
      <div className="space-y-2">
        <InlineField
          label="Description"
          value={lm?.description ?? ''}
          onChange={(v) => updateLearnModule('description', v)}
          multiline
          required
        />
        <InlineField
          label="Time Estimate"
          value={String(lm?.time_estimate ?? 5)}
          onChange={(v) => updateLearnModule('time_estimate', Math.max(1, parseInt(v) || 1))}
          suffix="min"
          type="number"
          required
        />
        <div>
          <label className="text-[10px] text-nova-text-muted uppercase tracking-wider mb-0.5 flex items-center gap-0.5">
            Assessment Score<span className="text-nova-rose">*</span>
          </label>
          <XPathField
            value={connect.assessment?.user_score ?? ''}
            onClick={() => setModal({
              label: 'Assessment Score',
              value: connect.assessment?.user_score ?? '',
              onSave: (v) => { if (v.trim()) save({ ...connect, assessment: { user_score: v } }) },
            })}
          />
        </div>
      </div>

      {modal && (
        <XPathEditorModal
          value={modal.value}
          label={modal.label}
          onSave={(v) => { modal.onSave(v); setModal(undefined) }}
          onClose={() => setModal(undefined)}
          getLintContext={getLintContext}
        />
      )}
    </>
  )
}


// ── Inline Field ───────────────────────────────────────────────────────

function InlineField({
  label, value, onChange, mono, multiline, placeholder, suffix, type = 'text', required,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  mono?: boolean
  multiline?: boolean
  placeholder?: string
  suffix?: string
  type?: string
  required?: boolean
}) {
  const [localValue, setLocalValue] = useState(value)
  const [focused, setFocused] = useState(false)
  const commitTimeout = useRef<ReturnType<typeof setTimeout>>(undefined)

  // Sync external value changes (from undo/redo or other sources)
  useEffect(() => {
    if (!focused) setLocalValue(value)
  }, [value, focused])

  const commit = useCallback((v: string) => {
    clearTimeout(commitTimeout.current)
    if (v !== value) onChange(v)
  }, [value, onChange])

  const handleBlur = useCallback(() => {
    setFocused(false)
    if (required && !localValue.trim()) {
      setLocalValue(value)
    } else {
      commit(localValue)
    }
  }, [localValue, value, required, commit])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !multiline) {
      e.preventDefault()
      ;(e.target as HTMLElement).blur()
    }
    if (e.key === 'Escape') {
      setLocalValue(value)
      ;(e.target as HTMLElement).blur()
    }
  }, [multiline, value])

  const Tag = multiline ? 'textarea' : 'input'

  return (
    <div>
      <label className="text-[10px] text-nova-text-muted uppercase tracking-wider mb-0.5 flex items-center gap-0.5">{label}{required && <span className="text-nova-rose">*</span>}</label>
      <div className="relative">
        <Tag
          type={type === 'number' ? 'number' : 'text'}
          value={localValue}
          onChange={(e) => setLocalValue(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          autoComplete="off"
          data-1p-ignore
          rows={multiline ? 2 : undefined}
          min={type === 'number' ? 1 : undefined}
          className={`w-full text-xs px-2 py-1.5 rounded-md border transition-colors outline-none resize-none ${
            mono ? 'font-mono text-nova-cyan-bright' : 'text-nova-text'
          } ${
            focused
              ? 'bg-nova-surface border-nova-violet/50'
              : 'bg-transparent border-white/[0.06] hover:border-white/[0.12]'
          } ${suffix ? 'pr-8' : ''}`}
        />
        {suffix && (
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-nova-text-muted pointer-events-none">
            {suffix}
          </span>
        )}
      </div>
    </div>
  )
}
