/**
 * The limits of the evidence, pinned as BEHAVIOUR rather than as sentences in
 * the README.
 *
 * The clause this tool is judged on is "actual spoken output requires separate
 * manual evidence", and it is enforced by four things that fail loudly:
 *
 *   - a finding that would call an update an announcement throws at construction
 *   - an expectation about spoken output is refused with an empty stdout and exit 2
 *   - every report carries the handover: what a person still has to establish
 *   - a subtree the recording could not observe is named, and stops absence
 *     being treated as evidence
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CATALOG,
  DISCLAIMER,
  FORBIDDEN_CLAIMS,
  findForbiddenClaim,
  makeFinding,
  msg,
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

test('a recorded update is never called an announcement', async (t) => {
  await t.test('a finding message that would say otherwise throws at construction', () => {
    assert.throws(
      () => msg`The update was announced to the user.`,
      /may not claim this tool observed an interface directly or knows what anyone was told/u,
    )
    assert.throws(() => msg`A screen reader read it first.`, /screen reader/u)
    assert.throws(() => msg`The spoken order was wrong.`, /spoken/u)
    assert.throws(() => msg`Nothing was heard.`, /heard/u)
    assert.throws(
      () => makeFinding('duplicate-update', msg`fine`, {}, { suggestion: 'Check what NVDA announces.' }),
      /may not claim/u,
    )
  })

  await t.test('a finding may not be built from a raw string at all', () => {
    // This guard is the whole of the enforcement above. FORBIDDEN_CLAIMS is
    // checked INSIDE `msg`, so a call site handing `makeFinding` a plain string
    // would bypass the check completely -- and the resulting finding carries no
    // `message` field at all, which the report contract requires. Duck-typing
    // is refused too: the check is `instanceof`, not "has a text property".
    assert.throws(
      () => makeFinding('duplicate-update', 'A screen reader announced it twice.', { file: 'j.json' }),
      /must build its message with the msg tagged template/u,
    )
    assert.throws(
      () => makeFinding('duplicate-update', { text: 'a message-shaped object' }, { file: 'j.json' }),
      /must build its message with the msg tagged template/u,
    )
    const built = makeFinding('duplicate-update', msg`A message built the one permitted way.`, { file: 'j.json' })
    assert.equal(built.message, 'A message built the one permitted way.')
  })

  await t.test('a line break cannot hide a forbidden phrase from the check', () => {
    assert.throws(
      () => msg`The message was read
        aloud twice.`,
      /read aloud/u,
    )
  })

  await t.test('the check reads the tool’s own words, not the recording’s', async () => {
    // A team is allowed to name an element after the job it does. Scanning the
    // rendering rather than the source would let a region id flag the tool.
    const report = await auditMutated((journey) => {
      journey.regions.push({ id: 'announcer', role: 'status', ariaLive: null, presentAtStart: true })
      stepNamed(journey, '03-fix-and-submit').updates.push({
        region: 'announcer',
        text: 'Order placed',
        atMs: 5900,
      })
    })
    assert.equal(report.status, 'pass')
    assert.equal(findForbiddenClaim('announcer'), null, 'the substring alone is not a claim')
    assert.equal(findForbiddenClaim('the update was announced'), 'announced')
  })

  await t.test('no finding in any run carries a word this tool is not entitled to', async () => {
    const reports = [
      await auditMutated(null),
      await auditMutated((journey) => {
        journey.capture.recording = 'partial'
        regionNamed(journey, 'form-errors').ariaLive = 'urgent'
        delete stepNamed(journey, '03-fix-and-submit').updates[0].atMs
      }),
    ]
    for (const report of reports) {
      for (const finding of report.findings) {
        for (const text of [finding.message, finding.suggestion ?? '', finding.evidence ?? '']) {
          assert.equal(findForbiddenClaim(text), null, `${finding.ruleId}: ${text}`)
        }
      }
    }
  })

  await t.test('the forbidden list names the words that would slide from update to announcement', () => {
    for (const term of ['announce', 'announced', 'announcement', 'spoken', 'heard', 'screen reader']) {
      assert.ok(FORBIDDEN_CLAIMS.includes(term), term)
    }
  })

  await t.test('the disclaimer hands the question over rather than answering it', async () => {
    const report = await auditMutated(null)
    assert.match(DISCLAIMER, /needs separate manual evidence from somebody who listened/u)
    assert.equal(report.disclaimer, DISCLAIMER)
    assert.ok(report.manualEvidenceRequired.length > 0)
  })
})

test('what the recording could not observe is explicit', async (t) => {
  await t.test('an unobserved subtree is named with its reason and exits 2', async () => {
    const journey = await cleanJourney()
    journey.unreadableRegions = [{ hostId: 'cart-widget', reason: 'closed-shadow-root' }]
    const result = await runCli(journey, await cleanExpectations())
    assert.equal(result.code, 2)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'incomplete')
    const subtree = findingsFor(report, 'subtree-not-captured')
    assert.equal(subtree.length, 1)
    assert.match(subtree[0].message, /cart-widget/u)
    assert.equal(subtree[0].evidence, 'reason: closed-shadow-root')
    assert.equal(subtree[0].location.pointer, '/unreadableRegions/cart-widget')
  })

  await t.test('a recording that claims to be complete while listing one is still incomplete', async () => {
    // The two statements contradict each other and the conservative one wins.
    // Deleting the `reasons.length === 0` term of `complete` turns this run
    // from exit 2 into exit 1.
    const report = await auditMutated((journey) => {
      journey.capture.recording = 'complete'
      journey.unreadableRegions = [{ hostId: 'cart-widget', reason: 'cross-origin-iframe' }]
      const step = stepNamed(journey, '03-fix-and-submit')
      step.updates = step.updates.filter((update) => update.region !== 'cart-status')
    })
    assert.equal(report.status, 'incomplete')
    assert.ok(ruleIds(report).includes('update-unverifiable'))
    assert.ok(!ruleIds(report).includes('expected-update-missing'))
  })

  await t.test('the SAME missing update is a defect with a complete recording and a gap without one', async () => {
    const drop = (journey) => {
      const step = stepNamed(journey, '03-fix-and-submit')
      step.updates = step.updates.filter((update) => update.region !== 'cart-status')
    }

    const complete = await auditMutated(drop)
    assert.equal(complete.status, 'fail')
    assert.deepEqual(ruleIds(complete), ['expected-update-missing'])

    const partial = await auditMutated((journey) => {
      drop(journey)
      journey.capture.recording = 'partial'
    })
    assert.equal(partial.status, 'incomplete')
    assert.ok(ruleIds(partial).includes('update-unverifiable'))
    assert.ok(!ruleIds(partial).includes('expected-update-missing'))
  })

  await t.test('an update whose text nobody recorded stops absence being evidence for it', async () => {
    // The step DOES write to the expected region. What was not established is
    // what the write carried. Reporting `expected-update-missing` there is an
    // error-severity accusation that the interface omitted an update, in the
    // same report that emits `update-text-not-captured` about that very
    // update -- the tool's own "absence is only evidence when the recording
    // holds everything" broken in the report that reports the gap.
    const report = await auditMutated((journey) => {
      const update = stepNamed(journey, '03-fix-and-submit')
        .updates.find((entry) => entry.region === 'cart-status')
      delete update.text
    })
    assert.equal(report.status, 'incomplete')
    assert.ok(ruleIds(report).includes('update-text-not-captured'))
    assert.ok(ruleIds(report).includes('update-unverifiable'))
    assert.ok(
      !ruleIds(report).includes('expected-update-missing'),
      'an update this run says it cannot read may not also be reported as absent',
    )
    const gap = findingsFor(report, 'update-unverifiable')[0]
    assert.match(gap.message, /does write to cart-status, and the text of that update was not recorded/u)

    // The control, from the same document: with the text recorded and wrong,
    // the expectation really is missing, and the tool says so and exits 1.
    const wrong = await auditMutated((journey) => {
      stepNamed(journey, '03-fix-and-submit')
        .updates.find((entry) => entry.region === 'cart-status').text = 'Something else'
    })
    assert.equal(wrong.status, 'fail')
    assert.ok(ruleIds(wrong).includes('expected-update-missing'))
  })

  await t.test('a step that went past the per-step limit stops absence being evidence in that step', async () => {
    const report = await auditMutated(
      (journey) => {
        const step = stepNamed(journey, '03-fix-and-submit')
        step.updates = step.updates.filter((update) => update.region !== 'cart-status')
        step.updates.push({ region: 'save-progress', text: 'Still saving', atMs: 4900 })
        step.updates.push({ region: 'save-progress', text: 'Nearly there', atMs: 5000 })
      },
      { expectations: (expectations) => { expectations.maxUpdatesPerStep = 2 } },
    )
    assert.equal(report.status, 'incomplete')
    assert.ok(ruleIds(report).includes('step-update-limit-exceeded'))
    assert.ok(ruleIds(report).includes('update-unverifiable'))
    assert.ok(!ruleIds(report).includes('expected-update-missing'))
  })

  await t.test('the recording says once why absence stopped being evidence', async () => {
    const report = await auditMutated((journey) => {
      journey.capture.recording = 'partial'
    })
    const gate = findingsFor(report, 'recording-incomplete')
    assert.equal(gate.length, 1)
    assert.equal(gate[0].evidence, 'the recording declares "recording": "partial"')
    assert.match(gate[0].message, /was not treated as an update that did not happen/u)
  })

  await t.test('every reason an exporter may give is accepted and echoed', async () => {
    for (const reason of CATALOG.unreadableReasons) {
      const report = await auditMutated((journey) => {
        journey.unreadableRegions = [{ hostId: 'widget', reason }]
      })
      assert.equal(report.status, 'incomplete')
      assert.equal(findingsFor(report, 'subtree-not-captured')[0].evidence, `reason: ${reason}`)
    }
  })
})

test('results remain evidence about recorded changes', async (t) => {
  await t.test('the report names the kind of evidence it rests on', async () => {
    const report = await auditMutated(null)
    assert.equal(report.evidenceBasis, 'dom-mutation-record')
    assert.equal(CATALOG.supportedSource, 'dom-mutation-record')
  })

  await t.test('evidence of another kind is refused, not reinterpreted: exit 2, nothing checked', async () => {
    for (const source of ['screen-recording', 'screen-reader-transcript', 'video', undefined]) {
      const journey = await cleanJourney()
      if (source === undefined) delete journey.capture.source
      else journey.capture.source = source
      const result = await runCli(journey, await cleanExpectations())
      assert.equal(result.code, 2, String(source))
      const report = JSON.parse(result.stdout)
      assert.equal(report.status, 'incomplete')
      assert.deepEqual(ruleIds(report), ['capture-source-unsupported'])
      assert.equal(report.summary.checked, 0, 'nothing may be checked against evidence of the wrong kind')
      assert.equal(report.summary.regions, 0)
    }
  })

  await t.test('every finding points at the recording it came from', async () => {
    const report = await auditMutated((journey) => {
      journey.capture.recording = 'partial'
      regionNamed(journey, 'form-errors').role = 'status'
      delete stepNamed(journey, '03-fix-and-submit').updates[0].atMs
    })
    assert.ok(report.findings.length >= 3)
    for (const finding of report.findings) {
      assert.equal(finding.location.file, 'journey.json')
      assert.ok(!finding.location.file.startsWith('/'), 'never an absolute host path')
      assert.match(finding.location.pointer, /^\//u)
    }
  })

  await t.test('the urgency table is a fixed, documented list, not an ARIA implementation', () => {
    assert.deepEqual(CATALOG.knownRoles, ['alert', 'log', 'marquee', 'progressbar', 'status', 'timer'])
    assert.deepEqual(CATALOG.rolePoliteness, {
      alert: 'assertive',
      log: 'polite',
      marquee: 'off',
      progressbar: 'polite',
      status: 'polite',
      timer: 'off',
    })
  })
})
