/**
 * The acceptance criteria, one test block each, asserted through the real entry
 * point and the real CLI so that the exit code is observed rather than
 * described.
 *
 *   "Duplicate updates are counted"
 *   "polite/assertive expectations are checked"
 *   "actual spoken output requires separate manual evidence"
 *
 * Each block also pins the honest NEGATIVE: the same situation, with the
 * evidence missing instead of the defect present, must come back `incomplete`
 * and exit 2 -- never `pass`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MANUAL_EVIDENCE_REQUIRED,
  NOT_ESTABLISHED,
  REFUSED_POLICY_KEYS,
} from '../src/index.mjs'
import {
  auditMutated,
  cleanExpectations,
  cleanJourney,
  findingsFor,
  regionNamed,
  ruleIds,
  runCli,
  stepNamed,
} from './helpers.mjs'

test('the shipped clean example passes, so the failing cases below are not passing by accident', async () => {
  const report = await auditMutated(null)
  assert.equal(report.status, 'pass')
  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.checked, 3)
  assert.equal(report.summary.duplicateUpdates, 0)
})

test('duplicate updates are counted', async (t) => {
  await t.test('a region written twice with the same text inside the window is counted and fails', async () => {
    const report = await auditMutated((journey) => {
      stepNamed(journey, '03-fix-and-submit').updates.push({
        region: 'cart-status',
        text: 'Order placed',
        atMs: 5600,
      })
    })
    assert.equal(report.status, 'fail')
    assert.equal(report.summary.duplicateUpdates, 1)
    const duplicates = findingsFor(report, 'duplicate-update')
    assert.equal(duplicates.length, 1)
    assert.match(duplicates[0].message, /300ms apart/u)
    assert.equal(duplicates[0].evidence, 'gap 300ms, window 1000ms')
  })

  await t.test('every repeat is counted, not just the time-adjacent ones', async () => {
    // The README states the rule as a predicate over PAIRS, and this is what
    // that means: four updates carrying one text inside the window hold six
    // pairs, not three. The body of this test asserted three, which is the
    // count of TIME-ADJACENT pairs -- the defect, written down as the expected
    // behaviour under a name that states the honest rule.
    const report = await auditMutated((journey) => {
      const step = stepNamed(journey, '03-fix-and-submit')
      step.updates.push({ region: 'cart-status', text: 'Order placed', atMs: 5400 })
      step.updates.push({ region: 'cart-status', text: 'Order placed', atMs: 5500 })
      step.updates.push({ region: 'cart-status', text: 'Order placed', atMs: 5600 })
    })
    assert.equal(report.summary.duplicateUpdates, 6)
    assert.equal(findingsFor(report, 'duplicate-update').length, 6)
  })

  await t.test('a repeat with different text between its halves is still a repeat', async () => {
    // A@1200, B@1400, A@1600, all inside a 1000ms window: two updates naming
    // one region with one text, 400ms apart. This reported duplicateUpdates 0
    // and exited 0, because the halves were not adjacent in TIME. Moving the
    // identical texts next to each other made the same tool report the repeat,
    // so the verdict turned on the interleaving, which the rule never mentions.
    const loose = (expectations) => { expectations.steps[0].exhaustive = false }
    const report = await auditMutated((journey) => {
      stepNamed(journey, '02-submit-empty').updates = [
        { region: 'form-errors', text: 'There is a problem', atMs: 1200 },
        { region: 'form-errors', text: 'Checking', atMs: 1400 },
        { region: 'form-errors', text: 'There is a problem', atMs: 1600 },
      ]
    }, { expectations: loose })
    assert.equal(report.status, 'fail')
    assert.equal(report.summary.duplicateUpdates, 1)
    const repeats = findingsFor(report, 'duplicate-update')
    assert.equal(repeats.length, 1)
    assert.match(repeats[0].message, /same text twice 400ms apart/u)

    const interleavedPairs = await auditMutated((journey) => {
      stepNamed(journey, '02-submit-empty').updates = [
        { region: 'form-errors', text: 'There is a problem', atMs: 1000 },
        { region: 'form-errors', text: 'Checking', atMs: 1100 },
        { region: 'form-errors', text: 'There is a problem', atMs: 1200 },
        { region: 'form-errors', text: 'Checking', atMs: 1300 },
      ]
    }, { expectations: loose })
    assert.equal(interleavedPairs.summary.duplicateUpdates, 2, 'A,B,A,B is two repeats, one per text')
  })

  await t.test(
    'more repeats than this run names one by one is reported, never truncated silently',
    async () => {
      // A repeat is a pair, so the number of them is quadratic in how many
      // times one text was written inside the window, while the recording is
      // bounded only by maxJourneyBytes. Forty-six updates hold 1035 pairs.
      // The COUNT stays exact; the enumeration stops at the limit and says so,
      // and saying so is what makes the run incomplete rather than a fail that
      // quietly listed some of the evidence.
      const report = await auditMutated((journey) => {
        const step = stepNamed(journey, '03-fix-and-submit')
        for (let index = 0; index < 45; index += 1) {
          step.updates.push({ region: 'cart-status', text: 'Order placed', atMs: 5300 + index + 1 })
        }
      }, { expectations: (expectations) => { expectations.maxUpdatesPerStep = 60 } })
      assert.equal(report.summary.duplicateUpdates, 1035)
      assert.equal(findingsFor(report, 'duplicate-update').length, 1000)
      assert.equal(report.status, 'incomplete')
      const truncated = findingsFor(report, 'duplicate-enumeration-truncated')
      assert.equal(truncated.length, 1)
      assert.equal(truncated[0].evidence, 'named 1000 of 1035')

      const cli = await runCli(
        await (async () => {
          const journey = await cleanJourney()
          const step = stepNamed(journey, '03-fix-and-submit')
          for (let index = 0; index < 45; index += 1) {
            step.updates.push({ region: 'cart-status', text: 'Order placed', atMs: 5300 + index + 1 })
          }
          return journey
        })(),
        { ...(await cleanExpectations()), maxUpdatesPerStep: 60 },
      )
      assert.equal(cli.code, 2, 'a limit reached is exit 2, not a fail that listed part of it')
    },
  )

  await t.test('the window is what decides, and it comes from the expectations', async () => {
    const spaced = (journey) => {
      stepNamed(journey, '03-fix-and-submit').updates.push({
        region: 'cart-status',
        text: 'Order placed',
        atMs: 7300,
      })
    }
    const outside = await auditMutated(spaced)
    assert.equal(outside.status, 'pass')
    assert.equal(outside.summary.duplicateUpdates, 0)

    const widened = await auditMutated(spaced, {
      expectations: (expectations) => { expectations.duplicateWindowMs = 5000 },
    })
    assert.equal(widened.status, 'fail')
    assert.equal(widened.summary.duplicateUpdates, 1)
  })

  await t.test('different text in the same region is not a repeat', async () => {
    const report = await auditMutated((journey) => {
      stepNamed(journey, '03-fix-and-submit').updates.push({
        region: 'cart-status',
        text: 'Order placed, confirmation on its way',
        atMs: 5400,
      })
    })
    assert.equal(report.summary.duplicateUpdates, 0)
    assert.equal(report.status, 'pass')
  })

  await t.test('the same text in two different regions is not a repeat', async () => {
    const report = await auditMutated((journey) => {
      stepNamed(journey, '03-fix-and-submit').updates.push({
        region: 'save-progress',
        text: 'Order placed',
        atMs: 5400,
      })
    })
    assert.equal(report.summary.duplicateUpdates, 0)
  })

  await t.test(
    'an update with no recorded time is NOT declared free of repeats: incomplete, exit 2',
    async () => {
      // Without a time the update cannot be placed inside or outside the
      // window, so it is left out of the comparison and the run says so.
      const journey = await cleanJourney()
      const step = stepNamed(journey, '03-fix-and-submit')
      step.updates.push({ region: 'cart-status', text: 'Order placed' })
      const result = await runCli(journey, await cleanExpectations())
      assert.equal(result.code, 2)
      const report = JSON.parse(result.stdout)
      assert.equal(report.status, 'incomplete')
      assert.deepEqual(ruleIds(report), ['update-time-not-captured'])
      assert.equal(report.summary.duplicateUpdates, 0)
      assert.match(report.findings[0].message, /left out of that comparison/u)
    },
  )

  await t.test('an update with no recorded text is left out of the comparison too', async () => {
    const report = await auditMutated((journey) => {
      stepNamed(journey, '03-fix-and-submit').updates.push({ region: 'cart-status', atMs: 5400 })
    })
    assert.equal(report.status, 'incomplete')
    assert.deepEqual(ruleIds(report), ['update-text-not-captured'])
    assert.equal(report.summary.duplicateUpdates, 0)
  })
})

test('polite and assertive expectations are checked', async (t) => {
  await t.test('a region that resolves polite where assertive is expected fails', async () => {
    const report = await auditMutated((journey) => {
      regionNamed(journey, 'form-errors').role = 'status'
    })
    assert.equal(report.status, 'fail')
    const mismatch = findingsFor(report, 'politeness-mismatch')
    assert.equal(mismatch.length, 1)
    assert.match(mismatch[0].message, /resolves to polite from role=status, but the expectations declare assertive/u)
  })

  await t.test('a region that resolves assertive where polite is expected fails', async () => {
    const report = await auditMutated((journey) => {
      regionNamed(journey, 'cart-status').ariaLive = 'assertive'
    })
    assert.equal(report.status, 'fail')
    assert.deepEqual(ruleIds(report), ['politeness-mismatch'])
  })

  await t.test('aria-live wins over the role, and the report says which decided it', async () => {
    const report = await auditMutated((journey) => {
      // role=alert would be assertive; the attribute says otherwise and wins.
      regionNamed(journey, 'form-errors').ariaLive = 'polite'
    })
    assert.equal(report.status, 'fail')
    assert.match(findingsFor(report, 'politeness-mismatch')[0].message, /from aria-live/u)
  })

  await t.test('every documented role maps to the documented urgency', async () => {
    const cases = [
      ['alert', 'assertive'],
      ['status', 'polite'],
      ['log', 'polite'],
      ['timer', 'off'],
      ['marquee', 'off'],
    ]
    for (const [role, politeness] of cases) {
      const report = await auditMutated(
        (journey) => {
          const region = regionNamed(journey, 'form-errors')
          region.role = role
          region.ariaLive = null
        },
        { expectations: (expectations) => { expectations.regions['form-errors'].politeness = politeness } },
      )
      const mismatch = findingsFor(report, 'politeness-mismatch')
      assert.equal(mismatch.length, 0, `${role} should resolve to ${politeness}`)
    }
  })

  await t.test('a region whose urgency cannot be determined is incomplete, never a pass', async () => {
    for (const [role, ariaLive] of [[null, null], ['banner', null], [null, 'urgent']]) {
      const journey = await cleanJourney()
      const region = regionNamed(journey, 'form-errors')
      region.role = role
      region.ariaLive = ariaLive
      const result = await runCli(journey, await cleanExpectations())
      assert.equal(result.code, 2, `${role} / ${ariaLive}`)
      const report = JSON.parse(result.stdout)
      assert.equal(report.status, 'incomplete')
      assert.ok(
        ruleIds(report).includes(ariaLive === 'urgent' ? 'politeness-value-invalid' : 'politeness-unknown'),
      )
      assert.ok(
        !ruleIds(report).includes('politeness-mismatch'),
        'an urgency that was not determined must not be compared with the expectation',
      )
    }
  })

  await t.test('an expectation about a region the recording never describes is incomplete', async () => {
    const report = await auditMutated(null, {
      expectations: (expectations) => {
        expectations.regions['toast-host'] = { politeness: 'assertive' }
      },
    })
    assert.equal(report.status, 'incomplete')
    assert.deepEqual(ruleIds(report), ['expected-region-not-captured'])
  })

  await t.test('a region that resolves off and is still written to fails', async () => {
    const report = await auditMutated(
      (journey) => { regionNamed(journey, 'cart-status').ariaLive = 'off' },
      { expectations: (expectations) => { expectations.regions['cart-status'].politeness = 'off' } },
    )
    assert.equal(report.status, 'fail')
    assert.deepEqual(ruleIds(report), ['region-off-with-updates'])
  })
})

test('actual spoken output requires separate manual evidence', async (t) => {
  await t.test('an expectation about spoken output is refused: exit 2 with EMPTY stdout', async () => {
    for (const key of REFUSED_POLICY_KEYS) {
      const expectations = await cleanExpectations()
      expectations[key] = 'There is a problem'
      const result = await runCli(await cleanJourney(), expectations)
      assert.equal(result.code, 2, key)
      assert.equal(result.stdout, '', `${key} must leave stdout empty: the run never had a subject`)
      assert.match(result.stderr, /cannot be checked from a recording of element changes/u)
      assert.match(result.stderr, /separate manual evidence/u)
    }
  })

  await t.test('every report hands over what a person still has to establish by listening', async () => {
    const report = await auditMutated(null)
    assert.deepEqual(report.manualEvidenceRequired, [...MANUAL_EVIDENCE_REQUIRED])
    assert.deepEqual(report.notEstablished, [...NOT_ESTABLISHED])
    assert.match(report.manualEvidenceRequired[0], /conveyed at all/u)
    assert.match(report.disclaimer, /somebody who listened/u)
  })

  await t.test('the vocabulary holds even on a passing run: nothing here is called an announcement', async () => {
    const reports = [
      await auditMutated(null),
      await auditMutated((journey) => {
        journey.capture.recording = 'partial'
        regionNamed(journey, 'form-errors').role = 'status'
      }),
    ]
    for (const report of reports) {
      for (const finding of report.findings) {
        for (const text of [finding.message, finding.suggestion ?? '', finding.evidence ?? '']) {
          assert.ok(!/announce/iu.test(text), `${finding.ruleId}: ${text}`)
          assert.ok(!/spoken|heard|audible/iu.test(text), `${finding.ruleId}: ${text}`)
        }
      }
    }
  })

  await t.test('a passing run still says what it did not establish', async () => {
    const result = await runCli(await cleanJourney(), await cleanExpectations())
    assert.equal(result.code, 0)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'pass')
    assert.equal(report.findings.length, 0)
    assert.equal(report.notEstablished.length, 5)
    assert.equal(report.manualEvidenceRequired.length, 3)
  })
})
