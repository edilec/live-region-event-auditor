/**
 * Unknown is never a pass.
 *
 * Every rule in `EVIDENCE_MISSING_RULES` is driven here from a real recording,
 * through the real entry point, and asserted to produce `incomplete` -- because
 * membership of that list is the only thing standing between a gap in the
 * evidence and a green run.
 *
 * For the `warning` rules the test goes further and asserts that the run
 * contains NO error-severity finding at all. That is what makes the pin bite:
 * with the rule removed from the list, severity alone would make the report
 * `pass` and the process exit 0. For the `error` rules the pin is `incomplete`
 * rather than `fail`, which is the difference between exit 2 and exit 1.
 */

import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { EVIDENCE_MISSING_RULES, RULE_SEVERITY, auditJourney, severityFor, statusFor } from '../src/index.mjs'
import {
  NOW,
  auditMutated,
  cleanExpectations,
  cleanJourney,
  regionNamed,
  ruleIds,
  runCli,
  runCliRaw,
  stepNamed,
} from './helpers.mjs'

const saveUpdate = (journey) => stepNamed(journey, '03-fix-and-submit')
  .updates.find((update) => update.region === 'save-progress')

/** ruleId -> a mutation of the clean fixture that produces it. */
const REACHED_BY_MUTATION = {
  'capture-source-unsupported': (journey) => {
    journey.capture.source = 'screen-recording'
  },
  'duplicate-region-id': (journey) => {
    journey.regions.push({ id: 'cart-status', role: 'log', ariaLive: null, presentAtStart: true })
  },
  'journey-age-unknown': (journey) => {
    delete journey.capture.recordedAt
  },
  'journey-invalid': (journey) => {
    journey.schemaVersion = '99'
  },
  'politeness-unknown': (journey) => {
    const region = regionNamed(journey, 'form-errors')
    region.role = null
    region.ariaLive = null
  },
  'politeness-value-invalid': (journey) => {
    regionNamed(journey, 'form-errors').ariaLive = 'urgent'
  },
  'recording-incomplete': (journey) => {
    journey.capture.recording = 'partial'
  },
  'region-insertion-not-captured': (journey) => {
    delete regionNamed(journey, 'form-errors').insertedAtStep
  },
  'region-invalid': (journey) => {
    journey.regions.push({ id: 'ghost', role: 'status' })
  },
  'region-unknown': (journey) => {
    stepNamed(journey, '03-fix-and-submit').updates.push({
      region: 'toast-host',
      text: 'Undo',
      atMs: 5900,
    })
  },
  'step-invalid': (journey) => {
    journey.steps.push({ name: '01-open-checkout', updates: [] })
  },
  'subtree-not-captured': (journey) => {
    journey.unreadableRegions = [{ hostId: 'cart-widget', reason: 'shadow-root' }]
  },
  'update-invalid': (journey) => {
    stepNamed(journey, '03-fix-and-submit').updates.push({ region: 'cart-status', atMs: -5 })
  },
  'update-text-not-captured': (journey) => {
    delete saveUpdate(journey).text
  },
  'update-time-not-captured': (journey) => {
    delete saveUpdate(journey).atMs
  },
}

/** ruleId -> an expectations change that produces it. */
const REACHED_BY_EXPECTATIONS = {
  // Forty-six updates carrying one text inside the window hold 1035 repeats,
  // past the 1000 this run names one by one. It reaches the rule through the
  // expectations because the per-step limit has to be raised to get there.
  'duplicate-enumeration-truncated': (expectations) => {
    expectations.maxUpdatesPerStep = 60
  },
  'expected-region-not-captured': (expectations) => {
    expectations.regions['toast-host'] = { politeness: 'assertive' }
  },
  'journey-too-large': (expectations) => {
    expectations.limits = { maxJourneyBytes: 64 }
  },
  'region-limit-exceeded': (expectations) => {
    expectations.limits = { maxRegions: 2 }
  },
  'step-limit-exceeded': (expectations) => {
    expectations.limits = { maxSteps: 2 }
  },
  'step-not-recorded': (expectations) => {
    expectations.steps.push({ name: '99-never-happened', expect: [] })
  },
  'step-update-limit-exceeded': (expectations) => {
    expectations.maxUpdatesPerStep = 1
  },
}

/**
 * A recording mutation some expectations-reached rules need as well.
 *
 * Raising `maxUpdatesPerStep` alone reaches nothing; the repeats have to be in
 * the document too.
 */
const EXTRA_MUTATION = {
  'duplicate-enumeration-truncated': (journey) => {
    const step = stepNamed(journey, '03-fix-and-submit')
    for (let index = 0; index < 45; index += 1) {
      step.updates.push({ region: 'cart-status', text: 'Order placed', atMs: 5300 + index + 1 })
    }
  },
}

test('every evidence-missing rule really makes the run incomplete', async (t) => {
  for (const [ruleId, mutate] of Object.entries(REACHED_BY_MUTATION)) {
    await t.test(`${ruleId} (${severityFor(ruleId)})`, async () => {
      const report = await auditMutated(mutate)
      assert.ok(ruleIds(report).includes(ruleId), `expected ${ruleId}, got ${ruleIds(report).join(', ')}`)
      assert.equal(report.status, 'incomplete')
      if (severityFor(ruleId) === 'warning') {
        assert.ok(
          report.findings.every((finding) => finding.severity !== 'error'),
          'no error severity here, so listing this rule as evidence-missing is the only thing preventing a pass',
        )
      }
    })
  }

  for (const [ruleId, mutate] of Object.entries(REACHED_BY_EXPECTATIONS)) {
    await t.test(`${ruleId} (${severityFor(ruleId)})`, async () => {
      const report = await auditMutated(EXTRA_MUTATION[ruleId] ?? null, { expectations: mutate })
      assert.ok(ruleIds(report).includes(ruleId), `expected ${ruleId}, got ${ruleIds(report).join(', ')}`)
      assert.equal(report.status, 'incomplete')
      if (severityFor(ruleId) === 'warning') {
        assert.ok(report.findings.every((finding) => finding.severity !== 'error'))
      }
    })
  }

  await t.test('journey-stale (warning)', async () => {
    const report = await auditMutated(null, { now: NOW + 400 * 86400000 })
    assert.deepEqual(ruleIds(report), ['journey-stale'])
    assert.equal(report.status, 'incomplete')
    assert.ok(report.findings.every((finding) => finding.severity !== 'error'))
  })

  await t.test('update-unverifiable (warning)', async () => {
    // The expected confirmation is not in the recording AND the recording says
    // it does not hold everything. Absence stops being evidence.
    const report = await auditMutated((journey) => {
      journey.capture.recording = 'partial'
      const step = stepNamed(journey, '03-fix-and-submit')
      step.updates = step.updates.filter((update) => update.region !== 'cart-status')
    })
    assert.equal(report.status, 'incomplete')
    assert.ok(ruleIds(report).includes('update-unverifiable'))
    assert.ok(
      !ruleIds(report).includes('expected-update-missing'),
      'an update missing from a recording known to be partial is not an update that did not happen',
    )
    assert.ok(report.findings.every((finding) => finding.severity !== 'error'))
  })

  await t.test('no-updates-checked (error)', async () => {
    const report = await auditMutated(
      (journey) => { for (const step of journey.steps) step.updates = [] },
      { expectations: (expectations) => { expectations.steps = [] } },
    )
    assert.ok(ruleIds(report).includes('no-updates-checked'))
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.checked, 0)
  })

  await t.test('journey-unparsable (error)', async () => {
    const result = await runCli('{"schemaVersion": ', await cleanExpectations())
    assert.equal(result.code, 2)
    const report = JSON.parse(result.stdout)
    assert.deepEqual(ruleIds(report), ['journey-unparsable'])
    assert.equal(report.status, 'incomplete')
  })

  await t.test('journey-not-utf8 (error)', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lrea-bytes-'))
    const journeyPath = join(directory, 'journey.json')
    const expectationsPath = join(directory, 'expectations.json')
    await writeFile(journeyPath, Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]))
    await writeFile(expectationsPath, JSON.stringify(await cleanExpectations()))
    const report = await auditJourney({ journey: journeyPath, expectations: expectationsPath, now: NOW })
    assert.deepEqual(ruleIds(report), ['journey-not-utf8'])
    assert.equal(report.status, 'incomplete')
  })

  await t.test('journey-unreadable (error)', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lrea-missing-'))
    const expectationsPath = join(directory, 'expectations.json')
    await writeFile(expectationsPath, JSON.stringify(await cleanExpectations()))
    const result = await runCliRaw([
      '--journey', join(directory, 'nothing-here.json'),
      '--expectations', expectationsPath,
      '--now', '2026-09-18',
    ])
    assert.equal(result.code, 2)
    const report = JSON.parse(result.stdout)
    assert.deepEqual(ruleIds(report), ['journey-unreadable'])
    assert.equal(report.status, 'incomplete')
  })

  await t.test('the table above covers the whole list, in both directions', () => {
    const covered = new Set([
      ...Object.keys(REACHED_BY_MUTATION),
      ...Object.keys(REACHED_BY_EXPECTATIONS),
      'journey-stale',
      'update-unverifiable',
      'no-updates-checked',
      'journey-unparsable',
      'journey-not-utf8',
      'journey-unreadable',
    ])
    assert.deepEqual([...covered].sort(), [...EVIDENCE_MISSING_RULES].sort())
  })
})

test('a rule that is NOT evidence-missing fails the run instead of making it incomplete', async () => {
  const report = await auditMutated((journey) => {
    regionNamed(journey, 'form-errors').role = 'status'
  })
  assert.deepEqual(ruleIds(report), ['politeness-mismatch'])
  assert.equal(report.status, 'fail')
  assert.ok(!EVIDENCE_MISSING_RULES.includes('politeness-mismatch'))
})

test('missing evidence outranks a defect: half a journey is not a verdict on the journey', async () => {
  const report = await auditMutated((journey) => {
    regionNamed(journey, 'form-errors').role = 'status'
    journey.capture.recording = 'partial'
  })
  assert.ok(ruleIds(report).includes('politeness-mismatch'))
  assert.ok(ruleIds(report).includes('recording-incomplete'))
  assert.equal(report.status, 'incomplete', 'an error present does not downgrade a gap in the evidence')
})

test('exactly eleven evidence-missing rules are warnings, and the list is the only guard for those', () => {
  const warnings = EVIDENCE_MISSING_RULES.filter((ruleId) => RULE_SEVERITY[ruleId] === 'warning')
  assert.equal(warnings.length, 11)
  // The second clause, asserted rather than merely stated. For each of those
  // eleven the ONLY difference between an incomplete run and a green one is
  // membership of the list: the severity is held identical on both sides, so
  // nothing else can be what decides it. Removing a rule from the list makes
  // the left-hand call return what the right-hand call returns here.
  for (const ruleId of warnings) {
    assert.equal(statusFor([{ ruleId, severity: 'warning' }]), 'incomplete', ruleId)
    assert.equal(statusFor([{ ruleId: `${ruleId}-not-in-the-list`, severity: 'warning' }]), 'pass', ruleId)
  }
})

test('a pass on no evidence at all is not reachable', async () => {
  const report = await auditMutated(
    (journey) => { journey.steps = [] },
    { expectations: (expectations) => { expectations.steps = [] } },
  )
  assert.equal(report.summary.checked, 0)
  assert.equal(report.status, 'incomplete')
  assert.ok(ruleIds(report).includes('no-updates-checked'))
})
