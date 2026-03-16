'use client'
import { useState, useCallback } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView } from '@codemirror/view'
import { xpath } from '@/lib/codemirror/xpath-language'
import { novaXPathTheme } from '@/lib/codemirror/xpath-theme'
import { formatXPath } from '@/lib/codemirror/xpath-format'

const editorExtensions = [xpath(), EditorView.lineWrapping]

const SAMPLES = [
  "#case/age>18 and #form/gender='male'",
  "count(instance('casedb')/casedb/case[@case_type='household'])",
  ". ='yes' or .= 'no'",
  "/data/q[.>5]",
  "-5+3*( 2 div 4)",
  "f( a , b,c )",
  "child :: *",
  "if(#case/status='active',concat(#case/first_name,' ',#case/last_name),'Closed')",
  "selected(#form/symptoms,'fever') and #case/age<5",
  "today()-date(#case/dob)",
  "instance('casedb')/casedb/case[@case_type = 'mother' and @status = 'open'][last()]/case_name",
]

export default function XPathTestPage() {
  const [value, setValue] = useState(SAMPLES[0])

  const handleFormat = useCallback(() => {
    setValue(formatXPath(value))
  }, [value])

  const loadSample = useCallback((sample: string) => {
    setValue(sample)
  }, [])

  return (
    <div className="min-h-screen bg-nova-void p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        <h1 className="text-2xl font-display font-bold text-nova-text">
          XPath Playground
        </h1>
        <p className="text-sm text-nova-text-muted">
          Test CommCare XPath highlighting and formatting. Type or paste an expression, then hit Format.
        </p>

        {/* Editor */}
        <div className="rounded-lg border border-nova-border-bright overflow-hidden">
          <CodeMirror
            value={value}
            onChange={setValue}
            theme={novaXPathTheme}
            extensions={editorExtensions}
            basicSetup={false}
            height="auto"
            minHeight="80px"
          />
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleFormat}
            className="px-4 py-2 rounded-lg bg-nova-violet text-white text-sm font-medium hover:bg-nova-violet-bright transition-colors"
          >
            Format
          </button>
          <span className="text-xs text-nova-text-muted">
            {value.length} chars
          </span>
        </div>

        {/* Samples */}
        <div>
          <h2 className="text-sm font-medium text-nova-text-secondary mb-3">Sample Expressions</h2>
          <div className="space-y-1.5">
            {SAMPLES.map((sample, i) => (
              <button
                key={i}
                onClick={() => loadSample(sample)}
                className="block w-full text-left px-3 py-2 rounded-lg text-xs font-mono text-nova-text-muted hover:text-nova-text hover:bg-nova-surface transition-colors truncate"
              >
                {sample}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
