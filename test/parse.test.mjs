/**
 * The parse-failure helper, pinned against the five cases that have actually
 * leaked documents in this catalog.
 *
 * V8 reports a `JSON.parse` failure two ways, and one of them quotes the input
 * back. The branch ORDER is the whole guard: a helper that looks for `at
 * position \d+` first finds that phrase inside the quoted span whenever the
 * document itself contains it, and slices the document straight back out.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { parseFailureDetail } from '../src/index.mjs'
import { cleanExpectations, runCli } from './helpers.mjs'

function failureFor(document) {
  try {
    JSON.parse(document)
  } catch (error) {
    return { message: error.message, detail: parseFailureDetail(error) }
  }
  throw new Error('that document parsed')
}

test('a document whose own text reads "at position 1" is not sliced back out', () => {
  const { message, detail } = failureFor('at position 1')
  assert.match(message, /"at position 1"/u, 'guard: V8 really does quote this document')
  assert.equal(detail, "unexpected token 'a' at the start of the document")
  assert.ok(!detail.includes('at position 1'))
})

test('a document that is only a credential is never reproduced', () => {
  const { message, detail } = failureFor('AKIAIOSFODNN7EXAMPLE')
  assert.match(message, /AKIAIOSFODNN7EXAMPLE/u, 'guard: V8 really does quote this document')
  assert.ok(!detail.includes('AKIAIOSFODNN7EXAMPLE'))
  assert.equal(detail, "unexpected token 'A' at the start of the document")
})

test('a long document with a sensitive prefix is never reproduced', () => {
  const document = `password=hunter2&token=s3cr3t${'x'.repeat(400)}`
  const { message, detail } = failureFor(document)
  assert.match(message, /password=/u, 'guard: V8 really does quote the front of this document')
  assert.ok(!detail.includes('password'))
  assert.ok(!detail.includes('hunter2'))
  assert.ok(!detail.includes('s3cr3t'))
})

test('a quoted span containing a newline is still recognised (the dotAll flag)', () => {
  const { message, detail } = failureFor('secret\nvalue')
  assert.ok(message.includes('\n'), 'guard: the quoted span really does carry a newline')
  assert.ok(!detail.includes('secret'))
  assert.ok(!detail.includes('value'))
  assert.equal(detail, "unexpected token 's' at the start of the document")
})

test('the safe positional form still yields its position', () => {
  const { message, detail } = failureFor('{"alpha": 1,}')
  assert.ok(!message.includes('"{'), 'guard: this form does not quote the document')
  assert.match(detail, /at position \d+/u)
  assert.ok(!detail.includes('alpha'))
})

test('a quoted run taken from the middle of the document says so', () => {
  const { detail } = failureFor(`{"alpha": "${'y'.repeat(200)}", "beta": ZQXJVBMP7W}`)
  assert.equal(detail, "unexpected token 'Z' inside the document")
  assert.ok(!detail.includes('ZQXJVBMP7W'))
  assert.ok(!detail.includes('alpha'))
})

test('the backstop catches a wording the branches have never been taught', () => {
  // Any surviving double quote means a snippet survived, whatever the branches
  // concluded. This is what makes the helper safe against a future V8 wording.
  assert.equal(
    parseFailureDetail({ message: 'Some future wording about "SECRET-VALUE" at position 4' }),
    'the document could not be parsed as JSON',
  )
})

test('the shapes that carry no document are passed through', () => {
  assert.equal(parseFailureDetail({ message: 'Unexpected end of JSON input' }), 'Unexpected end of JSON input')
  assert.equal(parseFailureDetail({}), 'the document could not be parsed as JSON')
  assert.equal(parseFailureDetail(null), 'the document could not be parsed as JSON')
})

test('a recording that is only a credential does not reach stdout or stderr', async () => {
  const result = await runCli('AKIAIOSFODNN7EXAMPLE', await cleanExpectations())
  assert.equal(result.code, 2)
  assert.ok(!result.stdout.includes('AKIAIOSFODNN7EXAMPLE'))
  assert.ok(!result.stderr.includes('AKIAIOSFODNN7EXAMPLE'))
  assert.equal(JSON.parse(result.stdout).findings[0].ruleId, 'journey-unparsable')
})

test('an expectations document that is only a credential does not reach stderr', async () => {
  const result = await runCli('{}', 'AKIAIOSFODNN7EXAMPLE')
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '', 'a policy failure means the run never had a subject')
  assert.ok(!result.stderr.includes('AKIAIOSFODNN7EXAMPLE'))
  assert.match(result.stderr, /not valid JSON/u)
})
