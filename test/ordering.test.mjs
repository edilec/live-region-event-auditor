/**
 * Ordering is observable, so it is pinned BEHAVIOURALLY.
 *
 * A source scan for `.localeCompare(` is not a determinism test: substituting
 * `Intl.Collator` produces identical collation drift with different source
 * text. These inputs are chosen so that code-unit order and collation order
 * genuinely differ, pushed through the real report path, and the exact emitted
 * order is asserted. One assertion proves the inputs discriminate: a collator
 * really does sort them differently.
 */

import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { auditJourney, byCodeUnit } from '../src/index.mjs'
import { NOW } from './helpers.mjs'

/** No age limit; the only thing in play is the order of the findings. */
const EXPECTATIONS = {
  schemaVersion: '1',
  duplicateWindowMs: 1000,
  maxUpdatesPerStep: 20,
  regions: { 'cart-status': { politeness: 'polite' } },
  steps: [],
}

/**
 * `MAX_DUPLICATE_URLS` before `MAX_DUPLICATE_URL_ENTRIES` because `S` (0x53)
 * precedes `_` (0x5F) by code point, while collation treats the underscore as
 * ignorable punctuation and puts `E` first. `Z` before `a` for the same kind of
 * reason, and `a-b` before `a_b` likewise.
 */
const IDS = ['a_b', 'a-region', 'Z-region', 'MAX_DUPLICATE_URL_ENTRIES', 'a-b', 'MAX_DUPLICATE_URLS']

const EXPECTED = [
  'MAX_DUPLICATE_URLS',
  'MAX_DUPLICATE_URL_ENTRIES',
  'Z-region',
  'a-b',
  'a-region',
  'a_b',
]

async function reportOver(ids) {
  // Each region resolves to `off` and is then written to, so each produces
  // exactly one finding, at a pointer built from its own id.
  const journey = {
    schemaVersion: '1',
    capture: { id: 'ordering', source: 'dom-mutation-record', recording: 'complete' },
    regions: ids.map((id) => ({ id, role: null, ariaLive: 'off', presentAtStart: true })),
    steps: [{
      name: 'only',
      updates: ids.map((id, index) => ({ region: id, text: `update ${id}`, atMs: index * 10000 })),
    }],
  }
  const directory = await mkdtemp(join(tmpdir(), 'lrea-order-'))
  const journeyPath = join(directory, 'journey.json')
  const expectationsPath = join(directory, 'expectations.json')
  await writeFile(journeyPath, JSON.stringify(journey))
  await writeFile(expectationsPath, JSON.stringify({ ...EXPECTATIONS, regions: {} , steps: [{ name: 'only', expect: [] }] }))
  return auditJourney({ journey: journeyPath, expectations: expectationsPath, now: NOW })
}

test('findings are emitted in code-unit order of their pointer', async () => {
  const report = await reportOver(IDS)
  assert.equal(report.findings.length, IDS.length)
  assert.deepEqual(
    report.findings.map((finding) => finding.location.pointer),
    EXPECTED.map((id) => `/steps/only/updates/${id}`),
  )
})

test('the order does not depend on the order the recording listed them in', async () => {
  const forward = await reportOver(IDS)
  const backward = await reportOver([...IDS].reverse())
  assert.deepEqual(
    forward.findings.map((finding) => finding.location.pointer),
    backward.findings.map((finding) => finding.location.pointer),
  )
})

test('these inputs really do discriminate: a collator orders them differently', () => {
  const collated = [...EXPECTED].sort(new Intl.Collator('en').compare)
  assert.notDeepEqual(collated, EXPECTED, 'if these agreed, the test above could not fail')
  const byLocale = [...EXPECTED].sort((a, b) => a.localeCompare(b))
  assert.notDeepEqual(byLocale, EXPECTED)
})

test('byCodeUnit is a total order over the same inputs', () => {
  assert.deepEqual([...IDS].sort(byCodeUnit), EXPECTED)
  assert.equal(byCodeUnit('a', 'a'), 0)
  assert.equal(byCodeUnit('Z', 'a'), -1)
  assert.equal(byCodeUnit('a', 'Z'), 1)
})

test('findings at the same location are ordered by rule id, by code unit', async () => {
  // `region-off-with-updates` and `update-text-empty` both land on the same
  // pointer, so the rule-id key is what decides, and reversing it would show.
  const journey = {
    schemaVersion: '1',
    capture: { id: 'same-pointer', source: 'dom-mutation-record', recording: 'complete' },
    regions: [{ id: 'quiet', role: 'timer', ariaLive: null, presentAtStart: true }],
    steps: [{ name: 'only', updates: [{ region: 'quiet', text: '\u200e', atMs: 0 }] }],
  }
  const directory = await mkdtemp(join(tmpdir(), 'lrea-order2-'))
  const journeyPath = join(directory, 'journey.json')
  const expectationsPath = join(directory, 'expectations.json')
  await writeFile(journeyPath, JSON.stringify(journey))
  await writeFile(expectationsPath, JSON.stringify({ ...EXPECTATIONS, regions: { quiet: { politeness: 'off' } }, steps: [] }))
  const report = await auditJourney({ journey: journeyPath, expectations: expectationsPath, now: NOW })
  assert.deepEqual(
    report.findings.map((finding) => finding.ruleId),
    ['region-off-with-updates', 'update-text-empty'],
  )
  assert.equal(new Set(report.findings.map((finding) => finding.location.pointer)).size, 1)
})

test('the duplicate walk is ordered by recorded time, not by the order in the file', async () => {
  const journey = {
    schemaVersion: '1',
    capture: { id: 'times', source: 'dom-mutation-record', recording: 'complete' },
    regions: [{ id: 'status', role: 'status', ariaLive: null, presentAtStart: true }],
    steps: [{
      name: 'only',
      updates: [
        { region: 'status', text: 'Saved', atMs: 900 },
        { region: 'status', text: 'Loading', atMs: 100 },
        { region: 'status', text: 'Saved', atMs: 1000 },
      ],
    }],
  }
  const directory = await mkdtemp(join(tmpdir(), 'lrea-order3-'))
  const journeyPath = join(directory, 'journey.json')
  const expectationsPath = join(directory, 'expectations.json')
  await writeFile(journeyPath, JSON.stringify(journey))
  await writeFile(expectationsPath, JSON.stringify({ ...EXPECTATIONS, regions: { status: { politeness: 'polite' } }, steps: [] }))
  const report = await auditJourney({ journey: journeyPath, expectations: expectationsPath, now: NOW })
  // 900 and 1000 are adjacent once ordered by time, 100ms apart; the file
  // listed "Loading" between them.
  assert.equal(report.summary.duplicateUpdates, 1)
  assert.match(report.findings[0].message, /100ms apart/u)
})
