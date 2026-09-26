/**
 * The guards a line-indexed mutation sweep found undefended outside the reader.
 *
 * Each case names the mutation it exists to fail on, because a test whose
 * purpose is not written down is a test the next person deletes. Every one was
 * proved non-equivalent first: a differential corpus of 2522 documents shows the
 * mutated tool emitting a different exit code or a different report, so none of
 * these is an equivalent mutant being tested for the sake of a score.
 */

import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  EVIDENCE_MISSING_RULES,
  RULE_IDS,
  RULE_SEVERITY,
  byCodeUnit,
  describeValue,
  num,
  parseInstant,
  sanitize,
} from '../src/index.mjs'
import {
  auditMutated,
  cleanExpectations,
  cleanJourney,
  findingsFor,
  regionNamed,
  ruleIds,
  runCli,
  runCliRaw,
  stepNamed,
} from './helpers.mjs'

test('a region inserted at a step the recording does not hold is a gap', async () => {
  // src/checks.mjs `if (region.insertedAtStep === null) continue` and the
  // `step-not-recorded` push under it. The suite reached that rule only through
  // the policy loop, so deleting either of these left it green while a region
  // pointing at a step nobody recorded stopped being reported.
  const report = await auditMutated((journey) => {
    regionNamed(journey, 'form-errors').insertedAtStep = 'a-step-that-never-ran'
  })
  assert.equal(report.status, 'incomplete')
  const finding = findingsFor(report, 'step-not-recorded')[0]
  assert.ok(finding !== undefined, ruleIds(report).join(', '))
  assert.match(finding.message, /inserted at step a-step-that-never-ran/u)
  assert.equal(finding.location.pointer, '/regions/form-errors')

  // And the other side of that guard: `null` means the element was never added
  // during the journey, which is not a step nobody recorded.
  const never = await auditMutated((journey) => {
    const region = regionNamed(journey, 'form-errors')
    region.presentAtStart = false
    region.insertedAtStep = null
  })
  assert.deepEqual(ruleIds(never), [])
})

test('the reasons a recording-incomplete finding lists are ordered by code unit', async () => {
  // src/checks.mjs `[...new Set(reasons)].sort(byCodeUnit).join('; ')`. The
  // insertion order is subtree-then-declaration and the code-unit order is the
  // reverse, so these two reasons together are what makes the sort observable.
  const report = await auditMutated((journey) => {
    journey.capture.recording = 'partial'
    journey.unreadableRegions = [{ hostId: 'cart-widget', reason: 'shadow-root' }]
  })
  const finding = findingsFor(report, 'recording-incomplete')[0]
  assert.equal(
    finding.evidence,
    'the recording declares "recording": "partial"; the subtree under cart-widget was not observed',
  )
})

test('an input path that is not a regular file is unreadable, not opened anyway', async () => {
  // src/index.mjs `if (!info.isFile())`. Without it a directory reached
  // `readFile`, which failed with a different code, so the report named the
  // wrong reason for the same refusal.
  const directory = await mkdtemp(join(tmpdir(), 'lrea-dir-'))
  const expectations = join(directory, 'expectations.json')
  await writeFile(expectations, JSON.stringify(await cleanExpectations()))
  const result = await runCliRaw(['--journey', directory, '--expectations', expectations, '--now', '2026-09-18', '--json'])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ruleIds(report), ['journey-unreadable'])
  assert.match(report.findings[0].message, /not a regular file/u)
})

test('parseInstant asks about a string, before it asks about a date', async (t) => {
  // src/policy.mjs `if (!isRenderableString(value, 40))`. `RegExp.exec` coerces
  // its argument, so without this guard a value that cannot be converted to a
  // primitive at all -- which is what `{"recordedAt": {"toString": {}}}` parses
  // into -- threw out of the check instead of being reported as an age nobody
  // could establish. The crash is before the sanitiser, not after it.
  await t.test('a value that will not convert to a primitive', () => {
    assert.deepEqual(parseInstant({ toString: {} }), { ok: false, ms: null })
  })

  await t.test('and the run says the age was not established rather than failing', async () => {
    const report = await auditMutated((journey) => { journey.capture.recordedAt = { toString: {} } })
    assert.equal(report.status, 'incomplete')
    assert.ok(ruleIds(report).includes('journey-age-unknown'))
  })

  await t.test('an array whose text looks like a date is not a date', () => {
    // `String(['2026-09-12'])` is '2026-09-12', so coercion would accept it.
    assert.deepEqual(parseInstant(['2026-09-12']), { ok: false, ms: null })
  })
})

test('parseInstant refuses a time of day the clock does not have', async (t) => {
  // src/policy.mjs `if (hour > 23 || minute > 59 || second > 59)`. The
  // round-trip check below it catches an hour, because 24:00 lands on the next
  // day -- but a minute of 60 rolls forward one hour and leaves the DATE alone,
  // so it round-tripped clean and the run silently used an instant an hour
  // later than the document said. That mutation turned exit 2 into exit 0.
  for (const value of ['2026-09-12T00:60:00Z', '2026-09-12T00:00:60Z', '2026-09-12T24:00:00Z']) {
    await t.test(value, () => {
      assert.deepEqual(parseInstant(value), { ok: false, ms: null })
    })
  }
  await t.test('the last instant of a day is still a date', () => {
    assert.equal(parseInstant('2026-09-12T23:59:59Z').ok, true)
  })
})

/** [what the policy is given, the message the ConfigError must carry]. */
const POLICY_REFUSALS = [
  ['a regions key that is not a usable id', (p) => { p.regions['\u0001\u200e'] = { politeness: 'polite' } },
    'A key in "regions" is not a usable region id.'],
  ['a region expectation that is not an object', (p) => { p.regions['cart-status'] = 'polite' },
    '"regions.cart-status" must be a JSON object.'],
  ['a step that is not an object', (p) => { p.steps.push(7) }, 'A step in "steps" is not a JSON object.'],
  ['a step with no usable name', (p) => { p.steps.push({ name: 1, expect: [] }) }, 'A step has no usable "name".'],
  ['a step whose name renders as nothing', (p) => { p.steps.push({ name: '\u0001\u200e', expect: [] }) },
    'A step has no usable "name".'],
  ['an expect that is not an array', (p) => { p.steps[0].expect = 'x' },
    '"steps.02-submit-empty.expect" must be an array.'],
  ['an expectation that is not an object', (p) => { p.steps[0].expect.push(7) },
    'An expectation in step 02-submit-empty is not a JSON object.'],
  ['an expectation with no usable region', (p) => { p.steps[0].expect.push({ region: 1 }) },
    'An expectation in step 02-submit-empty has no usable "region".'],
  ['an expectation whose text is not a string', (p) => { p.steps[0].expect.push({ region: 'cart-status', text: 7 }) },
    'An expectation in step 02-submit-empty has a "text" that is not a string.'],
  ['limits that are not an object', (p) => { p.limits = [] }, '"limits" must be a JSON object.'],
  ['limits that are a number', (p) => { p.limits = 0 }, '"limits" must be a JSON object.'],
]

test('every guard in validatePolicy refuses with its own message, and stdout stays empty', async (t) => {
  for (const [label, mutate, message] of POLICY_REFUSALS) {
    await t.test(label, async () => {
      const expectations = await cleanExpectations()
      mutate(expectations)
      const result = await runCli(await cleanJourney(), expectations)
      assert.equal(result.code, 2)
      assert.equal(result.stdout, '', 'a configuration error means the run never had a subject')
      assert.ok(result.stderr.includes(message), result.stderr)
    })
  }
})

test('the key lists a configuration error prints are ordered by code unit', async (t) => {
  // src/policy.mjs six `.sort()` call sites, each building a list a person
  // reads. None was pinned. Every pair below is chosen so the insertion order
  // and the code-unit order differ: `zeta` is written first and `Alpha` sorts
  // first, because `A` (0x41) precedes `z` (0x7A).
  const cases = [
    ['unknown expectation keys', (p) => { p.zeta = 1; p.Alpha = 2 },
      /^Unknown expectation key\(s\): Alpha, zeta\. /u],
    ['the known-key list beside them', (p) => { p.zeta = 1 },
      /Known keys: duplicateWindowMs, limits, maxRecordingAgeDays, maxUpdatesPerStep, regions, schemaVersion, steps\./u],
    ['unknown region-expectation keys', (p) => { p.regions['cart-status'].zeta = 1; p.regions['cart-status'].Alpha = 2 },
      /has unknown key\(s\): Alpha, zeta\. Known key: politeness\./u],
    ['unknown step keys', (p) => { p.steps[0].zeta = 1; p.steps[0].Alpha = 2 },
      /A step has unknown key\(s\): Alpha, zeta\. Known keys: name, exhaustive, expect\./u],
    ['unknown expectation-entry keys', (p) => { p.steps[0].expect[0].zeta = 1; p.steps[0].expect[0].Alpha = 2 },
      /has unknown key\(s\): Alpha, zeta\. Known keys: region, text\./u],
    ['unknown limit names', (p) => { p.limits = { zeta: 1, Alpha: 2 } },
      /^Unknown limit\(s\): Alpha, zeta\. Known limits: maxJourneyBytes, maxRegions, maxSteps\./u],
  ]
  for (const [label, mutate, pattern] of cases) {
    await t.test(label, async () => {
      const expectations = await cleanExpectations()
      mutate(expectations)
      const result = await runCli(await cleanJourney(), expectations)
      assert.equal(result.code, 2)
      assert.match(result.stderr, pattern)
    })
  }
})

test('the rule catalog is ordered by code unit, whatever order the table is written in', () => {
  // src/rules.mjs `Object.keys(RULE_SEVERITY).sort(byCodeUnit)` and the same on
  // the evidence-missing list. The severity table here is NOT written in sorted
  // order, so dropping that sort really does change `RULE_IDS` -- it just never
  // reaches a report, which is why the sweep found it undefended.
  assert.deepEqual([...RULE_IDS], [...RULE_IDS].sort(byCodeUnit))
  assert.deepEqual([...EVIDENCE_MISSING_RULES], [...EVIDENCE_MISSING_RULES].sort(byCodeUnit))
  assert.deepEqual([...RULE_IDS].sort(byCodeUnit), Object.keys(RULE_SEVERITY).sort(byCodeUnit))
  assert.notDeepEqual(
    Object.keys(RULE_SEVERITY),
    [...RULE_IDS],
    'if the table happened to be written in order this test could not fail',
  )
})

test('describeValue names a shape it will not reproduce', async (t) => {
  // src/rules.mjs. The array branch was the one nothing defended: without it
  // `String([])` is the empty string, so an array arriving where a string was
  // expected rendered as nothing at all and the report said so about a value
  // that was plainly there.
  await t.test('an array is described, never stringified', () => {
    assert.equal(describeValue([]), '[array]')
    assert.equal(describeValue(['a', 'b']), '[array]')
    assert.equal(sanitize([]), '[array]')
  })

  await t.test('and the report says so rather than showing nothing', async () => {
    const report = await auditMutated((journey) => { journey.capture.source = [] })
    assert.deepEqual(ruleIds(report), ['capture-source-unsupported'])
    assert.match(report.findings[0].message, /declares its source as \[array\]/u)
  })

  await t.test('the other shapes it names', () => {
    assert.equal(describeValue({ toString: {} }), '[object]')
    // A function converts fine, so the `[function]` branch is only reached when
    // conversion itself fails -- which is the point of the branch.
    assert.equal(describeValue(Object.assign(() => {}, { toString: {}, valueOf: {} })), '[function]')
    assert.equal(describeValue(null), 'null')
    assert.equal(describeValue(undefined), 'undefined')
    assert.equal(describeValue('plain'), 'plain')
  })
})

test('num describes a value it cannot print as a number', () => {
  // src/rules.mjs `if (!Number.isFinite(value)) return describeValue(value)`.
  // For NaN and the infinities the arithmetic below happens to print the same
  // text, so no document in the corpus tells the two apart -- but `num` is
  // exported, and for anything that is not a number at all the guard is the
  // difference between the value and the word NaN.
  assert.equal(num(0), '0')
  assert.equal(num(-0), '0')
  assert.equal(num(1.23456), '1.2346')
  assert.equal(num(Number.NaN), 'NaN')
  assert.equal(num(Number.POSITIVE_INFINITY), 'Infinity')
  assert.equal(num('seven'), 'seven')
  assert.equal(num([]), '[array]')
  assert.equal(num(null), 'null')
})

test('an update whose step and time disagree is still walked in time order', async () => {
  // src/checks.mjs `entries.sort((a, b) => a.update.atMs - b.update.atMs || ...)`.
  // The test that claimed to pin this walked a fixture whose file order and time
  // order coincided once the repeat comparison became a predicate over pairs, so
  // the sort could be dropped with the suite green. Here they genuinely differ:
  // listed 5000, 1000, 1200, the only pair inside a 1000ms window is 1000/1200,
  // and walking the file order instead counts three.
  const report = await auditMutated(
    (journey) => {
      stepNamed(journey, '02-submit-empty').updates = [
        { region: 'form-errors', text: 'There is a problem', atMs: 5000 },
        { region: 'form-errors', text: 'There is a problem', atMs: 1000 },
        { region: 'form-errors', text: 'There is a problem', atMs: 1200 },
      ]
    },
    { expectations: (expectations) => { expectations.steps[0].exhaustive = false } },
  )
  assert.equal(report.summary.duplicateUpdates, 1)
  const repeats = findingsFor(report, 'duplicate-update')
  assert.equal(repeats.length, 1)
  assert.match(repeats[0].message, /same text twice 200ms apart/u)
})
