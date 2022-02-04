/**
 * Reading the journey recording.
 *
 * The recording is EVIDENCE, not policy, so nothing here throws. A document
 * that could not be read produces findings inside an `incomplete` report,
 * because a consumer needs to know which part of the journey was not
 * established.
 *
 * The same distinction as elsewhere in this catalog runs through the schema:
 * ABSENT IS NOT NOT-CAPTURED.
 *
 *   "ariaLive": null   the exporter looked, and the attribute was not there
 *   key omitted        the exporter did not record it
 *
 * The first is evidence and can decide a check. The second is a gap and makes
 * the run incomplete.
 */

import { MAX_ID_LENGTH, isRenderableString, pointerToken } from './rules.mjs'
import { isRecord } from './policy.mjs'

export const JOURNEY_SCHEMA_VERSION = '1'

/**
 * The only evidence kind this tool reads.
 *
 * Its rules are written about changes to elements in a document. A screen
 * recording, a transcript of what somebody heard, or a video is a different
 * kind of evidence, and reinterpreting one as the other is exactly the
 * overclaim this tool exists not to make, so an unexpected source is refused
 * rather than treated as a recording of DOM changes.
 */
export const SUPPORTED_SOURCE = 'dom-mutation-record'

export const RECORDING_STATES = Object.freeze(['complete', 'partial'])

/** Reasons an exporter may give for a subtree it could not observe. */
export const UNREADABLE_REASONS = Object.freeze([
  'shadow-root',
  'closed-shadow-root',
  'cross-origin-iframe',
  'not-observable',
  'access-denied',
])

/**
 * The implicit urgency of the roles this tool knows.
 *
 * This is a fixed, deliberately small table, not an implementation of ARIA's
 * implicit semantics. A role outside it leaves the urgency undetermined, which
 * makes the run incomplete rather than assuming a default -- an assumed default
 * is the difference between "this region is polite" and "nobody said".
 */
export const ROLE_POLITENESS = Object.freeze({
  alert: 'assertive',
  log: 'polite',
  marquee: 'off',
  progressbar: 'polite',
  status: 'polite',
  timer: 'off',
})

export const KNOWN_ROLES = Object.freeze(Object.keys(ROLE_POLITENESS).sort())

export function pointerFor(...segments) {
  return segments.length === 0 ? '' : `/${segments.map((segment) => pointerToken(segment)).join('/')}`
}

function id(value) {
  return isRenderableString(value, MAX_ID_LENGTH) ? value : null
}

/**
 * Work out what urgency a region actually has.
 *
 * `aria-live` wins when it is present, because it does in the platform too. A
 * value outside the three the attribute allows leaves the urgency undetermined:
 * this tool will not guess which one an implementation would fall back to, so
 * the check is reported as not made rather than made against an invention.
 */
export function effectivePoliteness(region) {
  if (region.ariaLive !== null) {
    if (['off', 'polite', 'assertive'].includes(region.ariaLive)) {
      return { ok: true, politeness: region.ariaLive, from: 'aria-live' }
    }
    return { ok: false, reason: 'invalid-value', politeness: null, from: 'aria-live' }
  }
  if (region.role !== null) {
    const implicit = ROLE_POLITENESS[region.role]
    if (implicit !== undefined) return { ok: true, politeness: implicit, from: `role=${region.role}` }
    return { ok: false, reason: 'unknown-role', politeness: null, from: `role=${region.role}` }
  }
  return { ok: false, reason: 'nothing-declared', politeness: null, from: null }
}

export function readRegion(raw) {
  if (!isRecord(raw)) return { ok: false, reason: 'the region record is not a JSON object' }
  const regionId = id(raw.id)
  if (regionId === null) return { ok: false, reason: 'the region has no usable "id"' }
  for (const key of ['role', 'ariaLive', 'presentAtStart']) {
    if (!Object.hasOwn(raw, key)) {
      return { ok: false, reason: `"${key}" is required; use null when the attribute was absent` }
    }
  }
  if (raw.role !== null && typeof raw.role !== 'string') {
    return { ok: false, reason: '"role" must be null or a string' }
  }
  if (raw.ariaLive !== null && typeof raw.ariaLive !== 'string') {
    return { ok: false, reason: '"ariaLive" must be null or a string' }
  }
  if (typeof raw.presentAtStart !== 'boolean') {
    return { ok: false, reason: '"presentAtStart" must be true or false' }
  }
  if (Object.hasOwn(raw, 'insertedAtStep') && raw.insertedAtStep !== null && id(raw.insertedAtStep) === null) {
    return { ok: false, reason: '"insertedAtStep" must be null or the name of a step' }
  }
  return {
    ok: true,
    region: {
      id: regionId,
      role: raw.role,
      ariaLive: raw.ariaLive,
      presentAtStart: raw.presentAtStart,
      insertionCaptured: Object.hasOwn(raw, 'insertedAtStep'),
      insertedAtStep: Object.hasOwn(raw, 'insertedAtStep') ? raw.insertedAtStep : null,
    },
  }
}

export function readUpdate(raw) {
  if (!isRecord(raw)) return { ok: false, reason: 'the update record is not a JSON object' }
  const region = id(raw.region)
  if (region === null) return { ok: false, reason: 'the update has no usable "region"' }
  if (Object.hasOwn(raw, 'text') && raw.text !== null && typeof raw.text !== 'string') {
    return { ok: false, reason: '"text" must be null or a string' }
  }
  if (Object.hasOwn(raw, 'atMs') && (!Number.isSafeInteger(raw.atMs) || raw.atMs < 0)) {
    return { ok: false, reason: '"atMs" must be a whole number of milliseconds, at least 0' }
  }
  return {
    ok: true,
    update: {
      region,
      textCaptured: Object.hasOwn(raw, 'text'),
      text: Object.hasOwn(raw, 'text') ? raw.text : null,
      timeCaptured: Object.hasOwn(raw, 'atMs'),
      atMs: Object.hasOwn(raw, 'atMs') ? raw.atMs : null,
    },
  }
}

/**
 * Read the top-level document.
 *
 * Returns `{ ok: false, reason }` when the document cannot be used at all, and
 * otherwise the parsed shape with the per-record arrays left raw, so the caller
 * can report each unreadable record rather than dropping it.
 */
export function readJourney(document) {
  if (!isRecord(document)) return { ok: false, reason: 'the recording is not a JSON object' }
  if (document.schemaVersion !== JOURNEY_SCHEMA_VERSION) {
    return { ok: false, reason: `the recording must declare "schemaVersion": "${JOURNEY_SCHEMA_VERSION}"` }
  }
  if (!isRecord(document.capture)) return { ok: false, reason: 'the recording must record a "capture" object' }
  const captureId = id(document.capture.id)
  if (captureId === null) return { ok: false, reason: '"capture.id" is missing or unusable' }
  if (!RECORDING_STATES.includes(document.capture.recording)) {
    return { ok: false, reason: `"capture.recording" must be one of: ${RECORDING_STATES.join(', ')}` }
  }
  if (!Array.isArray(document.regions)) return { ok: false, reason: '"regions" must be an array' }
  if (!Array.isArray(document.steps)) return { ok: false, reason: '"steps" must be an array' }

  const unreadable = []
  if (Object.hasOwn(document, 'unreadableRegions')) {
    if (!Array.isArray(document.unreadableRegions) || document.unreadableRegions.length > 200) {
      return { ok: false, reason: '"unreadableRegions" must be an array of at most 200 entries' }
    }
    for (const entry of document.unreadableRegions) {
      if (!isRecord(entry)) return { ok: false, reason: 'an unreadable region is not a JSON object' }
      const hostId = id(entry.hostId)
      if (hostId === null) return { ok: false, reason: 'an unreadable region has no usable "hostId"' }
      if (!UNREADABLE_REASONS.includes(entry.reason)) {
        return { ok: false, reason: `an unreadable region must give a "reason" from: ${UNREADABLE_REASONS.join(', ')}` }
      }
      unreadable.push({ hostId, reason: entry.reason })
    }
  }

  const steps = []
  for (const [index, raw] of document.steps.entries()) {
    if (!isRecord(raw)) return { ok: false, reason: `step ${index} is not a JSON object` }
    const name = id(raw.name)
    if (name === null) return { ok: false, reason: `step ${index} has no usable "name"` }
    if (!Array.isArray(raw.updates)) return { ok: false, reason: `step "${name}" must record an "updates" array` }
    steps.push({ name, index, rawUpdates: raw.updates })
  }

  return {
    ok: true,
    journey: {
      capture: {
        id: captureId,
        source: document.capture.source,
        recording: document.capture.recording,
        recordedAt: Object.hasOwn(document.capture, 'recordedAt') ? document.capture.recordedAt : null,
      },
      unreadableRegions: unreadable,
      rawRegions: document.regions,
      steps,
    },
  }
}
