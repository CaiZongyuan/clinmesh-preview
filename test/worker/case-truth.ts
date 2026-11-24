import { expect } from 'vitest'
import casePack from '../../data/golden-cases/outpatient-golden-case-pack.json'

// Shared by every Worker-seam test that checks what leaves the server: HTTP bodies now, and
// later WebSocket frames, Simulated Patient replies and Clinical Copilot context.

type GoldenCase = (typeof casePack.cases)[number]

export const CASE_TRUTH_FIELDS = [
  'title',
  'titleEn',
  'indexConditions',
  'physicalExamination',
  'laboratories',
  'textResults',
  'reportAmendments',
  'debriefReference',
] as const satisfies readonly (keyof GoldenCase)[]

// Short words that give a diagnosis away even when no longer Case Truth sentence is quoted.
const DIAGNOSIS_TOKENS: Record<string, readonly string[]> = {
  'golden-case-01': ['肺炎', 'pneumonia', '实变', '啰音', 'CURB', 'J18'],
}

// Which catalog item a result belongs to is not Case Truth; the result is.
const CATALOG_IDENTITY_KEYS = new Set(['id', 'catalogItem', 'codings', 'system', 'version', 'unit', 'unitDisplay', 'referenceRange'])

const MIN_FRAGMENT_LENGTH = 4
const CLAUSE_BREAK = /[，。；、：（）();,！？!?\n]+/

// A number stands alone unless it touches a letter, digit, dot, colon, sign or percent-encoding,
// which keeps ids, UUIDs and ISO timestamps from matching.
const NUMBER_TOKEN = /(?<![\w.:+%-])\d+(?:\.\d+)?(?![\w.:-])/g
const standaloneNumber = (n: number) =>
  new RegExp(`(?<![\\w.:+%-])${String(n).replace('.', '\\.')}(?![\\w.:-])`)

function leaves(value: unknown, skipKeys = new Set<string>()): unknown[] {
  if (Array.isArray(value)) return value.flatMap((item) => leaves(item, skipKeys))
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => (skipKeys.has(key) ? [] : leaves(item, skipKeys)))
  }
  return [value]
}

const numbersIn = (text: string) => [...text.matchAll(NUMBER_TOKEN)].map((m) => m[0])
// Result values are denylisted from two digits up. Numbers quoted in Case Truth prose only from three digits
// or with a decimal: a bare "30" or "72" is too common in legitimate text, and those sentences are fragments anyway.
const isResultValue = (n: number) => String(n).replace('.', '').length >= 2
const isProseValue = (token: string) => token.includes('.') || token.length >= 3

export interface CaseTruthDenylist {
  fragments: string[]
  numbers: number[]
  tokens: string[]
}

// The snapshot's Case Truth, minus anything the snapshot also shows the doctor.
export function caseTruthDenylist(goldenCase: GoldenCase): CaseTruthDenylist {
  const truth = leaves(CASE_TRUTH_FIELDS.map((field) => goldenCase[field]), CATALOG_IDENTITY_KEYS)
  const truthStrings = truth.filter((v): v is string => typeof v === 'string')

  const visibleFields = Object.keys(goldenCase).filter((field) => !(CASE_TRUTH_FIELDS as readonly string[]).includes(field))
  const visible = leaves(visibleFields.map((field) => goldenCase[field as keyof GoldenCase]))
  const visibleStrings = visible.filter((v): v is string => typeof v === 'string')
  const visibleNumbers = new Set([...visible.filter((v) => typeof v === 'number'), ...visibleStrings.flatMap(numbersIn).map(Number)])

  const fragments = truthStrings
    .flatMap((text) => [text, ...text.split(CLAUSE_BREAK)])
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length >= MIN_FRAGMENT_LENGTH && !visibleStrings.some((v) => v.includes(fragment)))
  const numbers = [
    ...truth.filter((v): v is number => typeof v === 'number').filter(isResultValue),
    ...truthStrings.flatMap(numbersIn).filter(isProseValue).map(Number),
  ].filter((n) => !visibleNumbers.has(n))
  return {
    fragments: [...new Set(fragments)],
    numbers: [...new Set(numbers)],
    tokens: [...(DIAGNOSIS_TOKENS[goldenCase.id] ?? [])],
  }
}

export const goldenCaseDenylists = casePack.cases.map(caseTruthDenylist)

// Checks a response body (JSON or text) against every Golden Case's denylist.
export function expectNoCaseTruth(label: string, body: string) {
  let parsed: unknown = body
  try {
    parsed = JSON.parse(body)
  } catch {}
  const values = leaves(parsed)
  const strings = values.filter((v): v is string => typeof v === 'string')

  for (const { fragments, numbers, tokens } of goldenCaseDenylists) {
    for (const fragment of fragments) {
      expect(body, `${label} exposes Case Truth "${fragment}"`).not.toContain(fragment)
    }
    for (const token of tokens) {
      expect(body.toLowerCase(), `${label} exposes the diagnosis-revealing word "${token}"`).not.toContain(token.toLowerCase())
    }
    for (const n of numbers) {
      expect(values.includes(n), `${label} exposes the hidden value ${n}`).toBe(false)
      const pattern = standaloneNumber(n)
      const hit = strings.find((s) => pattern.test(s))
      expect(hit, `${label} exposes the hidden value ${n} in "${hit}"`).toBeUndefined()
    }
  }
  expect(body, `${label} exposes a diagnosis-revealing id`).not.toMatch(/(^|[^a-z])cap([^a-z]|$)/i)
}
