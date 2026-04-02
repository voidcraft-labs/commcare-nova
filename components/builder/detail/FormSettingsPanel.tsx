'use client'
import { useState, useCallback, useRef, useLayoutEffect } from 'react'
import { useFloating, offset, flip, shift, autoUpdate, FloatingPortal } from '@floating-ui/react'
import { motion, AnimatePresence } from 'motion/react'
import { Icon } from '@iconify/react/offline'
import ciSettings from '@iconify-icons/ci/settings'
import ciClose from '@iconify-icons/ci/close-md'
import type { BlueprintForm, ConnectConfig, ConnectType, PostSubmitDestination } from '@/lib/schemas/blueprint'
import type { MutableBlueprint } from '@/lib/services/mutableBlueprint'
import { toSnakeId } from '@/lib/services/commcare/validate'
import { POPOVER_GLASS } from '@/lib/styles'
import { POPOVER_ENTER_KEYFRAMES, POPOVER_ENTER_OPTIONS } from '@/lib/animations'
import { FormDetail } from './FormDetail'
import { ConnectLogomark } from '@/components/icons/ConnectLogomark'
import { Toggle } from '@/components/ui/Toggle'
import { useDismissRef } from '@/hooks/useDismissRef'
import { useContentPopoverDismiss } from '@/hooks/useContentPopover'
import { useCommitField } from '@/hooks/useCommitField'
import { SavedCheck } from '@/components/builder/EditableTitle'
import { XPathField } from '@/components/builder/XPathField'
import type { XPathLintContext } from '@/lib/codemirror/xpath-lint'

// ── Types ─────────────────────────────────────────────────────────────

interface FormSettingsPanelProps {
  form: BlueprintForm
  moduleIndex: number
  formIndex: number
  mb: MutableBlueprint
  notifyBlueprintChanged: () => void
}


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

  /* Entrance animation — shared popover scale-up + fade. */
  useLayoutEffect(() => {
    if (open) {
      animRef.current?.animate(POPOVER_ENTER_KEYFRAMES, POPOVER_ENTER_OPTIONS)
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
  const dismissRef = useDismissRef(() => {
    /* Don't dismiss when a CodeMirror autocomplete tooltip (portal-mounted
     * to body, outside the panel DOM) received the click. */
    if (document.querySelector('.cm-tooltip-autocomplete')) return
    onClose()
  })
  useContentPopoverDismiss(onClose)

  return (
    <div
      ref={dismissRef}
      className={`w-80 ${POPOVER_GLASS}`}
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
        <FormDetail form={form} />

        <AfterSubmitSection
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
        />
      </div>
    </div>
  )
}

// ── After Submit Section ──────────────────────────────────────────────

const AFTER_SUBMIT_OPTIONS: Array<{ value: PostSubmitDestination; label: string; description: string }> = [
  { value: 'default', label: 'App Home', description: 'Back to the main screen' },
  { value: 'module', label: 'This Module', description: 'Stay in this module\'s form list' },
  { value: 'previous', label: 'Previous Screen', description: 'Back to where the user was' },
]

/** Map internal-only values (root, parent_module) to their user-facing equivalent. */
function resolveUserFacing(dest: PostSubmitDestination): PostSubmitDestination {
  if (dest === 'root') return 'default'
  if (dest === 'parent_module') return 'module'
  return dest
}

function AfterSubmitSection({ form, moduleIndex, formIndex, mb, notifyBlueprintChanged }: FormSettingsPanelProps) {
  const [open, setOpen] = useState(false)
  const current = resolveUserFacing(form.post_submit ?? 'default')
  const currentLabel = AFTER_SUBMIT_OPTIONS.find(o => o.value === current)?.label ?? 'App Home'
  const dismissRef = useDismissRef(() => setOpen(false))

  const handleSelect = useCallback((value: PostSubmitDestination) => {
    mb.updateForm(moduleIndex, formIndex, { post_submit: value === 'default' ? null : value })
    notifyBlueprintChanged()
    setOpen(false)
  }, [mb, moduleIndex, formIndex, notifyBlueprintChanged])

  return (
    <div>
      <label className="text-xs font-medium text-nova-text-secondary uppercase tracking-wider mb-1.5 block">
        After Submit
      </label>
      <div className="relative" ref={dismissRef}>
        <button
          onClick={() => setOpen(o => !o)}
          className="w-full flex items-center justify-between px-2 py-1.5 text-xs rounded-md border transition-colors cursor-pointer text-nova-text bg-transparent border-white/[0.06] hover:border-white/[0.12]"
        >
          <span>{currentLabel}</span>
          <svg width="10" height="10" viewBox="0 0 10 10" className={`text-nova-text-muted transition-transform ${open ? 'rotate-180' : ''}`}>
            <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        {open && (
          <div className="absolute z-10 mt-1 w-full rounded-md border border-white/[0.08] bg-nova-elevated shadow-lg overflow-hidden">
            {AFTER_SUBMIT_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => handleSelect(opt.value)}
                className={`w-full text-left px-2.5 py-1.5 text-xs transition-colors cursor-pointer ${
                  opt.value === current
                    ? 'text-nova-violet-bright bg-nova-violet/10'
                    : 'text-nova-text hover:bg-white/[0.04]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Connect Configuration Section ──────────────────────────────────────

function ConnectSection({ form, moduleIndex, formIndex, mb, notifyBlueprintChanged }: FormSettingsPanelProps) {
  const connectType = mb.getBlueprint().connect_type as ConnectType | undefined
  const connect = form.connect
  const enabled = !!connect

  const save = useCallback((config: ConnectConfig | null) => {
    mb.updateForm(moduleIndex, formIndex, { connect: config })
    notifyBlueprintChanged()
  }, [mb, moduleIndex, formIndex, notifyBlueprintChanged])

  const toggle = useCallback(() => {
    if (enabled) {
      // Stash before toggling off
      if (connect && connectType) {
        mb.stashFormConnect(connectType, moduleIndex, formIndex, connect)
      }
      save(null)
    } else if (connectType) {
      // Restore from stash, or create defaults
      const stashed = mb.getFormConnectStash(connectType, moduleIndex, formIndex)
      if (stashed) {
        save(stashed)
      } else {
        const mod = mb.getModule(moduleIndex)
        const formData = mb.getForm(moduleIndex, formIndex)
        const modSlug = toSnakeId(mod?.name ?? '')
        const formSlug = toSnakeId(formData?.name ?? '')
        if (connectType === 'learn') {
          save({
            learn_module: { id: modSlug, name: formData?.name ?? '', description: formData?.name ?? '', time_estimate: 5 },
            assessment: { id: `${modSlug}_${formSlug}`, user_score: '100' },
          })
        } else {
          save({
            deliver_unit: { id: modSlug, name: formData?.name ?? '', entity_id: "concat(#user/username, '-', today())", entity_name: '#user/username' },
          })
        }
      }
    }
  }, [enabled, connect, connectType, mb, moduleIndex, formIndex, save])

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
              {/* Learn config — sub-toggles for learn_module and assessment */}
              {connectType === 'learn' && (
                <LearnConfig connect={connect} save={save} mb={mb} moduleIndex={moduleIndex} formIndex={formIndex} />
              )}

              {/* Deliver config — name + unit fields + task sub-toggle */}
              {connectType === 'deliver' && (
                <>
                  <ConnectName connect={connect} connectType={connectType} save={save} />
                  <DeliverConfig connect={connect} save={save} mb={mb} moduleIndex={moduleIndex} formIndex={formIndex} />
                </>
              )}

            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Connect Name (shared) ──────────────────────────────────────────────

function ConnectName({ connect, save }: { connect: ConnectConfig; connectType: ConnectType; save: (c: ConnectConfig) => void }) {
  const name = connect.deliver_unit?.name ?? ''

  const onChange = useCallback((v: string) => {
    const current = connect.deliver_unit ?? { name: '', entity_id: '', entity_name: '' }
    save({ ...connect, deliver_unit: { ...current, name: v } })
  }, [connect, save])

  return <InlineField label="Name" value={name} onChange={onChange} required />
}

// ── Shared types for sub-configs ───────────────────────────────────────

interface ConnectSubConfigProps {
  connect: ConnectConfig
  save: (c: ConnectConfig) => void
  mb: MutableBlueprint
  moduleIndex: number
  formIndex: number
}

/** Shared lint context getter for XPath fields in connect sub-configs. */
function useConnectLintContext(mb: MutableBlueprint, moduleIndex: number, formIndex: number) {
  return useCallback((): XPathLintContext | undefined => {
    const blueprint = mb.getBlueprint()
    const form = mb.getForm(moduleIndex, formIndex)
    const mod = mb.getModule(moduleIndex)
    if (!form) return undefined
    return { blueprint, form, moduleCaseType: mod?.case_type ?? undefined }
  }, [mb, moduleIndex, formIndex])
}

// ── Learn Config Fields ────────────────────────────────────────────────

function LearnConfig({ connect, save, mb, moduleIndex, formIndex }: ConnectSubConfigProps) {
  const lm = connect.learn_module
  const assessment = connect.assessment
  const learnEnabled = !!lm
  const assessmentEnabled = !!assessment
  const lastLearnRef = useRef(lm)
  const lastAssessmentRef = useRef(assessment)
  if (lm) lastLearnRef.current = lm
  if (assessment) lastAssessmentRef.current = assessment
  const getLintContext = useConnectLintContext(mb, moduleIndex, formIndex)

  const defaultIds = useCallback(() => {
    const mod = mb.getModule(moduleIndex)
    const formData = mb.getForm(moduleIndex, formIndex)
    const modSlug = toSnakeId(mod?.name ?? '')
    const formSlug = toSnakeId(formData?.name ?? '')
    return { learnId: modSlug, assessmentId: `${modSlug}_${formSlug}` }
  }, [mb, moduleIndex, formIndex])

  const updateLearnModule = useCallback((field: string, value: string | number) => {
    const { learnId } = defaultIds()
    const current = connect.learn_module ?? { id: learnId, name: '', description: '', time_estimate: 5 }
    save({ ...connect, learn_module: { ...current, [field]: value } })
  }, [connect, save, defaultIds])

  const toggleLearn = useCallback(() => {
    if (learnEnabled) {
      const { learn_module: _removed, ...rest } = connect
      save(rest as ConnectConfig)
    } else {
      const restored = lastLearnRef.current
      if (restored && restored.name.trim()) {
        save({ ...connect, learn_module: restored })
      } else {
        const { learnId } = defaultIds()
        const formData = mb.getForm(moduleIndex, formIndex)
        save({ ...connect, learn_module: { id: learnId, name: formData?.name ?? '', description: formData?.name ?? '', time_estimate: 5 } })
      }
    }
  }, [learnEnabled, connect, save, mb, moduleIndex, formIndex, defaultIds])

  const toggleAssessment = useCallback(() => {
    if (assessmentEnabled) {
      const { assessment: _removed, ...rest } = connect
      save(rest as ConnectConfig)
    } else {
      const restored = lastAssessmentRef.current
      if (restored && restored.user_score.trim()) {
        save({ ...connect, assessment: restored })
      } else {
        const { assessmentId } = defaultIds()
        save({ ...connect, assessment: { id: assessmentId, user_score: '100' } })
      }
    }
  }, [assessmentEnabled, connect, save, defaultIds])

  return (
    <>
      <div className="space-y-2">
        {/* Learn Module sub-toggle */}
        <div className="rounded-lg bg-white/[0.03] border border-white/[0.05] px-2.5 py-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-nova-text-muted uppercase tracking-wider">Learn Module</span>
            <Toggle enabled={learnEnabled} onToggle={toggleLearn} variant="sub" />
          </div>
          <AnimatePresence>
            {lm && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.15, ease: 'easeOut' }}
                className="overflow-hidden"
              >
                <div className="space-y-2 pt-2.5 mt-2 border-t border-white/[0.05]">
                  <InlineField
                    label="Module ID"
                    value={lm.id ?? 'connect_learn'}
                    onChange={(v) => updateLearnModule('id', v)}
                    mono
                    required
                  />
                  <InlineField
                    label="Name"
                    value={lm.name}
                    onChange={(v) => updateLearnModule('name', v)}
                    required
                  />
                  <InlineField
                    label="Description"
                    value={lm.description}
                    onChange={(v) => updateLearnModule('description', v)}
                    multiline
                    required
                  />
                  <InlineField
                    label="Time Estimate"
                    value={String(lm.time_estimate)}
                    onChange={(v) => updateLearnModule('time_estimate', Math.max(1, parseInt(v) || 1))}
                    suffix="min"
                    type="number"
                    required
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Assessment sub-toggle */}
        <div className="rounded-lg bg-white/[0.03] border border-white/[0.05] px-2.5 py-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-nova-text-muted uppercase tracking-wider">Assessment</span>
            <Toggle enabled={assessmentEnabled} onToggle={toggleAssessment} variant="sub" />
          </div>
          <AnimatePresence>
            {assessment && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.15, ease: 'easeOut' }}
                className="overflow-hidden"
              >
                <div className="space-y-2 pt-2.5 mt-2 border-t border-white/[0.05]">
                  <InlineField
                    label="Assessment ID"
                    value={assessment.id ?? 'connect_assessment'}
                    onChange={(v) => save({ ...connect, assessment: { ...assessment, id: v } })}
                    mono
                    required
                  />
                  <div>
                    <label className="text-[10px] text-nova-text-muted uppercase tracking-wider mb-0.5 flex items-center gap-0.5">
                      User Score<span className="text-nova-rose">*</span>
                    </label>
                    <XPathField
                      value={assessment.user_score}
                      onSave={(v) => { if (v.trim()) save({ ...connect, assessment: { ...assessment, user_score: v } }) }}
                      getLintContext={getLintContext}
                    />
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </>
  )
}


// ── Deliver Config Fields ──────────────────────────────────────────────

function DeliverConfig({ connect, save, mb, moduleIndex, formIndex }: ConnectSubConfigProps) {
  const du = connect.deliver_unit
  const task = connect.task
  const taskEnabled = !!task
  const lastTaskRef = useRef(task)
  if (task) lastTaskRef.current = task
  const getLintContext = useConnectLintContext(mb, moduleIndex, formIndex)

  const updateDeliverUnit = useCallback((field: string, value: string) => {
    const current = connect.deliver_unit ?? { name: '', entity_id: '', entity_name: '' }
    save({ ...connect, deliver_unit: { ...current, [field]: value } })
  }, [connect, save])

  const updateTask = useCallback((field: string, value: string) => {
    const current = connect.task ?? { name: '', description: '' }
    save({ ...connect, task: { ...current, [field]: value } })
  }, [connect, save])

  const toggleTask = useCallback(() => {
    if (taskEnabled) {
      // Save task data before removing
      const { task: _removed, ...rest } = connect
      save(rest as ConnectConfig)
    } else {
      // Restore previous or create defaults
      const restored = lastTaskRef.current
      const formData = mb.getForm(moduleIndex, formIndex)
      save({
        ...connect,
        task: restored && (restored.name.trim() || restored.description.trim())
          ? restored
          : { name: formData?.name ?? '', description: formData?.name ?? '' },
      })
    }
  }, [taskEnabled, connect, save, mb, moduleIndex, formIndex])

  return (
    <>
      <div className="space-y-2">
        <div>
          <label className="text-[10px] text-nova-text-muted uppercase tracking-wider mb-0.5 flex items-center gap-0.5">
            Entity ID<span className="text-nova-rose">*</span>
          </label>
          <XPathField
            value={du?.entity_id ?? ''}
            onSave={(v) => { if (v.trim()) updateDeliverUnit('entity_id', v) }}
            getLintContext={getLintContext}
          />
        </div>
        <div>
          <label className="text-[10px] text-nova-text-muted uppercase tracking-wider mb-0.5 flex items-center gap-0.5">
            Entity Name<span className="text-nova-rose">*</span>
          </label>
          <XPathField
            value={du?.entity_name ?? ''}
            onSave={(v) => { if (v.trim()) updateDeliverUnit('entity_name', v) }}
            getLintContext={getLintContext}
          />
        </div>

        {/* Task sub-toggle */}
        <div className="rounded-lg bg-white/[0.03] border border-white/[0.05] px-2.5 py-2 mt-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-nova-text-muted uppercase tracking-wider">Task</span>
            <Toggle enabled={taskEnabled} onToggle={toggleTask} variant="sub" />
          </div>
          <AnimatePresence>
            {task && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.15, ease: 'easeOut' }}
                className="overflow-hidden"
              >
                <div className="space-y-2 pt-2.5 mt-2 border-t border-white/[0.05]">
                  <InlineField
                    label="Task Name"
                    value={task.name}
                    onChange={(v) => updateTask('name', v)}
                    required
                  />
                  <InlineField
                    label="Task Description"
                    value={task.description}
                    onChange={(v) => updateTask('description', v)}
                    multiline
                    required
                  />
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </>
  )
}

// ── Inline Field ───────────────────────────────────────────────────────

/**
 * Compact text field used inside FormSettingsPanel for connect configuration.
 * Shares the same commit/cancel/checkmark model as EditableText (via
 * useCommitField): blur or Enter commits, Escape cancels with stopPropagation,
 * and an emerald checkmark animates in the label for 1.5 s after a save.
 */
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
  const { draft, setDraft, focused, saved, ref, handleFocus, handleBlur, handleKeyDown } = useCommitField({
    value,
    onSave: onChange,
    required,
    multiline,
  })

  const Tag = multiline ? 'textarea' : 'input'

  return (
    <div>
      <label className="text-[10px] text-nova-text-muted uppercase tracking-wider mb-0.5 flex items-center gap-0.5">
        {label}
        {required && <span className="text-nova-rose ml-0.5">*</span>}
        <SavedCheck visible={saved && !focused} size={10} className="shrink-0" />
      </label>
      <div className="relative">
        <Tag
          ref={ref as React.RefCallback<HTMLInputElement & HTMLTextAreaElement>}
          type={type === 'number' ? 'number' : 'text'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={handleFocus}
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
