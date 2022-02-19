/**
 * The shape guards, pinned one at a time.
 *
 * Every test in this file exists because a mutation sweep found the guard
 * undefended: the code was right and nothing held it there. Several of these
 * mutations leave the same rule id firing with a different message, which is
 * exactly the shape a rule-id-only assertion cannot see -- so the message is
 * what is asserted.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { makeFinding, msg, readRegion } from '../src/index.mjs'
import { auditMutated, findingsFor, regionNamed, ruleIds, stepNamed } from './helpers.mjs'

test('every required key of a region record is required BY NAME', async (t) => {
  for (const key of ['role', 'ariaLive', 'presentAtStart']) {
    await t.test(key, async () => {
      const report = await auditMutated((journey) => {
        delete regionNamed(journey, 'cart-status')[key]
      })
      assert.equal(report.status, 'incomplete')
      const named = findingsFor(report, 'region-invalid').filter((finding) => (
        new RegExp(`"${key}" is required; use null when the attribute was absent`, 'u').test(finding.message)
      ))
      assert.equal(named.length, 1)
    })
  }

  await t.test('the reader says the same thing directly', () => {
    const base = { id: 'status', role: 'status', ariaLive: null, presentAtStart: true }
    assert.equal(readRegion(base).ok, true)
    for (const key of ['role', 'ariaLive', 'presentAtStart']) {
      const raw = { ...base }
      delete raw[key]
      const read = readRegion(raw)
      assert.equal(read.ok, false, key)
      assert.match(read.reason, new RegExp(`"${key}" is required`, 'u'))
    }
  })
})

test('a capture.recording value the tool does not know is refused, not read as complete', async () => {
  // A typo here would silently turn a partial recording into a complete one,
  // which is the difference between "this update was not verified" and "this
  // update did not happen". It is refused rather than guessed.
  for (const value of ['complte', 'COMPLETE', true, null, undefined]) {
    const report = await auditMutated((journey) => {
      if (value === undefined) delete journey.capture.recording
      else journey.capture.recording = value
    })
    assert.equal(report.status, 'incomplete', String(value))
    assert.deepEqual(ruleIds(report), ['journey-invalid'])
    assert.match(report.findings[0].message, /"capture.recording" must be one of: complete, partial/u)
    assert.equal(report.summary.checked, 0, 'nothing is checked against a recording of unknown completeness')
  }
})

test('an unobservable subtree must give a reason the tool knows', async () => {
  const report = await auditMutated((journey) => {
    journey.unreadableRegions = [{ hostId: 'widget', reason: 'it-was-tricky' }]
  })
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ruleIds(report), ['journey-invalid'])
  assert.match(report.findings[0].message, /must give a "reason" from: shadow-root, closed-shadow-root/u)
  assert.equal(report.summary.checked, 0)
})

test('an update with no recorded time is never half-compared', async (t) => {
  // Removing the filter in the repeat walk does not crash: a missing time
  // coerces to 0 in the arithmetic, so two updates with no time at all look
  // like two updates at the same instant. That is a repeat this tool has no
  // evidence for.
  await t.test('two identical updates with no time are not a repeat', async () => {
    const report = await auditMutated((journey) => {
      const step = stepNamed(journey, '03-fix-and-submit')
      step.updates.push({ region: 'cart-status', text: 'Order placed' })
      step.updates.push({ region: 'cart-status', text: 'Order placed' })
    })
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.duplicateUpdates, 0)
    assert.equal(findingsFor(report, 'duplicate-update').length, 0)
    assert.equal(findingsFor(report, 'update-time-not-captured').length, 2)
  })

  await t.test('two updates with no text are not a repeat either', async () => {
    const report = await auditMutated((journey) => {
      const step = stepNamed(journey, '03-fix-and-submit')
      step.updates.push({ region: 'cart-status', atMs: 5400 })
      step.updates.push({ region: 'cart-status', atMs: 5450 })
    })
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.duplicateUpdates, 0)
    assert.equal(findingsFor(report, 'duplicate-update').length, 0)
    assert.equal(findingsFor(report, 'update-text-not-captured').length, 2)
  })

  await t.test('the same two updates WITH a time and text are a repeat', async () => {
    const report = await auditMutated((journey) => {
      stepNamed(journey, '03-fix-and-submit')
        .updates.push({ region: 'cart-status', text: 'Order placed', atMs: 5400 })
    })
    assert.equal(report.summary.duplicateUpdates, 1)
  })
})

test('a suggestion crosses the sanitising boundary like every other output string', () => {
  // Every call site builds its suggestion from this tool's own ASCII literals
  // today, so this changes no byte of any current report -- which is exactly
  // why it was the one string that could quietly skip the boundary. The guard
  // is asserted directly rather than through a fixture that cannot reach it.
  const finding = makeFinding(
    'duplicate-update',
    msg`a message`,
    { file: 'journey.json' },
    { suggestion: 'Write it once\u0085ERROR forged\u2028line\u202eand reversed' },
  )
  assert.equal(finding.suggestion, 'Write it once ERROR forged line and reversed')
  for (const character of ['\u0085', '\u2028', '\u202e']) {
    assert.ok(!finding.suggestion.includes(character))
  }
})
