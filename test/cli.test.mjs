/**
 * The CLI surface and the two shapes of exit 2.
 *
 * | Situation                                | stdout      | exit |
 * | ---------------------------------------- | ----------- | ---: |
 * | invalid configuration, unknown option    | EMPTY       |    2 |
 * | input that could not be read or parsed   | a report    |    2 |
 *
 * A consumer piping stdout has to handle the empty case, so it is asserted
 * rather than assumed.
 */

import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { cleanExpectations, cleanJourney, runCli, runCliRaw } from './helpers.mjs'

test('--help explains the tool on stderr and exits 0', async () => {
  for (const flag of ['--help', '-h']) {
    const result = await runCliRaw([flag])
    assert.equal(result.code, 0, flag)
    assert.equal(result.stdout, '', 'stdout carries the report and nothing else')
    assert.match(result.stderr, /live-region-event-auditor/u)
    assert.match(result.stderr, /Exit codes:/u)
    assert.match(result.stderr, /opens no browser/u)
    assert.match(result.stderr, /UPDATES, never announcements/u)
    assert.match(result.stderr, /writes no file/u)
  }
})

test('an unknown option is a configuration error: exit 2 with EMPTY stdout', async () => {
  const result = await runCliRaw(['--journey', 'a.json', '--expectations', 'b.json', '--verbose'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Unknown option "--verbose"/u)
})

test('a missing required path is a configuration error', async () => {
  for (const argv of [[], ['--journey', 'a.json'], ['--expectations', 'b.json']]) {
    const result = await runCliRaw(argv)
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /is required/u)
  }
})

test('an option given without a value is refused', async () => {
  const result = await runCliRaw(['--journey', '--expectations', 'b.json'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--journey requires a value/u)
})

test('--now refuses a shape the tool was not taught', async () => {
  const result = await runCliRaw(['--journey', 'a.json', '--expectations', 'b.json', '--now', 'yesterday'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--now requires YYYY-MM-DD/u)
})

test('stdout is JSON and nothing else, and the summary goes to stderr', async () => {
  const result = await runCli(await cleanJourney(), await cleanExpectations())
  assert.equal(result.code, 0)
  const report = JSON.parse(result.stdout)
  assert.equal(report.tool, 'live-region-event-auditor')
  assert.equal(report.schemaVersion, '1')
  assert.match(result.stderr, /update\(s\) recorded/u)
  assert.match(result.stderr, /repeat\(s\)/u)
  assert.match(result.stderr, /Status pass/u)
})

test('--json suppresses the human summary and leaves stdout untouched', async () => {
  const withSummary = await runCli(await cleanJourney(), await cleanExpectations())
  const quiet = await runCli(await cleanJourney(), await cleanExpectations(), ['--now', '2026-09-18', '--json'])
  assert.equal(quiet.stderr, '')
  assert.equal(quiet.stdout, withSummary.stdout)
})

test('two runs over identical inputs produce byte-identical stdout', async () => {
  const journey = await cleanJourney()
  journey.capture.recording = 'partial'
  journey.regions[0].ariaLive = 'assertive'
  const first = await runCli(journey, await cleanExpectations(), ['--now', '2026-09-18', '--json'])
  const second = await runCli(journey, await cleanExpectations(), ['--now', '2026-09-18', '--json'])
  assert.equal(first.stdout, second.stdout)
  assert.equal(first.code, 2)
})

test('an unreadable expectations path is a configuration error, not a report', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lrea-cli-'))
  const journeyPath = join(directory, 'journey.json')
  await writeFile(journeyPath, JSON.stringify(await cleanJourney()))
  const result = await runCliRaw([
    '--journey', journeyPath,
    '--expectations', join(directory, 'missing.json'),
  ])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '', 'the run never had a policy, so it never had a subject')
  assert.match(result.stderr, /Could not load the expectations document/u)
})

test('an unreadable journey path IS a report, because the run had a subject', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lrea-cli2-'))
  const expectationsPath = join(directory, 'expectations.json')
  await writeFile(expectationsPath, JSON.stringify(await cleanExpectations()))
  const result = await runCliRaw([
    '--journey', join(directory, 'missing.json'),
    '--expectations', expectationsPath,
  ])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.findings[0].ruleId, 'journey-unreadable')
  assert.equal(report.findings[0].location.file, 'missing.json', 'never an absolute host path')
})

test('the shipped examples run exactly as the README says they do', async () => {
  const clean = await runCliRaw([
    '--journey', 'examples/clean/journey.json',
    '--expectations', 'examples/clean/expectations.json',
    '--now', '2026-09-18',
  ])
  assert.equal(clean.code, 0)
  assert.equal(JSON.parse(clean.stdout).status, 'pass')

  const broken = await runCliRaw([
    '--journey', 'examples/broken/journey.json',
    '--expectations', 'examples/broken/expectations.json',
    '--now', '2026-09-18',
  ])
  assert.equal(broken.code, 1)
  const report = JSON.parse(broken.stdout)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.duplicateUpdates, 1)
  assert.deepEqual(
    [...new Set(report.findings.map((finding) => finding.ruleId))].sort(),
    [
      'duplicate-update',
      'expected-update-missing',
      'politeness-mismatch',
      'region-created-with-content',
    ],
  )
})
