/**
 * Severity decides the exit code, so it is pinned by the exit code.
 *
 * A hand-written expected-severity map in a test is a third declaration that
 * agrees with the other two, and a coordinated edit of all three passes. Here
 * every defect rule is driven from a real recording through the real CLI, and
 * the assertion is the process exit status: 1 for a journey that broke an
 * expectation, 2 for evidence that was not obtained. An exit code cannot be
 * edited into agreement.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { EVIDENCE_MISSING_RULES, RULE_IDS, RULE_SEVERITY, SEVERITIES, severityFor } from '../src/index.mjs'
import {
  auditMutated,
  cleanExpectations,
  cleanJourney,
  regionNamed,
  ruleIds,
  runCli,
  stepNamed,
} from './helpers.mjs'

/** Every rule that is a defect in the journey rather than a gap in the evidence. */
const DEFECTS = {
  'duplicate-update': (journey) => {
    stepNamed(journey, '03-fix-and-submit').updates.push({
      region: 'cart-status',
      text: 'Order placed',
      atMs: 5600,
    })
  },
  'expected-update-missing': (journey) => {
    const step = stepNamed(journey, '03-fix-and-submit')
    step.updates = step.updates.filter((update) => update.region !== 'cart-status')
  },
  'politeness-mismatch': (journey) => {
    regionNamed(journey, 'form-errors').role = 'status'
  },
  'region-created-with-content': (journey) => {
    const region = regionNamed(journey, 'form-errors')
    region.insertedAtStep = '02-submit-empty'
  },
  'region-off-with-updates': (journey) => {
    regionNamed(journey, 'save-progress').ariaLive = 'off'
  },
  'unexpected-update': (journey) => {
    stepNamed(journey, '02-submit-empty').updates.push({
      region: 'cart-status',
      text: 'Basket saved',
      atMs: 1400,
    })
  },
  'update-text-empty': (journey) => {
    stepNamed(journey, '03-fix-and-submit')
      .updates.find((update) => update.region === 'save-progress').text = '\u202e\u0085\u200e'
  },
}

test('every defect rule fails the run and exits 1', async (t) => {
  for (const [ruleId, mutate] of Object.entries(DEFECTS)) {
    await t.test(ruleId, async () => {
      const report = await auditMutated(mutate)
      assert.ok(ruleIds(report).includes(ruleId), `expected ${ruleId}, got ${ruleIds(report).join(', ')}`)
      assert.equal(report.status, 'fail')
      assert.equal(severityFor(ruleId), 'error')

      const journey = await cleanJourney()
      mutate(journey)
      const result = await runCli(journey, await cleanExpectations())
      assert.equal(result.code, 1, 'a defect in the journey is exit 1, not exit 0 and not exit 2')
      assert.equal(JSON.parse(result.stdout).status, 'fail')
    })
  }
})

test('region-off-with-updates needs the expectation to agree, or it is a mismatch instead', async () => {
  // Guard against the previous test passing for the wrong reason: with the
  // expectation still saying "polite", the mismatch would be what failed it.
  const report = await auditMutated(
    (journey) => { regionNamed(journey, 'save-progress').ariaLive = 'off' },
    { expectations: (expectations) => { expectations.regions['save-progress'].politeness = 'off' } },
  )
  assert.deepEqual(ruleIds(report), ['region-off-with-updates'])
  assert.equal(report.status, 'fail')
})

test('the defect table and the evidence-missing list together cover the whole catalog', () => {
  const covered = [...Object.keys(DEFECTS), ...EVIDENCE_MISSING_RULES].sort()
  assert.deepEqual(covered, [...RULE_IDS].sort())
  for (const ruleId of Object.keys(DEFECTS)) {
    assert.ok(!EVIDENCE_MISSING_RULES.includes(ruleId), `${ruleId} cannot be both`)
  }
})

test('an unknown rule id throws rather than defaulting to something harmless', () => {
  assert.throws(() => severityFor('no-such-rule'), /Unknown ruleId/u)
  assert.throws(() => severityFor(undefined), /Unknown ruleId/u)
})

test('every severity in the table is one of the three the contract allows', () => {
  for (const ruleId of RULE_IDS) {
    assert.ok(SEVERITIES.includes(RULE_SEVERITY[ruleId]), ruleId)
  }
  assert.equal(RULE_IDS.length, Object.keys(RULE_SEVERITY).length)
})

test('a clean run exits 0 and a run that obtained no evidence exits 2', async () => {
  const clean = await runCli(await cleanJourney(), await cleanExpectations())
  assert.equal(clean.code, 0)
  assert.equal(JSON.parse(clean.stdout).status, 'pass')

  const journey = await cleanJourney()
  journey.capture.recording = 'partial'
  const gap = await runCli(journey, await cleanExpectations())
  assert.equal(gap.code, 2)
  assert.equal(JSON.parse(gap.stdout).status, 'incomplete')
})
