/**
 * Every guard in the recording reader, one case each.
 *
 * A line-indexed mutation sweep over `src/` and `bin/` -- every `if` condition
 * replaced with `false`, every severity flipped, every evidence-missing entry
 * deleted, every ordering call site given a collator -- found nineteen guards in
 * `readRegion`, `readUpdate` and `readJourney` that could be deleted with the
 * suite still green, and a differential corpus of 2522 documents proved every
 * one of them changes what the tool emits. None was an equivalent mutant.
 *
 * Each guard answers with its own `reason`, and the reason is what the report
 * prints as the gap, so the reason is what is asserted. Neutering a guard makes
 * the reader either accept the record or refuse it for a different reason, and
 * either one fails the case below.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { readJourney, readRegion, readUpdate } from '../src/index.mjs'
import { cleanExpectations, cleanJourney, ruleIds, runCli, stepNamed } from './helpers.mjs'

const UNRENDERABLE = '\u0001\u200e'

function region(overrides = {}) {
  return { id: 'r', role: null, ariaLive: null, presentAtStart: true, ...overrides }
}

/** [reader, what it is given, the reason it must give back]. */
const REFUSALS = [
  // readRegion
  [readRegion, 7, 'the region record is not a JSON object'],
  [readRegion, null, 'the region record is not a JSON object'],
  [readRegion, [], 'the region record is not a JSON object'],
  [readRegion, region({ id: 1 }), 'the region has no usable "id"'],
  [readRegion, region({ id: UNRENDERABLE }), 'the region has no usable "id"'],
  [readRegion, { id: 'r', ariaLive: null, presentAtStart: true },
    '"role" is required; use null when the attribute was absent'],
  [readRegion, { id: 'r', role: null, presentAtStart: true },
    '"ariaLive" is required; use null when the attribute was absent'],
  [readRegion, { id: 'r', role: null, ariaLive: null },
    '"presentAtStart" is required; use null when the attribute was absent'],
  [readRegion, region({ role: 7 }), '"role" must be null or a string'],
  [readRegion, region({ ariaLive: 7 }), '"ariaLive" must be null or a string'],
  [readRegion, region({ presentAtStart: 'yes' }), '"presentAtStart" must be true or false'],
  [readRegion, region({ insertedAtStep: 7 }), '"insertedAtStep" must be null or the name of a step'],

  // readUpdate
  [readUpdate, 7, 'the update record is not a JSON object'],
  [readUpdate, { region: 1 }, 'the update has no usable "region"'],
  [readUpdate, { region: UNRENDERABLE }, 'the update has no usable "region"'],
  [readUpdate, { region: 'r', text: 7 }, '"text" must be null or a string'],
  [readUpdate, { region: 'r', atMs: -1 }, '"atMs" must be a whole number of milliseconds, at least 0'],
  [readUpdate, { region: 'r', atMs: 1.5 }, '"atMs" must be a whole number of milliseconds, at least 0'],
  [readUpdate, { region: 'r', atMs: '5' }, '"atMs" must be a whole number of milliseconds, at least 0'],
]

test('every guard in the record readers refuses with its own reason', async (t) => {
  for (const [reader, raw, reason] of REFUSALS) {
    await t.test(`${reader.name}: ${reason}`, () => {
      assert.deepEqual(reader(raw), { ok: false, reason })
    })
  }
})

test('the readers accept the shapes the documented schema allows', async (t) => {
  // The guard for the guards: a reader that refused everything would pass every
  // case above while making the tool useless.
  await t.test('readRegion', () => {
    assert.equal(readRegion(region()).ok, true)
    assert.equal(readRegion(region({ role: 'status', ariaLive: 'polite' })).ok, true)
    assert.equal(readRegion(region({ presentAtStart: false, insertedAtStep: 's' })).ok, true)
    assert.equal(readRegion(region({ insertedAtStep: null })).ok, true)
  })
  await t.test('readUpdate', () => {
    assert.equal(readUpdate({ region: 'r' }).ok, true)
    assert.equal(readUpdate({ region: 'r', text: null, atMs: 0 }).ok, true)
    assert.equal(readUpdate({ region: 'r', text: 'x', atMs: 1200 }).ok, true)
  })
})

function journeyWith(mutate) {
  const document = {
    schemaVersion: '1',
    capture: { id: 'c', source: 'dom-mutation-record', recording: 'complete' },
    regions: [],
    steps: [],
  }
  mutate(document)
  return document
}

/** [what the top-level reader is given, the reason it must give back]. */
const DOCUMENT_REFUSALS = [
  ['not an object', () => 7, 'the recording is not a JSON object'],
  ['null', () => null, 'the recording is not a JSON object'],
  ['an array', () => [], 'the recording is not a JSON object'],
  ['a wrong schemaVersion', () => journeyWith((d) => { d.schemaVersion = '2' }),
    'the recording must declare "schemaVersion": "1"'],
  ['no capture object', () => journeyWith((d) => { d.capture = 7 }),
    'the recording must record a "capture" object'],
  ['an unusable capture id', () => journeyWith((d) => { d.capture.id = 1 }),
    '"capture.id" is missing or unusable'],
  ['an unknown recording state', () => journeyWith((d) => { d.capture.recording = 'some' }),
    '"capture.recording" must be one of: complete, partial'],
  ['regions that are not an array', () => journeyWith((d) => { d.regions = {} }), '"regions" must be an array'],
  ['steps that are not an array', () => journeyWith((d) => { d.steps = {} }), '"steps" must be an array'],
  ['unreadableRegions that are not an array', () => journeyWith((d) => { d.unreadableRegions = 'x' }),
    '"unreadableRegions" must be an array of at most 200 entries'],
  ['too many unreadableRegions', () => journeyWith((d) => {
    d.unreadableRegions = Array.from({ length: 201 }, (_, i) => ({ hostId: `h${i}`, reason: 'shadow-root' }))
  }), '"unreadableRegions" must be an array of at most 200 entries'],
  ['an unreadable region that is not an object', () => journeyWith((d) => { d.unreadableRegions = [7] }),
    'an unreadable region is not a JSON object'],
  ['an unreadable region with no host', () => journeyWith((d) => {
    d.unreadableRegions = [{ hostId: 1, reason: 'shadow-root' }]
  }), 'an unreadable region has no usable "hostId"'],
  ['an unreadable region with an unknown reason', () => journeyWith((d) => {
    d.unreadableRegions = [{ hostId: 'h', reason: 'because' }]
  }), 'an unreadable region must give a "reason" from: shadow-root, closed-shadow-root, cross-origin-iframe, '
    + 'not-observable, access-denied'],
  ['a step that is not an object', () => journeyWith((d) => { d.steps = [7] }), 'step 0 is not a JSON object'],
  ['a step with no usable name', () => journeyWith((d) => { d.steps = [{ name: 1, updates: [] }] }),
    'step 0 has no usable "name"'],
  ['a step whose updates are not an array', () => journeyWith((d) => { d.steps = [{ name: 'only', updates: 7 }] }),
    'step "only" must record an "updates" array'],
]

test('every guard in readJourney refuses with its own reason', async (t) => {
  for (const [label, build, reason] of DOCUMENT_REFUSALS) {
    await t.test(label, () => {
      assert.deepEqual(readJourney(build()), { ok: false, reason })
    })
  }
})

test('a document readJourney refuses is exit 2 with an incomplete report, never a pass', async (t) => {
  // The reasons above are return values; this is the behaviour they produce.
  for (const [label, build, reason] of DOCUMENT_REFUSALS) {
    await t.test(label, async () => {
      const result = await runCli(build(), await cleanExpectations())
      assert.equal(result.code, 2)
      const report = JSON.parse(result.stdout)
      assert.equal(report.status, 'incomplete')
      assert.deepEqual(ruleIds(report), ['journey-invalid'])
      assert.ok(report.findings[0].message.includes(reason), report.findings[0].message)
      assert.equal(report.summary.checked, 0)
    })
  }
})

test('a record the readers refuse is reported as a gap, not skipped', async (t) => {
  const cases = [
    ['a region record', (journey) => { journey.regions.push({ id: 'x', role: 7, ariaLive: null, presentAtStart: true }) },
      'region-invalid', '"role" must be null or a string'],
    ['an update record', (journey) => {
      stepNamed(journey, '02-submit-empty').updates.push({ region: 'form-errors', atMs: -1 })
    }, 'update-invalid', '"atMs" must be a whole number of milliseconds, at least 0'],
  ]
  for (const [label, mutate, ruleId, reason] of cases) {
    await t.test(label, async () => {
      const journey = await cleanJourney()
      mutate(journey)
      const result = await runCli(journey, await cleanExpectations())
      assert.equal(result.code, 2)
      const report = JSON.parse(result.stdout)
      assert.equal(report.status, 'incomplete')
      const finding = report.findings.find((entry) => entry.ruleId === ruleId)
      assert.ok(finding !== undefined, ruleIds(report).join(', '))
      assert.ok(finding.message.includes(reason), finding.message)
    })
  }
})
