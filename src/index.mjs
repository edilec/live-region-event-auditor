/**
 * live-region-event-auditor
 *
 * Read a recording of the changes a journey made to the live regions of a
 * document, and an expectations document, then report repeated updates, updates
 * the expectations wanted and the recording does not hold, and regions whose
 * urgency is not the urgency the expectations declare.
 *
 * Three rules govern the design, and they matter more than the checks:
 *
 * 1. A RECORDED UPDATE IS NOT AN ANNOUNCEMENT. This tool opens no browser,
 *    resolves no host, replays nothing and runs no assistive technology. It
 *    reads a document describing changes to elements. Whether any of those
 *    changes reached a person, in what order, or whether one interrupted
 *    another, is not in this evidence -- that needs somebody who listened, and
 *    the tool will not accept an expectation that asks it to judge it.
 * 2. UNKNOWN IS NEVER A PASS. A region whose urgency cannot be determined from
 *    the markup it records, an update whose text or time nobody wrote down, a
 *    step the expectations name and the recording never reached: each marks the
 *    run incomplete and exits 2. None of them satisfies a check.
 * 3. ABSENCE IS ONLY EVIDENCE WHEN THE RECORDING IS COMPLETE. When the exporter
 *    declares the recording partial, lists a subtree it could not observe, or a
 *    step went past the per-step limit, a missing update becomes a gap rather
 *    than a defect. Evidence dropped while building the record of what happened
 *    makes the comparison incomplete, not clean.
 *
 * The expectations document is the policy: a problem with it means the run
 * never had a subject, so stdout stays empty and the process exits 2. The
 * recording is the evidence: a problem with it is a finding inside an
 * `incomplete` report, because a consumer needs to know which part of the
 * journey was not established.
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import { ageChecks, buildIndex, checkJourney } from './checks.mjs'
import {
  ConfigError,
  DEFAULT_LIMITS,
  LIMIT_NAMES,
  MAX_POLICY_BYTES,
  POLICY_SCHEMA_VERSION,
  POLITENESS_VALUES,
  REFUSED_POLICY_KEYS,
  validatePolicy,
} from './policy.mjs'
import {
  EVIDENCE_MISSING_RULES,
  LINE_SEPARATORS,
  RULE_IDS,
  RULE_SEVERITY,
  at,
  makeFinding,
  marksEvidenceMissing,
  msg,
  parseFailureDetail,
  sanitize,
  severityFor,
  sortFindings,
  statusFor,
} from './rules.mjs'
import {
  JOURNEY_SCHEMA_VERSION,
  KNOWN_ROLES,
  RECORDING_STATES,
  ROLE_POLITENESS,
  SUPPORTED_SOURCE,
  UNREADABLE_REASONS,
  pointerFor,
  readJourney,
} from './journey.mjs'

export { MAX_DUPLICATE_FINDINGS, ageChecks, buildIndex, checkJourney } from './checks.mjs'
export {
  ConfigError,
  DEFAULT_LIMITS,
  LIMIT_NAMES,
  MAX_POLICY_BYTES,
  POLICY_SCHEMA_VERSION,
  POLITENESS_VALUES,
  REFUSED_POLICY_KEYS,
  isRecord,
  parseInstant,
  validatePolicy,
} from './policy.mjs'
export {
  EVIDENCE_LIMIT,
  EVIDENCE_MISSING_RULES,
  FORBIDDEN_CLAIMS,
  LINE_SEPARATORS,
  MAX_ID_LENGTH,
  RULE_IDS,
  RULE_SEVERITY,
  SEVERITIES,
  SafeMessage,
  assertNoForbiddenClaim,
  at,
  byCodeUnit,
  compareFindings,
  describeValue,
  findForbiddenClaim,
  isRenderableString,
  makeFinding,
  marksEvidenceMissing,
  msg,
  num,
  parseFailureDetail,
  pointerToken,
  sanitize,
  severityFor,
  showsSomething,
  sortFindings,
  statusFor,
} from './rules.mjs'
export {
  JOURNEY_SCHEMA_VERSION,
  KNOWN_ROLES,
  RECORDING_STATES,
  ROLE_POLITENESS,
  SUPPORTED_SOURCE,
  UNREADABLE_REASONS,
  effectivePoliteness,
  pointerFor,
  readJourney,
  readRegion,
  readUpdate,
} from './journey.mjs'

export const TOOL_ID = 'live-region-event-auditor'
export const REPORT_SCHEMA_VERSION = '1'

/**
 * Printed in every report, whatever the verdict.
 *
 * It is a top-level string rather than a finding because it is true of the run
 * as a whole. A consumer reading only the findings should still be told what
 * kind of evidence produced them, and what no amount of this evidence settles.
 */
export const DISCLAIMER =
  'This report describes a recording of changes to elements, supplied to this tool. It opens no browser, resolves '
  + 'no host and replays nothing: every result here is a statement about what the recording says changed. It runs no '
  + 'assistive technology, so what any of these updates sounded like, in what order, or whether one interrupted '
  + 'another, is not established by this run and needs separate manual evidence from somebody who listened.'

/** The questions this evidence cannot settle, named in the report itself. */
export const NOT_ESTABLISHED = Object.freeze([
  'what assistive technology said, in what order, or whether one update interrupted another',
  'whether a recorded update was conveyed to anybody at all',
  'whether the text of an update is understandable or useful',
  'anything inside a subtree the recording says it could not observe',
  'anything that happened between the steps the recording holds',
])

/**
 * What a person still has to check by listening, carried in every report.
 *
 * This list is not a disclaimer about the tool; it is the handover. The tool
 * establishes the left-hand side of each of these and somebody else has to
 * establish the right.
 */
export const MANUAL_EVIDENCE_REQUIRED = Object.freeze([
  'that each update the recording holds is conveyed at all, with the assistive technology the audience uses',
  'that an assertive update really does interrupt, and a polite one really does wait',
  'that two updates close together are not merged, truncated or dropped in practice',
])

/**
 * Read a file as UTF-8, strictly.
 *
 * `fatal: true` is the point: a file whose bytes are not UTF-8 is reported as
 * undecodable, and encoding validity is never inferred from decoded text. A
 * document that legitimately contains U+FFFD is evidence of nothing. The
 * expectations document goes through the same path, because a policy file that
 * quietly accepts broken bytes is the same defect one directory over.
 */
export async function readTextBounded(file, maxBytes) {
  let info
  try {
    info = await stat(file)
  } catch (error) {
    return { status: 'unreadable', reason: error.code ?? 'unknown error', text: null }
  }
  if (!info.isFile()) return { status: 'unreadable', reason: 'not a regular file', text: null }
  if (info.size > maxBytes) {
    return { status: 'too-large', reason: `${info.size} bytes exceeds the ${maxBytes} byte limit`, text: null }
  }
  let bytes
  try {
    bytes = await readFile(file)
  } catch (error) {
    return { status: 'unreadable', reason: error.code ?? 'unknown error', text: null }
  }
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { status: 'not-utf8', reason: 'the bytes are not valid UTF-8', text: null }
  }
  return { status: 'ok', reason: null, text }
}

/** Load and validate the expectations document. Every failure is a ConfigError. */
export async function loadPolicy(expectationsPath) {
  const absolute = resolve(process.cwd(), expectationsPath)
  const read = await readTextBounded(absolute, MAX_POLICY_BYTES)
  if (read.status !== 'ok') throw new ConfigError(`Could not load the expectations document: ${read.reason}`)
  let document
  try {
    document = JSON.parse(read.text)
  } catch (error) {
    // V8 quotes the document it choked on -- the whole file when the file is
    // short -- so the expectations document would reach stderr through its own
    // error message. `parseFailureDetail` keeps the position and discards the
    // quote; the sanitising pass stays, because every untrusted string gets one.
    throw new ConfigError(`The expectations document is not valid JSON: ${sanitize(parseFailureDetail(error), 200)}`)
  }
  return validatePolicy(document)
}

const EMPTY_COUNTS = Object.freeze({ checked: 0, regions: 0, steps: 0, updates: 0, duplicateUpdates: 0 })

export function buildReport(findings, counts) {
  const sorted = sortFindings(findings)
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status: statusFor(sorted),
    evidenceBasis: SUPPORTED_SOURCE,
    disclaimer: DISCLAIMER,
    notEstablished: [...NOT_ESTABLISHED],
    manualEvidenceRequired: [...MANUAL_EVIDENCE_REQUIRED],
    summary: {
      checked: counts.checked,
      errors: sorted.filter((finding) => finding.severity === 'error').length,
      warnings: sorted.filter((finding) => finding.severity === 'warning').length,
      info: sorted.filter((finding) => finding.severity === 'info').length,
      regions: counts.regions,
      steps: counts.steps,
      updates: counts.updates,
      duplicateUpdates: counts.duplicateUpdates,
    },
    findings: sorted,
  }
}

/**
 * Run one audit.
 *
 * Throws `ConfigError` when the run never had a subject. Everything that went
 * wrong with the evidence comes back inside the report.
 */
export async function auditJourney({ journey, expectations, now = Date.now() }) {
  const policy = await loadPolicy(expectations)
  const journeyPath = resolve(process.cwd(), journey)
  const file = sanitize(basename(journeyPath), 200)

  const read = await readTextBounded(journeyPath, policy.limits.maxJourneyBytes)
  if (read.status !== 'ok') {
    const ruleId = read.status === 'too-large'
      ? 'journey-too-large'
      : read.status === 'not-utf8' ? 'journey-not-utf8' : 'journey-unreadable'
    return buildReport([makeFinding(
      ruleId,
      msg`The recording was not read: ${read.reason}.`,
      at(file, null),
      {
        suggestion: read.status === 'too-large'
          ? 'Raise limits.maxJourneyBytes deliberately, or split the recording.'
          : 'Export the recording as UTF-8 JSON at the path given to --journey.',
      },
    )], EMPTY_COUNTS)
  }

  let document
  try {
    document = JSON.parse(read.text)
  } catch (error) {
    return buildReport([makeFinding(
      'journey-unparsable',
      msg`The recording is not valid JSON: ${parseFailureDetail(error)}.`,
      at(file, null),
      { suggestion: 'Correct the JSON. Nothing was read from this file.' },
    )], EMPTY_COUNTS)
  }

  const structure = readJourney(document)
  if (!structure.ok) {
    return buildReport([makeFinding(
      'journey-invalid',
      msg`The recording was not usable: ${structure.reason}. Nothing was checked.`,
      at(file, pointerFor()),
      { suggestion: 'Correct the recording against the shape the README documents.' },
    )], EMPTY_COUNTS)
  }

  const { findings, counts } = checkJourney({ journey: structure.journey, policy, file, now })
  return buildReport(findings, counts)
}

const SEPARATOR_PATTERN = new RegExp(`[${LINE_SEPARATORS}]`, 'gu')
const SEPARATOR_ESCAPES = new Map(
  [...LINE_SEPARATORS].map((character) => [
    character,
    `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`,
  ]),
)

/**
 * Serialise the report for stdout.
 *
 * `JSON.stringify` leaves U+2028 and U+2029 raw, and inside a JavaScript string
 * literal those two are line terminators. The payload parses as JSON either
 * way, but an identifier carrying one would break a consumer that evaluates the
 * payload as JavaScript, so both are escaped here as well as stripped upstream.
 */
export function renderReport(report) {
  const json = JSON.stringify(report, null, 2)
  return `${json.replace(SEPARATOR_PATTERN, (character) => SEPARATOR_ESCAPES.get(character))}\n`
}

export function exitCodeFor(report) {
  if (report.status === 'pass') return 0
  if (report.status === 'fail') return 1
  return 2
}

/** A human summary. It goes to stderr, because stdout carries only the report. */
export function formatSummary(report) {
  const lines = report.findings.map((finding) => {
    const where = [finding.location.file, finding.location.pointer]
      .filter((part) => part !== undefined && part !== '')
      .map((part) => sanitize(part, 200))
      .join(' ')
    return `${finding.severity.toUpperCase().padEnd(7)} ${sanitize(finding.ruleId, 40).padEnd(30)} ${where}`
  })
  lines.push('')
  lines.push(
    `${report.summary.regions} region(s) across ${report.summary.steps} step(s); `
    + `${report.summary.updates} update(s) recorded, ${report.summary.checked} checked, `
    + `${report.summary.duplicateUpdates} repeat(s).`,
  )
  lines.push(
    `${report.summary.errors} error, ${report.summary.warnings} warning, ${report.summary.info} info. `
    + `Status ${report.status}.`,
  )
  lines.push(report.disclaimer)
  return `${lines.join('\n')}\n`
}

/** Exported so the rule catalog and the limits can be asserted against the docs. */
export const CATALOG = Object.freeze({
  ruleIds: RULE_IDS,
  severity: RULE_SEVERITY,
  evidenceMissing: EVIDENCE_MISSING_RULES,
  limits: DEFAULT_LIMITS,
  limitNames: LIMIT_NAMES,
  politenessValues: POLITENESS_VALUES,
  rolePoliteness: ROLE_POLITENESS,
  knownRoles: KNOWN_ROLES,
  recordingStates: RECORDING_STATES,
  unreadableReasons: UNREADABLE_REASONS,
  refusedPolicyKeys: REFUSED_POLICY_KEYS,
  supportedSource: SUPPORTED_SOURCE,
  severityFor,
  marksEvidenceMissing,
  journeySchemaVersion: JOURNEY_SCHEMA_VERSION,
  policySchemaVersion: POLICY_SCHEMA_VERSION,
  reportSchemaVersion: REPORT_SCHEMA_VERSION,
})
