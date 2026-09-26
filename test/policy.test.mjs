/**
 * The expectations document is the policy, so every problem with it means the
 * run never had a subject: exit 2, empty stdout, message on stderr.
 *
 * A documented key that is accepted and then ignored is one of the defect
 * classes this contract names: a one-character typo must not turn a real
 * failure into a green run.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ConfigError,
  DEFAULT_LIMITS,
  LIMIT_NAMES,
  POLITENESS_VALUES,
  parseInstant,
  validatePolicy,
} from '../src/index.mjs'
import { NOW, auditMutated, cleanExpectations, cleanJourney, ruleIds, runCli, stepNamed } from './helpers.mjs'

async function refuses(mutate, pattern) {
  const expectations = await cleanExpectations()
  mutate(expectations)
  const result = await runCli(await cleanJourney(), expectations)
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '', 'a configuration error leaves stdout empty')
  assert.match(result.stderr, pattern)
  return result
}

test('an unknown expectation key is refused, not ignored', async () => {
  await refuses((expectations) => {
    expectations.duplicateWindowMS = 500
  }, /Unknown expectation key\(s\): duplicateWindowMS/u)
})

test('a typo inside a step is refused too', async () => {
  await refuses((expectations) => {
    expectations.steps[0].exhastive = true
    delete expectations.steps[0].exhaustive
  }, /A step has unknown key\(s\): exhastive/u)
})

test('an unknown key inside an expectation is refused', async () => {
  await refuses((expectations) => {
    expectations.steps[0].expect[0].politeness = 'assertive'
  }, /unknown key\(s\): politeness/u)
})

test('an unknown key inside a region expectation is refused', async () => {
  await refuses((expectations) => {
    expectations.regions['cart-status'].atomic = true
  }, /has unknown key\(s\): atomic/u)
})

test('every required key must actually be given', async (t) => {
  for (const [key, pattern] of [
    ['duplicateWindowMs', /"duplicateWindowMs" must be a whole number/u],
    ['maxUpdatesPerStep', /"maxUpdatesPerStep" must be a whole number/u],
    ['regions', /"regions" must be a JSON object/u],
    ['steps', /"steps" must be an array/u],
  ]) {
    await t.test(key, async () => {
      await refuses((expectations) => {
        delete expectations[key]
      }, pattern)
    })
  }
  await t.test('schemaVersion', async () => {
    await refuses((expectations) => {
      delete expectations.schemaVersion
    }, /must declare "schemaVersion": "1"/u)
  })
})

test('an expected politeness must be one of the three aria-live allows', async () => {
  await refuses((expectations) => {
    expectations.regions['cart-status'].politeness = 'urgent'
  }, /must be one of: off, polite, assertive/u)
  assert.deepEqual(POLITENESS_VALUES, ['off', 'polite', 'assertive'])
})

test('a policy that states nothing to check is refused rather than reported as a pass', async () => {
  await refuses((expectations) => {
    expectations.regions = {}
    expectations.steps = []
  }, /states nothing to check/u)
})

test('a step named twice in the expectations is refused', async () => {
  await refuses((expectations) => {
    expectations.steps.push({ name: expectations.steps[0].name, expect: [] })
  }, /more than once/u)
})

test('duplicateWindowMs is enforced and comes only from the policy', async (t) => {
  const repeat = (journey) => {
    stepNamed(journey, '03-fix-and-submit').updates.push({
      region: 'cart-status',
      text: 'Order placed',
      atMs: 7300,
    })
  }
  await t.test('a window that does not reach is a pass', async () => {
    const report = await auditMutated(repeat, {
      expectations: (expectations) => { expectations.duplicateWindowMs = 1999 },
    })
    assert.equal(report.status, 'pass')
  })
  await t.test('a window that exactly reaches is a repeat', async () => {
    const report = await auditMutated(repeat, {
      expectations: (expectations) => { expectations.duplicateWindowMs = 2000 },
    })
    assert.equal(report.summary.duplicateUpdates, 1)
    assert.equal(report.status, 'fail')
  })
  await t.test('zero means only updates at the very same instant', async () => {
    const report = await auditMutated(
      (journey) => {
        stepNamed(journey, '03-fix-and-submit').updates.push({
          region: 'cart-status',
          text: 'Order placed',
          atMs: 5300,
        })
      },
      { expectations: (expectations) => { expectations.duplicateWindowMs = 0 } },
    )
    assert.equal(report.summary.duplicateUpdates, 1)
  })
})

test('maxUpdatesPerStep is enforced', async (t) => {
  await t.test('at the limit, the step is checked', async () => {
    const report = await auditMutated(null, {
      expectations: (expectations) => { expectations.maxUpdatesPerStep = 2 },
    })
    assert.equal(report.status, 'pass')
  })
  await t.test('over the limit, the step is not checked and the run is incomplete', async () => {
    const report = await auditMutated(null, {
      expectations: (expectations) => { expectations.maxUpdatesPerStep = 1 },
    })
    assert.equal(report.status, 'incomplete')
    assert.ok(ruleIds(report).includes('step-update-limit-exceeded'))
  })
  await t.test('zero is refused rather than making every step unusable', async () => {
    await refuses((expectations) => {
      expectations.maxUpdatesPerStep = 0
    }, /"maxUpdatesPerStep" must be a whole number between 1/u)
  })
})

test('exhaustive changes the verdict, in both directions', async (t) => {
  const extra = (journey) => {
    stepNamed(journey, '02-submit-empty').updates.push({
      region: 'cart-status',
      text: 'Basket saved',
      atMs: 1400,
    })
  }
  await t.test('an unlisted update in an exhaustive step fails', async () => {
    const report = await auditMutated(extra)
    assert.equal(report.status, 'fail')
    assert.deepEqual(ruleIds(report), ['unexpected-update'])
  })
  await t.test('the same update in a step that is not exhaustive passes', async () => {
    const report = await auditMutated(extra, {
      expectations: (expectations) => { expectations.steps[0].exhaustive = false },
    })
    assert.equal(report.status, 'pass')
  })
})

test('limits are validated and every one of them is enforced', async (t) => {
  await t.test('an unknown limit is refused', async () => {
    await refuses((expectations) => {
      expectations.limits = { maxRegionz: 10 }
    }, /Unknown limit\(s\): maxRegionz/u)
  })
  await t.test('a non-integer limit is refused', async () => {
    await refuses((expectations) => {
      expectations.limits = { maxRegions: 1.5 }
    }, /"limits.maxRegions" must be a whole number/u)
  })
  await t.test('the documented names and defaults are what the code uses', () => {
    assert.deepEqual(LIMIT_NAMES, ['maxJourneyBytes', 'maxRegions', 'maxSteps'])
    const policy = validatePolicy({
      schemaVersion: '1',
      duplicateWindowMs: 0,
      maxUpdatesPerStep: 1,
      regions: { a: { politeness: 'polite' } },
      steps: [],
    })
    assert.deepEqual(policy.limits, DEFAULT_LIMITS)
  })
})

test('maxRecordingAgeDays is enforced and is reproducible through --now', async (t) => {
  await t.test('inside the window passes', async () => {
    const report = await auditMutated(null, { now: NOW })
    assert.equal(report.status, 'pass')
  })
  await t.test('the boundary is the documented one', async () => {
    const recorded = Date.UTC(2026, 8, 12)
    const at90 = await auditMutated(null, { now: recorded + 90 * 86400000 })
    assert.equal(at90.status, 'pass')
    const at91 = await auditMutated(null, { now: recorded + 91 * 86400000 })
    assert.equal(at91.status, 'incomplete')
    assert.deepEqual(ruleIds(at91), ['journey-stale'])
  })
  await t.test('omitting it removes the check entirely', async () => {
    const report = await auditMutated(
      (journey) => { delete journey.capture.recordedAt },
      { expectations: (expectations) => { delete expectations.maxRecordingAgeDays } },
    )
    assert.equal(report.status, 'pass')
  })
})

test('the instant parser refuses anything it was not taught', () => {
  assert.deepEqual(parseInstant('2026-09-18'), { ok: true, ms: Date.UTC(2026, 8, 18) })
  assert.deepEqual(parseInstant('2026-09-18T12:30:00Z'), { ok: true, ms: Date.UTC(2026, 8, 18, 12, 30, 0) })
  for (const value of ['18 September 2026', '2026-09-18T12:30:00+01:00', '2026-02-30', '2026-13-01', '', null, 20260918]) {
    assert.equal(parseInstant(value).ok, false, String(value))
  }
})

test('validatePolicy throws ConfigError, which the CLI turns into exit 2', () => {
  assert.throws(() => validatePolicy(null), ConfigError)
  assert.throws(() => validatePolicy([]), ConfigError)
  assert.throws(() => validatePolicy({ schemaVersion: '1' }), ConfigError)
})
