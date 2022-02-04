/**
 * The expectations document: the policy this tool checks a recording against.
 *
 * The policy is not evidence. A problem with it means the run never had a
 * subject, so it throws `ConfigError`, stdout stays empty and the process exits
 * 2 -- the shape the report contract reserves for a configuration error.
 *
 * Every expectation comes from here. There is no built-in opinion about which
 * regions a journey ought to have, how urgent any of them should be, or how
 * close two updates have to be to count as a repeat, so a team that
 * deliberately repeats a message is not argued with by a linter, and a policy
 * that omits a key it needs is refused rather than quietly defaulted.
 */

import { isRenderableString } from './rules.mjs'

export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

export const POLICY_SCHEMA_VERSION = '1'

/** The policy document is small; a megabyte of it is a mistake, not a policy. */
export const MAX_POLICY_BYTES = 262144

export const DEFAULT_LIMITS = Object.freeze({
  maxJourneyBytes: 4194304,
  maxRegions: 200,
  maxSteps: 500,
})

export const LIMIT_NAMES = Object.freeze(Object.keys(DEFAULT_LIMITS).sort())

/** The three values `aria-live` may take, and therefore the three a policy may expect. */
export const POLITENESS_VALUES = Object.freeze(['off', 'polite', 'assertive'])

/**
 * Keys this tool refuses rather than evaluates.
 *
 * Each names an outcome that only a person listening to assistive technology
 * can establish. This tool reads a recording of changes to elements: it can say
 * that a region was updated twice with the same text, and it cannot say what
 * anybody was told or in what order. A policy that asks it to judge that is a
 * configuration error -- refusing is the behaviour, because silently ignoring
 * the key would let a team believe an expectation was checked when nothing
 * checked it.
 */
export const REFUSED_POLICY_KEYS = Object.freeze([
  'announcedText',
  'announcementOrder',
  'expectAnnouncement',
  'expectSpoken',
  'heardBy',
  'screenReader',
  'screenReaderOutput',
  'spokenText',
])

const KNOWN_KEYS = Object.freeze([
  'schemaVersion',
  'duplicateWindowMs',
  'maxUpdatesPerStep',
  'regions',
  'steps',
  'maxRecordingAgeDays',
  'limits',
])

const KNOWN_STEP_KEYS = Object.freeze(['name', 'exhaustive', 'expect'])

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireInteger(value, key, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(`"${key}" must be a whole number between ${min} and ${max}.`)
  }
  return value
}

/**
 * Validate the expectations document.
 *
 * Unknown keys are rejected, at the top level and inside each step. A
 * one-character typo in `exhaustive` must not turn a real failure into a green
 * run, which is exactly what an ignored key does.
 */
export function validatePolicy(document) {
  if (!isRecord(document)) throw new ConfigError('The expectations document must be a JSON object.')
  if (document.schemaVersion !== POLICY_SCHEMA_VERSION) {
    throw new ConfigError(`The expectations document must declare "schemaVersion": "${POLICY_SCHEMA_VERSION}".`)
  }

  for (const key of REFUSED_POLICY_KEYS) {
    if (Object.hasOwn(document, key)) {
      throw new ConfigError(
        `"${key}" cannot be checked from a recording of element changes. This tool reads what `
        + `changed in the document: it can establish that a region was updated, and it cannot `
        + `establish what assistive technology conveyed to a person, in what order, or whether `
        + `it interrupted. That needs separate manual evidence, recorded by somebody who `
        + `listened. Remove the key.`,
      )
    }
  }

  const unknown = Object.keys(document).filter((key) => !KNOWN_KEYS.includes(key)).sort()
  if (unknown.length > 0) {
    throw new ConfigError(
      `Unknown expectation key(s): ${unknown.join(', ')}. Known keys: ${[...KNOWN_KEYS].sort().join(', ')}.`,
    )
  }

  const duplicateWindowMs = requireInteger(document.duplicateWindowMs, 'duplicateWindowMs', { max: 3600000 })
  const maxUpdatesPerStep = requireInteger(document.maxUpdatesPerStep, 'maxUpdatesPerStep', { min: 1, max: 10000 })

  if (!isRecord(document.regions)) throw new ConfigError('"regions" must be a JSON object keyed by region id.')
  const regions = new Map()
  for (const [regionId, expectation] of Object.entries(document.regions)) {
    if (!isRenderableString(regionId, 128)) {
      throw new ConfigError('A key in "regions" is not a usable region id.')
    }
    if (!isRecord(expectation)) throw new ConfigError(`"regions.${regionId}" must be a JSON object.`)
    const extra = Object.keys(expectation).filter((key) => key !== 'politeness').sort()
    if (extra.length > 0) {
      throw new ConfigError(`"regions.${regionId}" has unknown key(s): ${extra.join(', ')}. Known key: politeness.`)
    }
    if (!POLITENESS_VALUES.includes(expectation.politeness)) {
      throw new ConfigError(
        `"regions.${regionId}.politeness" must be one of: ${POLITENESS_VALUES.join(', ')}.`,
      )
    }
    regions.set(regionId, { politeness: expectation.politeness })
  }

  if (!Array.isArray(document.steps)) throw new ConfigError('"steps" must be an array.')
  const steps = []
  const seenSteps = new Set()
  for (const raw of document.steps) {
    if (!isRecord(raw)) throw new ConfigError('A step in "steps" is not a JSON object.')
    const extra = Object.keys(raw).filter((key) => !KNOWN_STEP_KEYS.includes(key)).sort()
    if (extra.length > 0) {
      throw new ConfigError(`A step has unknown key(s): ${extra.join(', ')}. Known keys: ${KNOWN_STEP_KEYS.join(', ')}.`)
    }
    if (!isRenderableString(raw.name, 128)) throw new ConfigError('A step has no usable "name".')
    if (seenSteps.has(raw.name)) throw new ConfigError(`"steps" names ${raw.name} more than once.`)
    seenSteps.add(raw.name)
    if (Object.hasOwn(raw, 'exhaustive') && typeof raw.exhaustive !== 'boolean') {
      throw new ConfigError(`"steps.${raw.name}.exhaustive" must be true or false.`)
    }
    if (!Array.isArray(raw.expect)) throw new ConfigError(`"steps.${raw.name}.expect" must be an array.`)
    const expect = []
    for (const entry of raw.expect) {
      if (!isRecord(entry)) throw new ConfigError(`An expectation in step ${raw.name} is not a JSON object.`)
      const extraKeys = Object.keys(entry).filter((key) => !['region', 'text'].includes(key)).sort()
      if (extraKeys.length > 0) {
        throw new ConfigError(
          `An expectation in step ${raw.name} has unknown key(s): ${extraKeys.join(', ')}. Known keys: region, text.`,
        )
      }
      if (!isRenderableString(entry.region, 128)) {
        throw new ConfigError(`An expectation in step ${raw.name} has no usable "region".`)
      }
      if (Object.hasOwn(entry, 'text') && typeof entry.text !== 'string') {
        throw new ConfigError(`An expectation in step ${raw.name} has a "text" that is not a string.`)
      }
      expect.push({ region: entry.region, text: Object.hasOwn(entry, 'text') ? entry.text : null })
    }
    steps.push({ name: raw.name, exhaustive: raw.exhaustive === true, expect })
  }

  // A policy that expects nothing about any region and names no step would run
  // green over any recording at all. That is a vacuous check, not a permissive
  // one, so it is refused rather than reported as a pass.
  if (regions.size === 0 && steps.length === 0) {
    throw new ConfigError(
      'The expectations document states nothing to check: "regions" is empty and "steps" is empty. '
      + 'Expect a politeness for at least one region, or name at least one step.',
    )
  }

  let maxRecordingAgeDays = null
  if (document.maxRecordingAgeDays !== undefined) {
    maxRecordingAgeDays = requireInteger(document.maxRecordingAgeDays, 'maxRecordingAgeDays', { min: 1, max: 36500 })
  }

  const limits = { ...DEFAULT_LIMITS }
  if (document.limits !== undefined) {
    if (!isRecord(document.limits)) throw new ConfigError('"limits" must be a JSON object.')
    const unknownLimits = Object.keys(document.limits).filter((key) => !Object.hasOwn(DEFAULT_LIMITS, key)).sort()
    if (unknownLimits.length > 0) {
      throw new ConfigError(
        `Unknown limit(s): ${unknownLimits.join(', ')}. Known limits: ${LIMIT_NAMES.join(', ')}.`,
      )
    }
    for (const key of LIMIT_NAMES) {
      if (document.limits[key] === undefined) continue
      limits[key] = requireInteger(document.limits[key], `limits.${key}`, { min: 1, max: 1073741824 })
    }
  }

  return Object.freeze({
    duplicateWindowMs,
    maxUpdatesPerStep,
    regions,
    steps,
    maxRecordingAgeDays,
    limits: Object.freeze(limits),
  })
}

/**
 * A strict instant parser, so `--now` and `recordedAt` mean the same thing.
 *
 * `Date.parse` accepts implementation-defined formats and silently reinterprets
 * others, which makes a staleness verdict depend on the Node build. Two
 * explicit shapes are accepted and everything else is refused.
 */
export function parseInstant(value) {
  if (!isRenderableString(value, 40)) return { ok: false, ms: null }
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  const full = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/u.exec(value)
  const parts = full ?? dateOnly
  if (parts === null) return { ok: false, ms: null }
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])]
  const [hour, minute, second] = full === null
    ? [0, 0, 0]
    : [Number(parts[4]), Number(parts[5]), Number(parts[6])]
  if (month < 1 || month > 12 || day < 1 || day > 31) return { ok: false, ms: null }
  if (hour > 23 || minute > 59 || second > 59) return { ok: false, ms: null }
  const ms = Date.UTC(year, month - 1, day, hour, minute, second)
  const back = new Date(ms)
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
    return { ok: false, ms: null }
  }
  return { ok: true, ms }
}
