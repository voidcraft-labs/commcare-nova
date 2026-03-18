import { describe, it, expect } from 'vitest'
import { MutableBlueprint } from '../mutableBlueprint'
import { HistoryManager } from '../historyManager'
import type { AppBlueprint } from '../../schemas/blueprint'

function makeBlueprint(): AppBlueprint {
  return {
    app_name: 'Test App',
    modules: [{
      name: 'Module',
      forms: [{
        name: 'Form',
        type: 'registration',
        questions: [
          { id: 'q1', type: 'text', label: 'Q1' },
          { id: 'q2', type: 'text', label: 'Q2' },
          { id: 'q3', type: 'text', label: 'Q3' },
        ],
      }],
    }],
    case_types: [],
  }
}

describe('HistoryManager', () => {
  it('starts with empty stacks', () => {
    const mb = new MutableBlueprint(makeBlueprint())
    const hm = new HistoryManager(mb)
    expect(hm.canUndo).toBe(false)
    expect(hm.canRedo).toBe(false)
  })

  it('captures snapshot on mutation via proxy', () => {
    const mb = new MutableBlueprint(makeBlueprint())
    const hm = new HistoryManager(mb)
    hm.proxied.updateQuestion(0, 0, 'q1', { label: 'Changed' })
    expect(hm.canUndo).toBe(true)
  })

  it('undo restores previous state', () => {
    const mb = new MutableBlueprint(makeBlueprint())
    const hm = new HistoryManager(mb)
    hm.proxied.updateQuestion(0, 0, 'q1', { label: 'Changed' })
    expect(hm.proxied.getQuestion(0, 0, 'q1')?.question.label).toBe('Changed')

    const restored = hm.undo()
    expect(restored).not.toBeNull()
    expect(hm.proxied.getQuestion(0, 0, 'q1')?.question.label).toBe('Q1')
  })

  it('redo restores undone state', () => {
    const mb = new MutableBlueprint(makeBlueprint())
    const hm = new HistoryManager(mb)
    hm.proxied.updateQuestion(0, 0, 'q1', { label: 'Changed' })
    hm.undo()
    expect(hm.canRedo).toBe(true)

    hm.redo()
    expect(hm.proxied.getQuestion(0, 0, 'q1')?.question.label).toBe('Changed')
  })

  it('new mutation clears redo stack', () => {
    const mb = new MutableBlueprint(makeBlueprint())
    const hm = new HistoryManager(mb)
    hm.proxied.updateQuestion(0, 0, 'q1', { label: 'First' })
    hm.undo()
    expect(hm.canRedo).toBe(true)

    hm.proxied.updateQuestion(0, 0, 'q1', { label: 'Second' })
    expect(hm.canRedo).toBe(false)
  })

  it('undo returns null when stack is empty', () => {
    const mb = new MutableBlueprint(makeBlueprint())
    const hm = new HistoryManager(mb)
    expect(hm.undo()).toBeNull()
  })

  it('redo returns null when stack is empty', () => {
    const mb = new MutableBlueprint(makeBlueprint())
    const hm = new HistoryManager(mb)
    expect(hm.redo()).toBeNull()
  })

  it('respects maxDepth', () => {
    const mb = new MutableBlueprint(makeBlueprint())
    const hm = new HistoryManager(mb, 3)

    for (let i = 0; i < 5; i++) {
      hm.proxied.updateQuestion(0, 0, 'q1', { label: `Change ${i}` })
    }

    // Should only be able to undo 3 times
    let undoCount = 0
    while (hm.canUndo) {
      hm.undo()
      undoCount++
    }
    expect(undoCount).toBe(3)
  })

  it('does not snapshot when disabled', () => {
    const mb = new MutableBlueprint(makeBlueprint())
    const hm = new HistoryManager(mb)
    hm.enabled = false
    hm.proxied.updateQuestion(0, 0, 'q1', { label: 'Changed' })
    expect(hm.canUndo).toBe(false)
  })

  it('clear empties both stacks', () => {
    const mb = new MutableBlueprint(makeBlueprint())
    const hm = new HistoryManager(mb)
    hm.proxied.updateQuestion(0, 0, 'q1', { label: 'Changed' })
    hm.undo()
    expect(hm.canRedo).toBe(true)

    hm.clear()
    expect(hm.canUndo).toBe(false)
    expect(hm.canRedo).toBe(false)
  })

  it('read methods pass through without snapshot', () => {
    const mb = new MutableBlueprint(makeBlueprint())
    const hm = new HistoryManager(mb)
    // These should not create undo entries
    hm.proxied.getBlueprint()
    hm.proxied.getModule(0)
    hm.proxied.getForm(0, 0)
    hm.proxied.getQuestion(0, 0, 'q1')
    hm.proxied.search('q1')
    expect(hm.canUndo).toBe(false)
  })

  it('multiple undo/redo cycles work correctly', () => {
    const mb = new MutableBlueprint(makeBlueprint())
    const hm = new HistoryManager(mb)

    hm.proxied.updateQuestion(0, 0, 'q1', { label: 'A' })
    hm.proxied.updateQuestion(0, 0, 'q1', { label: 'B' })
    hm.proxied.updateQuestion(0, 0, 'q1', { label: 'C' })

    hm.undo() // C → B
    expect(hm.proxied.getQuestion(0, 0, 'q1')?.question.label).toBe('B')
    hm.undo() // B → A
    expect(hm.proxied.getQuestion(0, 0, 'q1')?.question.label).toBe('A')
    hm.redo() // A → B
    expect(hm.proxied.getQuestion(0, 0, 'q1')?.question.label).toBe('B')
    hm.redo() // B → C
    expect(hm.proxied.getQuestion(0, 0, 'q1')?.question.label).toBe('C')
  })
})
