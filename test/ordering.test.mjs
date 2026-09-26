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

import { auditJourney, byCodeUnit, compareFindings } from '../src/index.mjs'
import { NOW, auditMutated, ruleIds, stepNamed } from './helpers.mjs'

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
  // Each region resolves to `off` and is then written to where the expectations
  // name an update to it, so each produces exactly one finding, at a pointer
  // built from its own id. The expectation matches the recorded update (no
  // `text`, so any text matches), which is what keeps the count at one.
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
  await writeFile(expectationsPath, JSON.stringify({
    ...EXPECTATIONS,
    regions: {},
    steps: [{ name: 'only', expect: ids.map((id) => ({ region: id })) }],
  }))
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
  await writeFile(expectationsPath, JSON.stringify({
    ...EXPECTATIONS,
    regions: { quiet: { politeness: 'off' } },
    steps: [{ name: 'only', expect: [{ region: 'quiet' }] }],
  }))
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
        { region: 'status', text: 'Saved', atMs: 5000 },
        { region: 'status', text: 'Loading', atMs: 100 },
        { region: 'status', text: 'Saved', atMs: 900 },
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
  // Once ordered by time the "Saved" writes are 900, 1000, 5000: one pair
  // inside the 1000ms window, 100ms apart. The file lists 5000 FIRST, which is
  // what makes the sort observable -- walking the file order instead measures
  // every later write against 5000 and counts three repeats, at -4100ms,
  // -4000ms and 100ms. Replacing the comparator with `() => 0` produced exactly
  // that, and the version of this test it replaces stayed green through it: the
  // file order and the time order coincided for the "Saved" pair once the
  // repeat comparison became a predicate over pairs, so an interleaved
  // "Loading" no longer told the two apart.
  assert.equal(report.summary.duplicateUpdates, 1)
  assert.equal(report.findings.length, 1)
  assert.match(report.findings[0].message, /same text twice 100ms apart/u)
})

test('each sort key decides on its own, and none of them is decoration', async (t) => {
  // A mutation sweep found three of the four keys undefended: every finding in
  // a run comes from one file, and the message key happened to order the
  // fixtures the same way the pointer key did, so dropping either changed
  // nothing observable. The keys are asserted directly, one at a time.
  const finding = (file, pointer, ruleId, message) => ({
    ruleId,
    severity: 'error',
    message,
    location: { file, pointer },
  })

  await t.test('file decides first', () => {
    const a = finding('Zebra.json', '/z', 'z-rule', 'z')
    const b = finding('apple.json', '/a', 'a-rule', 'a')
    assert.equal(compareFindings(a, b), -1, 'Z before a by code unit, whatever the other keys say')
    assert.equal(compareFindings(b, a), 1)
  })

  await t.test('pointer decides when the file is the same', () => {
    const a = finding('x.json', '/a-b', 'z-rule', 'zzz')
    const b = finding('x.json', '/a_b', 'a-rule', 'aaa')
    assert.equal(compareFindings(a, b), -1, '- before _ by code unit, whatever the other keys say')
    assert.equal(compareFindings(b, a), 1)
  })

  await t.test('rule id decides when the file and pointer are the same', () => {
    const a = finding('x.json', '/same', 'MAX_DUPLICATE_URLS', 'zzz')
    const b = finding('x.json', '/same', 'MAX_DUPLICATE_URL_ENTRIES', 'aaa')
    assert.equal(compareFindings(a, b), -1, 'S before _ by code unit')
    assert.equal(compareFindings(b, a), 1)
  })

  await t.test('message decides when everything else is the same', () => {
    const a = finding('x.json', '/same', 'same-rule', 'Zebra')
    const b = finding('x.json', '/same', 'same-rule', 'apple')
    assert.equal(compareFindings(a, b), -1)
    assert.equal(compareFindings(b, a), 1)
    assert.equal(compareFindings(a, { ...a }), 0)
  })

  await t.test('a run really can emit findings the message key alone orders', async () => {
    // Repeats of one text in one step land on one pointer with one rule id, so
    // the message is the only key left to decide their order.
    //
    // The gaps are chosen so that three orders are all different: the order
    // they are generated in (20, 120, 100), their numeric order (20, 100, 120)
    // and their code-unit order as text ('100' < '120' < '20'). Only the last
    // one passes here. The body this replaces pushed two updates 100ms apart
    // and asserted ['100', '100'] -- two findings whose messages were
    // BYTE-IDENTICAL, so the assertion held whatever the message key did, or
    // did not do.
    const report = await auditMutated((journey) => {
      const step = stepNamed(journey, '03-fix-and-submit')
      step.updates.push({ region: 'cart-status', text: 'Order placed', atMs: 5320 })
      step.updates.push({ region: 'cart-status', text: 'Order placed', atMs: 5420 })
    })
    const repeats = report.findings.filter((entry) => entry.ruleId === 'duplicate-update')
    assert.equal(repeats.length, 3)
    assert.equal(new Set(repeats.map((entry) => entry.location.pointer)).size, 1)
    assert.equal(new Set(repeats.map((entry) => entry.message)).size, 3, 'three distinct messages')
    assert.deepEqual(
      repeats.map((entry) => /same text twice (\d+)ms apart/u.exec(entry.message)[1]),
      ['100', '120', '20'],
    )
  })
})

test('when the enumeration is truncated, WHICH repeats are named is ordered too', async (t) => {
  // src/checks.mjs `[...byRegion.keys()].sort(byCodeUnit)` and
  // `[...byText.keys()].sort(byCodeUnit)`. Below the cap these two decide only
  // the order findings are pushed in, which `sortFindings` then re-establishes
  // -- so no document with fewer than MAX_DUPLICATE_FINDINGS repeats can tell
  // the sorted walk from an unsorted one, and a 2522-document differential
  // corpus did not. Past the cap they decide WHICH repeats are named at all,
  // and that is delivered output. Both fixtures below hold 1056 repeats in two
  // groups of 528, so the first group named takes 528 of the 1000 and the
  // second takes 472; the groups are built so that the walk meets them in the
  // opposite order to the code-unit one.
  const run = async (journey, expectations) => {
    const directory = await mkdtemp(join(tmpdir(), 'lrea-cap-'))
    const journeyPath = join(directory, 'journey.json')
    const expectationsPath = join(directory, 'expectations.json')
    await writeFile(journeyPath, JSON.stringify(journey))
    await writeFile(expectationsPath, JSON.stringify(expectations))
    return auditJourney({ journey: journeyPath, expectations: expectationsPath, now: NOW })
  }
  const region = (id) => ({ id, role: 'status', ariaLive: null, presentAtStart: true })
  const writes = (id, text, from) => Array.from({ length: 33 }, (_, i) => ({ region: id, text, atMs: from + i }))
  const named = (report, pointer) => report.findings.filter(
    (finding) => finding.ruleId === 'duplicate-update' && finding.location.pointer === pointer,
  ).length

  await t.test('two regions, the later-written one sorting first', async () => {
    const report = await run({
      schemaVersion: '1',
      capture: { id: 'cap', source: 'dom-mutation-record', recording: 'complete' },
      regions: [region('z-region'), region('a-region')],
      steps: [{ name: 'only', updates: [...writes('z-region', 'Z', 1000), ...writes('a-region', 'A', 9000)] }],
    }, {
      ...EXPECTATIONS,
      maxUpdatesPerStep: 100,
      regions: { 'z-region': { politeness: 'polite' }, 'a-region': { politeness: 'polite' } },
      steps: [],
    })
    assert.equal(report.summary.duplicateUpdates, 1056, 'the count is exact whatever the listing does')
    assert.equal(named(report, '/steps/only/updates/a-region'), 528, 'a-region is walked first, by code unit')
    assert.equal(named(report, '/steps/only/updates/z-region'), 472)
    assert.ok(ruleIds(report).includes('duplicate-enumeration-truncated'))
    assert.equal(report.status, 'incomplete')
  })

  await t.test('two texts in one region, the later-written one sorting first', async () => {
    // The two texts are spaced differently -- "A" one millisecond apart and "Z"
    // ten -- so the gap a finding reports says which group it came from without
    // the message having to name the text. A group walked first is enumerated
    // whole and holds 32 pairs one millisecond apart; a group truncated at 472
    // of its 528 stops inside `current` 31 and holds only 30 of them.
    const spaced = (text, from, step) => Array.from(
      { length: 33 },
      (_, i) => ({ region: 'one-region', text, atMs: from + (i * step) }),
    )
    const report = await run({
      schemaVersion: '1',
      capture: { id: 'cap', source: 'dom-mutation-record', recording: 'complete' },
      regions: [region('one-region')],
      steps: [{ name: 'only', updates: [...spaced('Z', 1000, 10), ...spaced('A', 9000, 1)] }],
    }, {
      ...EXPECTATIONS,
      maxUpdatesPerStep: 100,
      regions: { 'one-region': { politeness: 'polite' } },
      steps: [],
    })
    assert.equal(report.summary.duplicateUpdates, 1056)
    const gaps = report.findings
      .filter((finding) => finding.ruleId === 'duplicate-update')
      .map((finding) => /same text twice (\d+)ms apart/u.exec(finding.message)[1])
    assert.equal(gaps.length, 1000)
    assert.equal(gaps.filter((gap) => gap === '1').length, 32, '"A" is walked first and enumerated whole')
    assert.equal(gaps.filter((gap) => gap === '320').length, 0, '"Z" is the group that ran out')
  })
})
