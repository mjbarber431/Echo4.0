import { useMemo, useState } from 'react'
import { Plus, X } from 'lucide-react'
import type { Diagnosis } from '@shared/types'

// Common outpatient ICD-10-CM codes for quick entry. Any code can be typed.
const COMMON: Diagnosis[] = [
  { code: 'F41.1', description: 'Generalized anxiety disorder' },
  { code: 'F41.0', description: 'Panic disorder' },
  { code: 'F40.10', description: 'Social anxiety disorder, unspecified' },
  { code: 'F41.9', description: 'Anxiety disorder, unspecified' },
  { code: 'F32.0', description: 'Major depressive disorder, single episode, mild' },
  { code: 'F32.1', description: 'Major depressive disorder, single episode, moderate' },
  { code: 'F32.2', description: 'Major depressive disorder, single episode, severe without psychotic features' },
  { code: 'F33.0', description: 'Major depressive disorder, recurrent, mild' },
  { code: 'F33.1', description: 'Major depressive disorder, recurrent, moderate' },
  { code: 'F33.2', description: 'Major depressive disorder, recurrent, severe without psychotic features' },
  { code: 'F34.1', description: 'Persistent depressive disorder (dysthymia)' },
  { code: 'F43.10', description: 'Post-traumatic stress disorder, unspecified' },
  { code: 'F43.12', description: 'Post-traumatic stress disorder, chronic' },
  { code: 'F43.20', description: 'Adjustment disorder, unspecified' },
  { code: 'F43.21', description: 'Adjustment disorder with depressed mood' },
  { code: 'F43.22', description: 'Adjustment disorder with anxiety' },
  { code: 'F43.23', description: 'Adjustment disorder with mixed anxiety and depressed mood' },
  { code: 'F42.2', description: 'Obsessive-compulsive disorder, mixed obsessional thoughts and acts' },
  { code: 'F90.0', description: 'ADHD, predominantly inattentive presentation' },
  { code: 'F90.2', description: 'ADHD, combined presentation' },
  { code: 'F31.81', description: 'Bipolar II disorder' },
  { code: 'F60.3', description: 'Borderline personality disorder' },
  { code: 'F50.2', description: 'Bulimia nervosa' },
  { code: 'F10.20', description: 'Alcohol use disorder, moderate/severe (alcohol dependence, uncomplicated)' },
  { code: 'F51.01', description: 'Primary insomnia' }
]

export function DiagnosisPicker({ value, onChange }: { value: Diagnosis[]; onChange(next: Diagnosis[]): void }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    const taken = new Set(value.map((d) => d.code))
    return COMMON.filter((d) => !taken.has(d.code) && (!q || d.code.toLowerCase().includes(q) || d.description.toLowerCase().includes(q))).slice(0, 7)
  }, [query, value])

  const add = (d: Diagnosis) => {
    onChange([...value, d])
    setQuery('')
  }

  const addTyped = () => {
    const m = /^([A-Z]\d{2}(?:\.[0-9A-Z]{1,4})?)\s*[-–:]?\s*(.*)$/i.exec(query.trim())
    if (m) add({ code: m[1].toUpperCase(), description: m[2] || '' })
  }

  return (
    <div className="dx-picker">
      {value.length > 0 && (
        <div className="dx-chips">
          {value.map((d) => (
            <span key={d.code} className="chip chip-dx">
              <b>{d.code}</b> {d.description}
              <button onClick={() => onChange(value.filter((x) => x.code !== d.code))} aria-label={`Remove ${d.code}`}>
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="dx-input">
        <input
          value={query}
          placeholder="Search or type an ICD-10 code (e.g. F41.1)"
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              if (matches[0] && query.trim()) add(matches[0])
              else addTyped()
            }
          }}
        />
        {open && (matches.length > 0 || query.trim()) && (
          <div className="dx-menu">
            {matches.map((d) => (
              <button key={d.code} onMouseDown={(e) => (e.preventDefault(), add(d))}>
                <b>{d.code}</b> {d.description}
              </button>
            ))}
            {query.trim() && matches.length === 0 && (
              <button onMouseDown={(e) => (e.preventDefault(), addTyped())}>
                <Plus size={12} /> Add “{query.trim()}”
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
