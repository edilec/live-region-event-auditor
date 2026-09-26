/**
 * The sanitising boundary, and the difference between "present" and "shows
 * something".
 *
 * Two shapes are pinned here, and both have shipped as real defects:
 *
 * 1. A tool that sanitised its `evidence` field carefully and let an
 *    IDENTIFIER carrying a newline forge whole lines in the report. Every
 *    untrusted string crosses the same boundary, so each class is driven
 *    through a region id, not only through an excerpt.
 * 2. `value.trim().length > 0` passing for a string of U+0001 or U+200E that
 *    then shows nothing at all. An update that leaves a region showing nothing
 *    is worth reporting, so the question is asked about the rendered form.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { describeValue, isRenderableString, renderReport, sanitize, showsSomething } from '../src/index.mjs'
import { auditMutated, cleanExpectations, cleanJourney, findingsFor, ruleIds, runCli, runCliRaw, stepNamed } from './helpers.mjs'

const CLASSES = [
  ['C0', '\u0001'],
  ['newline', '\n'],
  ['DEL', '\u007f'],
  ['C1 NEL', '\u0085'],
  ['C1 CSI', '\u009b'],
  ['line separator', '\u2028'],
  ['paragraph separator', '\u2029'],
  ['bidi LRM', '\u200e'],
  ['bidi RLO', '\u202e'],
  ['bidi isolate', '\u2066'],
]

/** Every class above, as a code point rather than as a name. */
const UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/u

test('a configuration diagnostic crosses the same boundary as a report', async (t) => {
  // A ConfigError message goes to stderr, and the name it prints came out of
  // the expectations document. These were the strings in this tool that skipped
  // `sanitize`: the unknown-key lists, and -- worse -- region ids and step
  // names, which are echoed into most of validatePolicy's messages. stdout
  // stays empty and the exit code stays 2 either way, which is why it went
  // unnoticed.
  for (const [name, character] of CLASSES) {
    await t.test(`a region id carrying ${name}`, async () => {
      const expectations = await cleanExpectations()
      expectations.regions[`cart${character}status`] = { politeness: 'not-a-value' }
      const result = await runCli(await cleanJourney(), expectations)
      assert.equal(result.code, 2)
      assert.equal(result.stdout, '', 'a configuration error carries no report')
      assert.equal(result.stderr.split('\n').length, 2, `${name}: one line, one terminator`)
      assert.ok(!UNSAFE.test(result.stderr.replace(/\n$/u, '')), name)
      assert.match(result.stderr, /"regions\.cart status\.politeness" must be one of/u)
    })
  }

  await t.test('a step name is on the same boundary', async () => {
    const expectations = await cleanExpectations()
    expectations.steps.push({ name: '03-fix\u2028and-submit', expect: [{ region: 'cart-status' }], exhaustive: 'no' })
    const result = await runCli(await cleanJourney(), expectations)
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr.split('\n').length, 2)
    assert.match(result.stderr, /"steps\.03-fix and-submit\.exhaustive" must be true or false\./u)
  })

  await t.test('an unknown expectations key is on the same boundary', async () => {
    const expectations = await cleanExpectations()
    expectations['bad\u0085key'] = 1
    const result = await runCli(await cleanJourney(), expectations)
    assert.equal(result.code, 2)
    assert.equal(result.stderr.split('\n').length, 2)
    assert.match(result.stderr, /Unknown expectation key\(s\): bad key\./u)
  })

  await t.test('an unknown CLI option is on the same boundary', async () => {
    const result = await runCliRaw(['--journey', 'x.json', '--not\u0085an\u202eoption'])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    // The usage text that follows legitimately has newlines, so the assertion
    // is about the diagnostic line itself: it must be one line, and it must
    // still be the whole of the first line.
    const [diagnostic, ...rest] = result.stderr.split('\n')
    assert.equal(diagnostic, 'Unknown option "--not an option"', 'argv is untrusted input too')
    assert.equal(rest[0], '', 'the diagnostic is one line, then a blank line, then the usage text')
    assert.ok(!UNSAFE.test(diagnostic))
  })

  await t.test('a name that renders as nothing is named, not printed as a gap', async () => {
    const expectations = await cleanExpectations()
    expectations['\u0001\u200e'] = 1
    const result = await runCli(await cleanJourney(), expectations)
    assert.equal(result.code, 2)
    assert.match(result.stderr, /\(a name that renders as nothing\)/u)
  })
})

test('an expected text that would render as nothing is a configuration error', async (t) => {
  // The "validate what you will render" row of the contract's table, in a
  // policy value. `typeof entry.text === 'string'` accepted a text of stripped
  // characters, compared it, and rendered it into the evidence as nothing:
  // exit 1, status fail, evidence "expected text:" and nothing after it -- a
  // failure nobody can act on. The region id and the step name were already
  // refused on this ground; the text was not.
  for (const [name, character] of CLASSES) {
    await t.test(`an expected text of only ${name}`, async () => {
      const expectations = await cleanExpectations()
      expectations.steps[1].expect = [{ region: 'cart-status', text: character }]
      const result = await runCli(await cleanJourney(), expectations)
      assert.equal(result.code, 2, `${name}: a configuration error, not a failure with blank evidence`)
      assert.equal(result.stdout, '', 'a configuration error carries no report')
      assert.match(result.stderr, /has a "text" that renders as nothing/u)
    })
  }

  await t.test('the empty string is refused on the same ground', async () => {
    const expectations = await cleanExpectations()
    expectations.steps[1].expect = [{ region: 'cart-status', text: '' }]
    const result = await runCli(await cleanJourney(), expectations)
    assert.equal(result.code, 2)
    assert.match(result.stderr, /has a "text" that renders as nothing/u)
  })

  await t.test('a text longer than any id cap is still accepted: length is not the question', async () => {
    // `showsSomething`, not `isRenderableString`. Expected text is compared
    // exactly at any length, so capping it here would refuse a legitimate
    // expectation -- the opposite false answer to the one above.
    const long = 'x'.repeat(2000)
    const expectations = await cleanExpectations()
    expectations.steps[1].expect = [{ region: 'cart-status', text: long }]
    const result = await runCli(await cleanJourney(), expectations)
    assert.equal(result.code, 1, 'the expectation is checked, and this recording does not meet it')
    const report = JSON.parse(result.stdout)
    assert.deepEqual(ruleIds(report), ['expected-update-missing'])
  })
})

test('every unsafe class is stripped, not only C0 and the separators', () => {
  for (const [name, character] of CLASSES) {
    assert.equal(sanitize(`a${character}b`), 'a b', name)
    assert.equal(sanitize(character), '', name)
  }
})

test('an unsafe character arriving through a REGION ID cannot forge a line', async () => {
  for (const [name, character] of CLASSES) {
    const regionId = `ghost${character}ERROR forged line`
    const report = await auditMutated((journey) => {
      stepNamed(journey, '03-fix-and-submit').updates.push({ region: regionId, text: 'x', atMs: 5900 })
    })
    const rendered = renderReport(report)
    // The rendered document is indented, so its own newlines are expected;
    // every other class must be absent from it entirely.
    if (character !== '\n') assert.ok(!rendered.includes(character), `${name} survived into the report`)
    assert.ok(ruleIds(report).includes('region-unknown'))
    for (const finding of report.findings) {
      assert.ok(!finding.message.includes(character), `${name} survived into a message`)
      assert.ok(!finding.location.pointer.includes(character), `${name} survived into a pointer`)
    }
  }
})

test('an unsafe character arriving through update TEXT cannot forge a line either', async () => {
  const report = await auditMutated((journey) => {
    stepNamed(journey, '03-fix-and-submit').updates.push({
      region: 'toast\u0085host',
      text: 'Saved\u2028ERROR forged',
      atMs: 5900,
    })
  })
  const rendered = renderReport(report)
  assert.ok(!rendered.includes('\u2028'))
  assert.ok(!rendered.includes('\u0085'))
})

test('the two separators are escaped in the rendered JSON as well as stripped upstream', () => {
  const rendered = renderReport({ note: 'a\u2028b\u2029c' })
  assert.ok(!rendered.includes('\u2028'))
  assert.ok(!rendered.includes('\u2029'))
  assert.match(rendered, /a\\u2028b\\u2029c/u)
  assert.deepEqual(JSON.parse(rendered), { note: 'a\u2028b\u2029c' })
})

test('a value that cannot be converted to a primitive is described, never reproduced', () => {
  const hostile = JSON.parse('{"toString": {}}')
  assert.throws(() => String(hostile), /convert object to primitive/u)
  assert.equal(describeValue(hostile), '[object]')
  assert.equal(sanitize(hostile), '[object]')
})

test('a recording carrying such a value does not stop the run', async () => {
  const report = await auditMutated((journey) => {
    journey.regions.push(JSON.parse('{"id": {"toString": {}}, "role": null, "ariaLive": "polite", "presentAtStart": true}'))
  })
  assert.equal(report.status, 'incomplete')
  assert.ok(ruleIds(report).includes('region-invalid'))
})

test('an update that leaves a region showing nothing is reported', async (t) => {
  for (const [name, character] of CLASSES) {
    await t.test(`text of ${name}`, async () => {
      const report = await auditMutated((journey) => {
        stepNamed(journey, '03-fix-and-submit')
          .updates.find((update) => update.region === 'save-progress').text = character.repeat(4)
      })
      assert.equal(report.status, 'fail')
      assert.deepEqual(ruleIds(report), ['update-text-empty'])
      assert.ok(!findingsFor(report, 'update-text-empty')[0].message.includes(character))
    })
  }

  await t.test('an explicitly emptied region is NOT reported: clearing is a normal thing to do', async (inner) => {
    // The two cases are not the same defect and this rule now separates them.
    // Text made of stripped characters is the interface writing SOMETHING that
    // shows nothing. `null` and "" are the interface CLEARING the region, which
    // the schema documents as a value an exporter should record, and which is
    // ordinary: a status is emptied once the operation it described is over,
    // and a region is commonly cleared before the next message goes into it.
    // Reporting that at error severity was a finding raised on correct input.
    for (const [name, value] of [['null', null], ['the empty string', '']]) {
      await inner.test(`text of ${name}`, async () => {
        const report = await auditMutated((journey) => {
          stepNamed(journey, '03-fix-and-submit')
            .updates.find((update) => update.region === 'save-progress').text = value
        })
        assert.equal(report.status, 'pass')
        assert.deepEqual(ruleIds(report), [])
      })
    }
  })

  await t.test('an empty write the expectations wanted text from still fails', async () => {
    // What the rule above gives up, the expectations keep: a judgement about
    // what a step should have written belongs to the expectations document, and
    // an empty write where text was expected is still exit 1.
    const report = await auditMutated(
      (journey) => {
        stepNamed(journey, '02-submit-empty')
          .updates.find((update) => update.region === 'form-errors').text = ''
      },
    )
    assert.equal(report.status, 'fail')
    assert.ok(ruleIds(report).includes('expected-update-missing'))
    assert.ok(!ruleIds(report).includes('update-text-empty'))
  })
})

test('trim() would have passed the classes it does not know about, which is why it is not used', () => {
  // `trim` removes ECMAScript whitespace, which covers the newline and both of
  // the separators and nothing else. C0, DEL, C1 and the bidi controls sail
  // straight through it and then show nothing.
  const invisibleToTrim = CLASSES.filter(([name]) => !['newline', 'line separator', 'paragraph separator'].includes(name))
  assert.equal(invisibleToTrim.length, 7)
  for (const [name, character] of invisibleToTrim) {
    const value = character.repeat(4)
    assert.ok(value.trim().length > 0, `${name} survives trim()`)
    assert.equal(isRenderableString(value), false, `${name} must not count as text`)
  }
})

test('a long value is bounded rather than echoed whole', () => {
  const long = 'q'.repeat(5000)
  const out = sanitize(long)
  assert.equal(out.length, 200)
  assert.ok(out.endsWith('...'))
})

test('a LONG update is not an update that shows nothing', async (t) => {
  // The emptiness question and the length question are different, and merging
  // them produced a false accusation: an update past an internal cap was
  // reported as leaving the region showing nothing at all. Length here is
  // bounded by the document size limit and by nothing else.
  await t.test('update text of 2000 characters passes', async () => {
    const report = await auditMutated((journey) => {
      stepNamed(journey, '03-fix-and-submit')
        .updates.find((update) => update.region === 'save-progress').text = 'Saving your details. '.repeat(100)
    })
    assert.equal(report.status, 'pass')
    assert.equal(findingsFor(report, 'update-text-empty').length, 0)
  })

  await t.test('a long expected text still matches exactly', async () => {
    const long = 'Saving your details. '.repeat(100)
    const report = await auditMutated(
      (journey) => {
        stepNamed(journey, '03-fix-and-submit')
          .updates.find((update) => update.region === 'save-progress').text = long
      },
      {
        expectations: (expectations) => {
          const step = expectations.steps.find((entry) => entry.name === '03-fix-and-submit')
          step.expect.push({ region: 'save-progress', text: long })
        },
      },
    )
    assert.equal(report.status, 'pass')
  })

  await t.test('showsSomething separates the two questions directly', () => {
    assert.equal(showsSomething('x'.repeat(5000)), true)
    assert.equal(showsSomething('\u200e'.repeat(5000)), false)
    assert.equal(showsSomething(null), false)
    assert.equal(showsSomething(undefined), false)
    assert.equal(isRenderableString('x'.repeat(5000)), false, 'an identifier that long is still refused')
  })
})
