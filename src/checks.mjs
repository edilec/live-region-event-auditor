/**
 * The checks themselves.
 *
 * Two ideas decide almost every branch in this file.
 *
 * A RECORDED UPDATE IS NOT AN ANNOUNCEMENT. Everything here is a statement
 * about changes to elements: this region was updated twice with the same text
 * inside the window the expectations set; this region resolves to `assertive`
 * where the expectations say `polite`. Whether any of it reached a person, in
 * what order, or whether it interrupted something else, is not in this evidence
 * and no finding may be phrased as though it were.
 *
 * A NEGATIVE CONCLUSION NEEDS A COMPLETE RECORDING. "This step contains no
 * update to that region" is only a statement about the journey when the
 * recording holds every update the journey produced. When the exporter declares
 * the recording partial, lists a subtree it could not observe, or the step blew
 * past the per-step limit, the same absence becomes `update-unverifiable`,
 * which marks the run incomplete, instead of `expected-update-missing`, which
 * fails it. Evidence dropped while building the record of what happened makes
 * the comparison incomplete; it does not make the comparison clean.
 */

import { at, byCodeUnit, makeFinding, msg, num, showsSomething } from './rules.mjs'
import {
  KNOWN_ROLES,
  SUPPORTED_SOURCE,
  effectivePoliteness,
  pointerFor,
  readRegion,
  readUpdate,
} from './journey.mjs'
import { parseInstant } from './policy.mjs'

const DAY_MS = 86400000

/**
 * How many repeats one run names one by one.
 *
 * A repeat is a PAIR, so the number of them is quadratic in how many times one
 * text was written to one region inside the window, while the recording itself
 * is only bounded by `limits.maxJourneyBytes`. The total is always counted
 * exactly; this bounds the enumeration, and exceeding it is reported rather
 * than truncated silently.
 */
export const MAX_DUPLICATE_FINDINGS = 1000

/**
 * Build the region index, and decide whether the recording can answer "that
 * did not happen".
 *
 * `complete` is deliberately conservative: a recording that declares itself
 * complete while listing a subtree it could not observe is contradicting
 * itself, and the unobserved subtree wins. Dropping a record -- a malformed
 * region, an ambiguous duplicate id -- has the same effect, because the index
 * no longer holds everything the journey had.
 */
export function buildIndex(journey, file, findings) {
  const byId = new Map()
  const duplicated = new Set()
  const regions = []
  const reasons = []

  for (const [index, raw] of journey.rawRegions.entries()) {
    const read = readRegion(raw)
    if (!read.ok) {
      findings.push(makeFinding(
        'region-invalid',
        msg`Region record ${num(index)} was not read: ${read.reason}. Nothing about that region was checked.`,
        at(file, pointerFor('regions', String(index))),
        { suggestion: 'Correct the region record, or leave it out of the recording deliberately.' },
      ))
      reasons.push('a region record could not be read')
      continue
    }
    regions.push(read.region)
  }

  for (const region of regions) {
    if (byId.has(region.id) || duplicated.has(region.id)) {
      duplicated.add(region.id)
      byId.delete(region.id)
      continue
    }
    byId.set(region.id, region)
  }

  for (const ambiguous of [...duplicated].sort(byCodeUnit)) {
    findings.push(makeFinding(
      'duplicate-region-id',
      msg`The region id ${ambiguous} is declared more than once, so which record describes it is ambiguous and neither was used.`,
      at(file, pointerFor('regions', ambiguous)),
      { suggestion: 'Declare each region once, as the document itself must give each element one id.' },
    ))
    reasons.push('a region id is declared more than once')
  }

  for (const region of [...journey.unreadableRegions].sort((a, b) => byCodeUnit(a.hostId, b.hostId))) {
    findings.push(makeFinding(
      'subtree-not-captured',
      msg`The subtree under ${region.hostId} was not observed (${region.reason}), so any update the journey made inside it is outside this evidence.`,
      at(file, pointerFor('unreadableRegions', region.hostId)),
      {
        evidence: `reason: ${region.reason}`,
        suggestion: 'Observe the subtree as part of the recording, or accept that this run establishes nothing about it.',
      },
    ))
    reasons.push(`the subtree under ${region.hostId} was not observed`)
  }

  const declaredPartial = journey.capture.recording === 'partial'
  if (declaredPartial) reasons.push('the recording declares "recording": "partial"')
  const complete = !declaredPartial && reasons.length === 0

  if (!complete) {
    findings.push(makeFinding(
      'recording-incomplete',
      msg`The recording does not hold every change this journey made, so an update that is not in it was not treated as an update that did not happen.`,
      at(file, pointerFor('capture', 'recording')),
      {
        evidence: [...new Set(reasons)].sort(byCodeUnit).join('; '),
        suggestion: 'Export a complete recording to have a missing update judged as a defect.',
      },
    ))
  }

  return { byId, regions: [...byId.values()], complete }
}

/** Staleness of the recording itself. Both outcomes mark the run incomplete. */
export function ageChecks(journey, policy, file, now, findings) {
  if (policy.maxRecordingAgeDays === null) return
  const where = at(file, pointerFor('capture', 'recordedAt'))
  const recorded = parseInstant(journey.capture.recordedAt)
  if (!recorded.ok) {
    findings.push(makeFinding(
      'journey-age-unknown',
      msg`The expectations set maxRecordingAgeDays but the recording has no usable "capture.recordedAt", so its age could not be established.`,
      where,
      { suggestion: 'Record recordedAt as YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ, or drop maxRecordingAgeDays.' },
    ))
    return
  }
  const ageDays = Math.floor((now - recorded.ms) / DAY_MS)
  if (ageDays > policy.maxRecordingAgeDays) {
    findings.push(makeFinding(
      'journey-stale',
      msg`The recording is ${num(ageDays)} day(s) old, past the ${num(policy.maxRecordingAgeDays)} day(s) the expectations allow, so it may not describe the journey as it is now.`,
      where,
      { suggestion: 'Record the journey again, or raise maxRecordingAgeDays deliberately.' },
    ))
  }
}

/**
 * Urgency, per region.
 *
 * `aria-live` wins over the role, a value the attribute does not allow leaves
 * the urgency undetermined rather than guessed, and a region with neither is
 * not a live region at all as far as this evidence goes. All three of those
 * outcomes are reported; none of them is a pass.
 */
function checkPoliteness(region, policy, file, findings) {
  const where = at(file, pointerFor('regions', region.id))
  const resolved = effectivePoliteness(region)

  if (!resolved.ok) {
    if (resolved.reason === 'invalid-value') {
      findings.push(makeFinding(
        'politeness-value-invalid',
        msg`Region ${region.id} declares aria-live as ${region.ariaLive}, which is not one of off, polite or assertive, so its urgency was not determined and no expectation about it was checked.`,
        where,
        { suggestion: 'Set aria-live to off, polite or assertive.' },
      ))
      return null
    }
    findings.push(makeFinding(
      'politeness-unknown',
      msg`Region ${region.id} declares ${resolved.from === null ? 'neither aria-live nor a role' : `no aria-live and the role ${region.role}`}, so its urgency was not determined and no expectation about it was checked.`,
      where,
      {
        evidence: `roles with a known urgency: ${KNOWN_ROLES.join(', ')}`,
        suggestion: 'Give the element an aria-live value, or one of the roles whose urgency is documented.',
      },
    ))
    return null
  }

  const expectation = policy.regions.get(region.id)
  if (expectation !== undefined && expectation.politeness !== resolved.politeness) {
    findings.push(makeFinding(
      'politeness-mismatch',
      msg`Region ${region.id} resolves to ${resolved.politeness} from ${resolved.from}, but the expectations declare ${expectation.politeness}.`,
      where,
      {
        evidence: `resolved from ${resolved.from}`,
        suggestion: 'Change the markup, or change the expectation deliberately.',
      },
    ))
  }
  return resolved.politeness
}

/**
 * Duplicate updates.
 *
 * Two updates count as a repeat when they name the same region, carry the same
 * text, and their recorded times are no further apart than the window the
 * expectations set. Both must have recorded a time: an update whose time nobody
 * wrote down cannot be placed inside or outside the window, so it is reported
 * as a gap rather than assumed to be outside it.
 *
 * The walk is over updates ORDERED BY RECORDED TIME, not by the order the
 * recording happened to list them in. Walking the file order was a real defect
 * here: a recording that listed a later update between two repeats reported no
 * repeat at all, because the two were no longer adjacent. The sort keys are
 * three integers -- the time, the step's position in the recording, and the
 * update's position in the step -- so no string comparison decides it.
 *
 * Time order alone was not enough, and that was the second defect: comparing
 * only TIME-ADJACENT pairs missed every repeat with different text in between,
 * which is the ordinary shape of a status region that cycles. A@1200,
 * B@1400, A@1600 inside a 1000ms window reported `duplicateUpdates: 0` and
 * exited 0. The rule the README states is a predicate over PAIRS, so the
 * comparison is over pairs: for each update, every earlier update to the same
 * region that is still inside the window. Entries are in non-decreasing time
 * order, so a two-pointer walk finds the first one inside the window and
 * everything from there to the current entry is in it.
 *
 * The count is exact whatever the recording holds -- it is `current - first`,
 * not the length of the enumeration. Listing the pairs is what is bounded: a
 * region written with one text n times inside the window holds n(n-1)/2 of
 * them, and a 4MiB recording can make that number enormous. Past
 * MAX_DUPLICATE_FINDINGS the pairs stop being named one by one and
 * `duplicate-enumeration-truncated` says so, which makes the run incomplete.
 * The contract's rule for a limit: never a silent truncation, and never a pass.
 */
function checkDuplicates(timeline, policy, file, findings) {
  const byRegion = new Map()
  for (const entry of timeline) {
    if (!entry.update.timeCaptured || !entry.update.textCaptured) continue
    if (!byRegion.has(entry.update.region)) byRegion.set(entry.update.region, [])
    byRegion.get(entry.update.region).push(entry)
  }
  for (const entries of byRegion.values()) {
    entries.sort((a, b) => (
      a.update.atMs - b.update.atMs
      || a.step.index - b.step.index
      || a.position - b.position
    ))
  }

  let repeats = 0
  let named = 0
  for (const regionId of [...byRegion.keys()].sort(byCodeUnit)) {
    // Grouped by text, so the window walk below compares only updates that are
    // already candidates. The groups keep the time order of the region's list.
    const byText = new Map()
    for (const entry of byRegion.get(regionId)) {
      if (!byText.has(entry.update.text)) byText.set(entry.update.text, [])
      byText.get(entry.update.text).push(entry)
    }

    for (const text of [...byText.keys()].sort(byCodeUnit)) {
      const group = byText.get(text)
      let first = 0
      for (let current = 1; current < group.length; current += 1) {
        while (group[current].update.atMs - group[first].update.atMs > policy.duplicateWindowMs) first += 1
        repeats += current - first
        if (named >= MAX_DUPLICATE_FINDINGS) continue
        for (let earlier = first; earlier < current; earlier += 1) {
          if (named >= MAX_DUPLICATE_FINDINGS) break
          named += 1
          const gap = group[current].update.atMs - group[earlier].update.atMs
          findings.push(makeFinding(
            'duplicate-update',
            msg`Region ${regionId} was updated with the same text twice ${num(gap)}ms apart, inside the ${num(policy.duplicateWindowMs)}ms window the expectations set: once in step ${group[earlier].step.name} and again in step ${group[current].step.name}.`,
            at(file, pointerFor('steps', group[current].step.name, 'updates', regionId)),
            {
              evidence: `gap ${num(gap)}ms, window ${num(policy.duplicateWindowMs)}ms`,
              suggestion: 'Write the region once per change, or change the text when the state really changed.',
            },
          ))
        }
      }
    }
  }

  if (named < repeats) {
    findings.push(makeFinding(
      'duplicate-enumeration-truncated',
      msg`This recording holds ${num(repeats)} repeat(s) and only the first ${num(named)} are named one by one; summary.duplicateUpdates counts every one of them, and the rest were not listed.`,
      at(file, pointerFor('steps')),
      {
        evidence: `named ${num(named)} of ${num(repeats)}`,
        suggestion: 'Narrow duplicateWindowMs, or split the recording, to have every repeat named individually.',
      },
    ))
  }
  return repeats
}

/**
 * Check one recording against one set of expectations.
 *
 * `now` is a parameter. A verdict that depends on an unrecorded clock reading is
 * not reproducible, and a staleness limit no test can reach is a documented
 * limit that is never enforced.
 */
export function checkJourney({ journey, policy, file, now }) {
  const findings = []
  const counts = { checked: 0, regions: 0, steps: 0, updates: 0, duplicateUpdates: 0 }

  if (journey.capture.source !== SUPPORTED_SOURCE) {
    findings.push(makeFinding(
      'capture-source-unsupported',
      msg`The capture declares its source as ${journey.capture.source === undefined ? 'nothing at all' : journey.capture.source}. The rules here are written about changes to elements in a document, so only a ${SUPPORTED_SOURCE} is checked; other evidence was not reinterpreted as one.`,
      at(file, pointerFor('capture', 'source')),
      { suggestion: `Export the evidence as a "${SUPPORTED_SOURCE}", or check it with a tool written for the evidence you have.` },
    ))
    return { findings, counts }
  }

  ageChecks(journey, policy, file, now, findings)

  const over = [
    ['region-limit-exceeded', journey.rawRegions.length, policy.limits.maxRegions, 'region', 'maxRegions'],
    ['step-limit-exceeded', journey.steps.length, policy.limits.maxSteps, 'step', 'maxSteps'],
  ].find(([, seen, limit]) => seen > limit)
  if (over !== undefined) {
    const [ruleId, seen, limit, what, limitName] = over
    findings.push(makeFinding(
      ruleId,
      msg`The recording holds ${num(seen)} ${what} record(s), over the limit of ${num(limit)}; nothing was checked.`,
      at(file, pointerFor(`${what}s`)),
      { suggestion: `Raise limits.${limitName} deliberately, or split the recording.` },
    ))
    return { findings, counts }
  }

  const index = buildIndex(journey, file, findings)
  counts.regions = index.regions.length
  counts.steps = journey.steps.length

  const politeness = new Map()
  for (const region of index.regions) {
    politeness.set(region.id, checkPoliteness(region, policy, file, findings))
  }

  for (const regionId of [...policy.regions.keys()].sort(byCodeUnit)) {
    if (index.byId.has(regionId)) continue
    findings.push(makeFinding(
      'expected-region-not-captured',
      msg`The expectations declare an urgency for region ${regionId}, which the recording does not describe, so that expectation was not checked.`,
      at(file, pointerFor('regions')),
      { suggestion: 'Record the region in the journey, or drop the expectation.' },
    ))
  }

  // Which regions the expectations say an update to is meant to carry
  // something, and which clause says so.
  //
  // `off` is a declaration, not a mistake. `aria-live="off"` says updates here
  // are not to be presented, and ARIA gives `role="timer"` and `role="marquee"`
  // that same implicit urgency -- a timer whose text never changes is not a
  // timer, and a countdown that ticks every second would have been a defect at
  // error severity, exit 1, on markup the specification describes. So writing
  // to an off region is not a defect on its own: it is a defect against
  // something the expectations SAY, and every judgement this tool makes comes
  // from the expectations. A region the expectations declare `off`, or say
  // nothing about at all, is the team's deliberate choice and is left alone.
  const expectedToCarry = new Map()
  for (const [regionId, expectation] of policy.regions) {
    if (expectation.politeness !== 'off') expectedToCarry.set(regionId, `regions.${regionId} expects ${expectation.politeness}`)
  }
  for (const expectation of policy.steps) {
    for (const entry of expectation.expect) {
      if (!expectedToCarry.has(entry.region)) {
        expectedToCarry.set(entry.region, `step ${expectation.name} expects an update to it`)
      }
    }
  }

  // Everything recorded, in one list. `checkDuplicates` orders it by recorded
  // time before walking it; nothing else depends on the order here.
  const timeline = []
  const stepsByName = new Map()
  const unusableSteps = new Set()

  for (const step of journey.steps) {
    if (stepsByName.has(step.name)) {
      findings.push(makeFinding(
        'step-invalid',
        msg`Step ${step.name} is recorded more than once, so which record describes it is ambiguous and neither was used.`,
        at(file, pointerFor('steps', step.name)),
        { suggestion: 'Give each step in the recording a distinct name.' },
      ))
      unusableSteps.add(step.name)
      continue
    }
    stepsByName.set(step.name, step)
    step.updates = []
    counts.updates += step.rawUpdates.length

    if (step.rawUpdates.length > policy.maxUpdatesPerStep) {
      findings.push(makeFinding(
        'step-update-limit-exceeded',
        msg`Step ${step.name} records ${num(step.rawUpdates.length)} update(s), over the limit of ${num(policy.maxUpdatesPerStep)}; nothing in that step was checked.`,
        at(file, pointerFor('steps', step.name)),
        { suggestion: 'Raise maxUpdatesPerStep deliberately, or write the region fewer times.' },
      ))
      unusableSteps.add(step.name)
      continue
    }

    for (const [position, raw] of step.rawUpdates.entries()) {
      const read = readUpdate(raw)
      if (!read.ok) {
        findings.push(makeFinding(
          'update-invalid',
          msg`Update ${num(position)} in step ${step.name} was not read: ${read.reason}. It was not checked and it was not counted.`,
          at(file, pointerFor('steps', step.name, 'updates', String(position))),
          { suggestion: 'Correct the update record.' },
        ))
        unusableSteps.add(step.name)
        continue
      }
      const update = read.update
      const where = at(file, pointerFor('steps', step.name, 'updates', update.region))
      step.updates.push(update)
      timeline.push({ step, position, update })
      counts.checked += 1

      if (!index.byId.has(update.region)) {
        findings.push(makeFinding(
          'region-unknown',
          msg`Step ${step.name} records an update to ${update.region}, which the recording does not declare as a region, so its urgency is unknown and the update was not judged.`,
          where,
          { suggestion: 'Declare every region the steps write to, with its role and aria-live.' },
        ))
        unusableSteps.add(step.name)
        continue
      }

      if (!update.textCaptured) {
        findings.push(makeFinding(
          'update-text-not-captured',
          msg`An update to ${update.region} in step ${step.name} records no "text", so what changed was not established and it could not be compared with any other update.`,
          where,
          { suggestion: 'Record the text the region held after the change, using null when it was emptied.' },
        ))
      } else if (update.text !== null && update.text !== '' && !showsSomething(update.text)) {
        // Not a length check in either direction: text of bidi controls or C1
        // characters has a non-zero length, survives trim(), and shows nothing
        // -- while text LONGER than any cap shows plenty, and calling that one
        // empty would be a false accusation.
        //
        // Nor is it a check on emptiness. `null` and `""` are an update that
        // CLEARED the region, which this schema documents as a value an
        // exporter should record and which is an ordinary thing to do to a live
        // region -- a status is emptied when the operation it described is
        // over, and a region is commonly cleared before the next message is
        // written into it. Reporting that at error severity was a defect raised
        // on correct input. What is reported is the other case, which the
        // evidence really does distinguish: the interface wrote SOMETHING and
        // that something shows nothing. An empty write where the expectations
        // wanted text is still reported, by `expected-update-missing`, which is
        // where a judgement about what a step should have written belongs.
        findings.push(makeFinding(
          'update-text-empty',
          msg`An update to ${update.region} in step ${step.name} wrote text that shows nothing at all.`,
          where,
          {
            evidence: `${num(update.text.length)} character(s), none of which reach output`,
            suggestion: 'Put the message in the region, or clear it with an empty string when there is nothing to say.',
          },
        ))
      }

      if (!update.timeCaptured) {
        findings.push(makeFinding(
          'update-time-not-captured',
          msg`An update to ${update.region} in step ${step.name} records no "atMs", so it could not be placed inside or outside the repeat window and was left out of that comparison.`,
          where,
          { suggestion: 'Record atMs for every update, as milliseconds from the start of the journey.' },
        ))
      }

      if (politeness.get(update.region) === 'off' && expectedToCarry.has(update.region)) {
        findings.push(makeFinding(
          'region-off-with-updates',
          msg`Region ${update.region} resolves to off, yet step ${step.name} writes to it and the expectations say that update is meant to carry something.`,
          where,
          {
            evidence: `expected to carry: ${expectedToCarry.get(update.region)}`,
            suggestion: 'Give the region polite or assertive urgency, stop writing to it, or drop the expectation.',
          },
        ))
      }
    }
  }

  for (const region of index.regions) {
    if (region.presentAtStart) continue
    const where = at(file, pointerFor('regions', region.id))
    if (!region.insertionCaptured) {
      findings.push(makeFinding(
        'region-insertion-not-captured',
        msg`Region ${region.id} is recorded as not present at the start and records no "insertedAtStep", so whether it existed before it was written to was not established.`,
        where,
        { suggestion: 'Record insertedAtStep, or null when the element was never added during the journey.' },
      ))
      continue
    }
    if (region.insertedAtStep === null) continue
    const step = stepsByName.get(region.insertedAtStep)
    if (step === undefined) {
      findings.push(makeFinding(
        'step-not-recorded',
        msg`Region ${region.id} is recorded as inserted at step ${region.insertedAtStep}, which the recording does not hold, so when it entered the document was not established.`,
        where,
        { suggestion: 'Record the step the region was inserted at.' },
      ))
      continue
    }
    if (step.updates !== undefined && step.updates.some((update) => update.region === region.id)) {
      findings.push(makeFinding(
        'region-created-with-content',
        msg`Region ${region.id} was inserted and written to in the same step, ${region.insertedAtStep}, so it was never an empty region waiting for a change.`,
        where,
        {
          suggestion: 'Insert the region empty, then write to it once it is in the document.',
        },
      ))
    }
  }

  counts.duplicateUpdates = checkDuplicates(timeline, policy, file, findings)

  for (const expectation of policy.steps) {
    const step = stepsByName.get(expectation.name)
    if (step === undefined) {
      findings.push(makeFinding(
        'step-not-recorded',
        msg`The expectations name step ${expectation.name}, which the recording does not hold, so its ${num(expectation.expect.length)} expectation(s) were not checked.`,
        at(file, pointerFor('steps')),
        { suggestion: 'Record the step in the journey, or drop it from the expectations.' },
      ))
      continue
    }
    const matched = new Set()
    for (const [position, entry] of expectation.expect.entries()) {
      const hit = step.updates.findIndex((update, position) => (
        !matched.has(position)
        && update.region === entry.region
        && (entry.text === null || (update.textCaptured && update.text === entry.text))
      ))
      if (hit !== -1) {
        matched.add(hit)
        continue
      }
      // Absence is only evidence when the recording holds everything -- and
      // "everything" includes the TEXT of the updates this step DID make. A
      // step that writes to the expected region with no recorded text has not
      // failed to write it; nobody wrote down what it wrote. Asserting
      // `expected-update-missing` there is an error-severity accusation that
      // the interface omitted an update, in the same report that emits
      // `update-text-not-captured` about that very update. The gate below is
      // the same one the sibling tool applies to a declared error whose id the
      // index could not resolve.
      const textUnknown = entry.text !== null && step.updates.some((update, candidate) => (
        !matched.has(candidate) && update.region === entry.region && !update.textCaptured
      ))
      const recordingIncomplete = !index.complete
        || unusableSteps.has(step.name)
        || !index.byId.has(entry.region)

      let ruleId = 'expected-update-missing'
      let message = msg`Step ${step.name} records no update to ${entry.region} matching expectation ${num(position)}.`
      let suggestion = 'Write the region when this step happens, or drop the expectation.'
      if (textUnknown) {
        ruleId = 'update-unverifiable'
        message = msg`Step ${step.name} does write to ${entry.region}, and the text of that update was not recorded, so whether it carried what expectation ${num(position)} names was not established.`
        suggestion = 'Record the text the region held after the change, using null when it was emptied.'
      } else if (recordingIncomplete) {
        ruleId = 'update-unverifiable'
        message = msg`Step ${step.name} records no update to ${entry.region} matching expectation ${num(position)}, but this recording does not hold every change, so its absence was not treated as evidence that it never happened.`
        suggestion = 'Export a complete recording, or observe the subtree this region lives in.'
      }
      findings.push(makeFinding(
        ruleId,
        message,
        at(file, pointerFor('steps', step.name, 'updates', entry.region)),
        {
          evidence: entry.text === null ? 'any text' : `expected text: ${entry.text}`,
          suggestion,
        },
      ))
    }
    if (!expectation.exhaustive) continue
    for (const [position, update] of step.updates.entries()) {
      if (matched.has(position)) continue
      findings.push(makeFinding(
        'unexpected-update',
        msg`Step ${step.name} is declared exhaustive, and it writes to ${update.region} where the expectations list no such update.`,
        at(file, pointerFor('steps', step.name, 'updates', update.region)),
        { suggestion: 'List the update in the expectations, or stop writing to the region in this step.' },
      ))
    }
  }

  if (counts.checked === 0) {
    findings.push(makeFinding(
      'no-updates-checked',
      msg`No update was checked in any step, so there is no evidence to pass or fail on.`,
      at(file, pointerFor('steps')),
      { suggestion: 'Supply a recording that holds at least one update.' },
    ))
  }

  return { findings, counts }
}
