import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { auditJourney } from '../src/index.mjs'

const run = promisify(execFile)

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const BIN = join(ROOT, 'bin', 'live-region-event-auditor.mjs')
export const NOW = Date.UTC(2026, 8, 18)

/**
 * The clean example is the base fixture for almost every test.
 *
 * Reading it rather than repeating it here means every test also proves the
 * shipped example still parses, and a change to the documented shape cannot
 * leave the example behind.
 */
export async function cleanJourney() {
  return JSON.parse(await readFile(join(ROOT, 'examples', 'clean', 'journey.json'), 'utf8'))
}

export async function cleanExpectations() {
  return JSON.parse(await readFile(join(ROOT, 'examples', 'clean', 'expectations.json'), 'utf8'))
}

export function stepNamed(journey, name) {
  const step = journey.steps.find((entry) => entry.name === name)
  if (step === undefined) throw new Error(`no step named ${name}`)
  return step
}

export function stepExpectation(expectations, name) {
  const step = expectations.steps.find((entry) => entry.name === name)
  if (step === undefined) throw new Error(`no step expectation named ${name}`)
  return step
}

export function regionNamed(journey, id) {
  const region = journey.regions.find((entry) => entry.id === id)
  if (region === undefined) throw new Error(`no region ${id}`)
  return region
}

async function writeInputs(journey, expectations) {
  const directory = await mkdtemp(join(tmpdir(), 'lrea-'))
  const journeyPath = join(directory, 'journey.json')
  const expectationsPath = join(directory, 'expectations.json')
  await writeFile(
    journeyPath,
    typeof journey === 'string' ? journey : `${JSON.stringify(journey, null, 2)}\n`,
  )
  await writeFile(
    expectationsPath,
    typeof expectations === 'string' ? expectations : `${JSON.stringify(expectations, null, 2)}\n`,
  )
  return { directory, journeyPath, expectationsPath }
}

/** Build a recording from the clean example with `mutate` applied, then audit it. */
export async function auditMutated(mutate, { expectations: mutateExpectations = null, now = NOW } = {}) {
  const journey = await cleanJourney()
  const expectations = await cleanExpectations()
  if (mutate !== null) mutate(journey)
  if (mutateExpectations !== null) mutateExpectations(expectations)
  const { journeyPath, expectationsPath } = await writeInputs(journey, expectations)
  return auditJourney({ journey: journeyPath, expectations: expectationsPath, now })
}

/** Run the real CLI, so exit codes and stream discipline are observed, not asserted about. */
export async function runCli(journey, expectations, extra = ['--now', '2026-09-18']) {
  const { journeyPath, expectationsPath } = await writeInputs(journey, expectations)
  const argv = ['--journey', journeyPath, '--expectations', expectationsPath, ...extra]
  return runCliRaw(argv)
}

export async function runCliRaw(argv) {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...argv], { encoding: 'utf8' })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

export function ruleIds(report) {
  return report.findings.map((finding) => finding.ruleId)
}

export function findingsFor(report, ruleId) {
  return report.findings.filter((finding) => finding.ruleId === ruleId)
}
