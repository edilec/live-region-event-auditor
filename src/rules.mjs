/**
 * The rule catalog, the severity table, and everything that turns findings into
 * a status.
 *
 * Five defences live here, and each exists because its absence produced a green
 * build over a real failure somewhere in this catalog:
 *
 * 1. Severity is declared exactly once, in `RULE_SEVERITY`. Every finding takes
 *    its severity from that table, and an unknown rule id throws rather than
 *    defaulting to something harmless.
 * 2. `status` is derived from the findings, never from a mutable flag. A run
 *    that could not obtain the evidence a verdict needs is `incomplete`, and
 *    there is no single assignment whose deletion would let an unread recording
 *    report a pass. Several evidence-missing rules are `warning` severity on
 *    purpose: for those, membership of `EVIDENCE_MISSING_RULES` is the only
 *    thing standing between a gap in the evidence and a green run.
 * 3. A finding's message must be built with the `msg` tagged template, whose
 *    own literals are checked against the words this tool is not entitled to
 *    use. This tool reads a recording of DOM changes. It never heard anything,
 *    so it reports UPDATES, never announcements: whether an update was spoken,
 *    in what order, or whether it interrupted, is not in this evidence and the
 *    vocabulary is enforced rather than merely intended.
 * 4. `sanitize` is the single boundary every untrusted string crosses, so it
 *    must survive a value that cannot be converted to a primitive at all.
 * 5. Ordering is by UTF-16 code unit. Collation is machine-dependent.
 */

/** Deterministic order: UTF-16 code unit, never locale collation. */
export function byCodeUnit(a, b) {
  return a === b ? 0 : a < b ? -1 : 1
}

export const SEVERITIES = Object.freeze(['error', 'warning', 'info'])

/** The one place a severity is written down. */
export const RULE_SEVERITY = Object.freeze({
  'capture-source-unsupported': 'error',
  'duplicate-region-id': 'error',
  'duplicate-update': 'error',
  'expected-region-not-captured': 'warning',
  'expected-update-missing': 'error',
  'journey-age-unknown': 'warning',
  'journey-invalid': 'error',
  'journey-not-utf8': 'error',
  'journey-stale': 'warning',
  'journey-too-large': 'error',
  'journey-unparsable': 'error',
  'journey-unreadable': 'error',
  'no-updates-checked': 'error',
  'politeness-mismatch': 'error',
  'politeness-unknown': 'warning',
  'politeness-value-invalid': 'error',
  'recording-incomplete': 'warning',
  'region-created-with-content': 'error',
  'region-insertion-not-captured': 'warning',
  'region-invalid': 'error',
  'region-limit-exceeded': 'error',
  'region-off-with-updates': 'error',
  'region-unknown': 'error',
  'step-invalid': 'error',
  'step-limit-exceeded': 'error',
  'step-not-recorded': 'warning',
  'step-update-limit-exceeded': 'error',
  'subtree-not-captured': 'warning',
  'unexpected-update': 'error',
  'update-invalid': 'error',
  'update-text-empty': 'error',
  'update-text-not-captured': 'warning',
  'update-time-not-captured': 'warning',
  'update-unverifiable': 'warning',
})

export const RULE_IDS = Object.freeze(Object.keys(RULE_SEVERITY).sort(byCodeUnit))

/**
 * Rules that mean the tool did not obtain the evidence a verdict would need.
 * Any one of them makes the whole report `incomplete` and the process exit 2,
 * whatever the rule's own severity happens to be.
 *
 * Eleven of these are `warning` severity, because a gap in the recording is not a
 * defect in the interface being recorded. For those eleven, membership of
 * this list is the ONLY thing preventing a green run over a region whose
 * urgency could not be determined, an update whose text or time nobody wrote
 * down, a step the expectations name and the recording never reached, or a
 * recording the exporter itself declares partial. Deleting an entry here is a
 * silent mutation that turns exit 2 into exit 0, so every entry has a test that
 * fails without it.
 */
export const EVIDENCE_MISSING_RULES = Object.freeze([
  'capture-source-unsupported',
  'duplicate-region-id',
  'expected-region-not-captured',
  'journey-age-unknown',
  'journey-invalid',
  'journey-not-utf8',
  'journey-stale',
  'journey-too-large',
  'journey-unparsable',
  'journey-unreadable',
  'no-updates-checked',
  'politeness-unknown',
  'politeness-value-invalid',
  'recording-incomplete',
  'region-insertion-not-captured',
  'region-invalid',
  'region-limit-exceeded',
  'region-unknown',
  'step-invalid',
  'step-limit-exceeded',
  'step-not-recorded',
  'step-update-limit-exceeded',
  'subtree-not-captured',
  'update-invalid',
  'update-text-not-captured',
  'update-time-not-captured',
  'update-unverifiable',
].sort(byCodeUnit))

const EVIDENCE_MISSING_SET = new Set(EVIDENCE_MISSING_RULES)

export const EVIDENCE_LIMIT = 200
export const MAX_ID_LENGTH = 128

export function severityFor(ruleId) {
  const severity = RULE_SEVERITY[ruleId]
  if (severity === undefined) throw new Error(`Unknown ruleId "${ruleId}"`)
  return severity
}

export function marksEvidenceMissing(ruleId) {
  severityFor(ruleId)
  return EVIDENCE_MISSING_SET.has(ruleId)
}

/**
 * Words this tool is not entitled to use about its own work.
 *
 * It reads a recording of changes to elements in a document. It ran no
 * assistive technology, heard nothing and measured no timing of its own, so it
 * reports UPDATES and never announcements. The distinction is the whole point
 * of the tool's honesty: a recorded update is a change to the DOM, while an
 * announcement is something a person was told, and only somebody listening can
 * establish the second. The vocabulary is enforced at construction time rather
 * than at review time, because a report that slides from one word to the other
 * is exactly how a team comes to believe a check was made that was not.
 *
 * Only the tool's OWN literals are scanned. A region literally named
 * `announcer` is data and must not stop the run.
 */
export const FORBIDDEN_CLAIMS = Object.freeze([
  'announce', 'announced', 'announces', 'announcing', 'announcement', 'announcements',
  'spoken', 'speaks', 'spoke', 'speech', 'said aloud', 'read aloud', 'readout',
  'audible', 'audibly', 'heard', 'hears', 'voiced', 'utterance',
  'screen reader', 'screen readers', 'screenreader', 'assistive technology',
  'voiceover', 'talkback', 'nvda', 'jaws', 'narrator',
  'interrupted the user', 'the user was told', 'conveyed to the user',
  'browser', 'browsers', 'rendered', 'rendering', 'screenshot', 'screenshots',
  'navigate', 'navigated', 'visited', 'crawled', 'fetched',
  'we replayed', 'this tool replayed', 'emulate', 'emulated', 'emulates',
])

const FORBIDDEN_PATTERN = new RegExp(
  `\\b(?:${FORBIDDEN_CLAIMS.map((term) => term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})\\b`,
  'iu',
)

export function findForbiddenClaim(text) {
  const match = FORBIDDEN_PATTERN.exec(describeValue(text))
  return match === null ? null : match[0]
}

export function assertNoForbiddenClaim(text, what) {
  const term = findForbiddenClaim(text)
  if (term !== null) {
    throw new Error(
      `${what} may not claim this tool observed an interface directly or knows what anyone `
      + `was told: "${term}". It reads a recording of changes to elements, and a recorded `
      + `update is not an announcement.`,
    )
  }
}

/**
 * U+2028 and U+2029, written as escape text so that no editor, transfer or
 * copy-paste can quietly turn the escape into the character it names.
 */
export const LINE_SEPARATORS = '\u2028\u2029'

/**
 * Everything stripped from an untrusted string before it reaches output.
 *
 * `\p{Cc}` is C0, DEL and C1 -- U+0085 and U+009B forge lines in a human report
 * just as a newline does. `\p{Cf}` is the bidi controls and the other invisible
 * format characters, which reorder or hide displayed text. The two separators
 * are neither class and have to be named.
 */
const UNSAFE_CHARACTERS = new RegExp(`[\\p{Cc}\\p{Cf}${LINE_SEPARATORS}]`, 'gu')

/**
 * Describe any value as a string without ever letting it stop the run.
 *
 * `String({ toString: {} })` throws `Cannot convert object to primitive value`,
 * and a recording is JSON this tool did not write: `{"region": {"toString":
 * {}}}` parses into exactly that. A value that will not convert is described by
 * its shape and never reproduced.
 */
export function describeValue(value) {
  if (typeof value === 'string') return value
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return '[array]'
  try {
    return String(value)
  } catch {
    return typeof value === 'function' ? '[function]' : '[object]'
  }
}

/**
 * A bounded, control-character-free rendering of an untrusted string.
 *
 * Region ids, step names, roles and update text all arrive from the recording
 * and all reach the report and the human summary, so every one of them passes
 * through here -- not only an `evidence` field. A shipped tool in this catalog
 * sanitised its evidence carefully and let an identifier carrying a newline
 * forge whole lines in the report.
 */
export function sanitize(value, limit = EVIDENCE_LIMIT) {
  const flat = describeValue(value)
    .replace(UNSAFE_CHARACTERS, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return flat.length > limit ? `${flat.slice(0, limit - 3)}...` : flat
}

/**
 * Whether a value is a string that still says something once rendered.
 *
 * `value.trim().length > 0` is the wrong question and has shipped as a bug:
 * `trim` removes ECMAScript whitespace only, so an update whose text is U+0001
 * or U+200E passes it and then shows nothing at all. An update that shows
 * nothing is worth reporting, so the question is asked about the rendered form.
 */
export function isRenderableString(value, limit = MAX_ID_LENGTH) {
  return typeof value === 'string' && value.length <= limit && sanitize(value, limit) !== ''
}

/**
 * Whether a string would show anything at all once the unsafe characters are
 * removed, with no opinion about its length.
 *
 * This is deliberately separate from `isRenderableString`. That one answers a
 * question about an IDENTIFIER, where a length cap is part of what makes the
 * value usable. Asking it about prose conflates two different failures: an
 * update longer than the cap is not an update that shows nothing, and reporting
 * it as one is a confident false accusation about the interface. Length here is
 * bounded by the document size limit and by nothing else.
 */
export function showsSomething(value) {
  return typeof value === 'string' && sanitize(value, Number.MAX_SAFE_INTEGER) !== ''
}

/** A number as a report prints it. */
export function num(value) {
  if (!Number.isFinite(value)) return describeValue(value)
  const rounded = Math.round(value * 10000) / 10000
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

const UNPARSEABLE = 'the document could not be parsed as JSON'

/** Where V8 puts the offending offset. Safe: an offset says nothing about content. */
const POSITION = /at position \d+(?: \(line \d+ column \d+\))?/u

/**
 * The shape that quotes the input. Recognised FIRST, and the order is the whole
 * guard: a document whose own text reads `at position 1` makes V8 write
 * `Unexpected token 'a', "at position 1" is not valid JSON`, so looking for the
 * offset first finds that phrase INSIDE the quoted span and slices the document
 * straight back out. The `s` flag matters too -- the quoted span can carry a
 * newline, and a non-dotAll pattern silently fails to recognise the shape it is
 * there to catch. A leading `...` means the quoted run came from the middle of
 * the document rather than its start.
 */
const QUOTES_THE_INPUT = /^Unexpected token (.+?), (\.\.\.)?".*"(?:\.\.\.)? is not valid JSON$/su

function describeParseFailure(message) {
  const quoting = QUOTES_THE_INPUT.exec(message)
  if (quoting !== null) {
    const where = quoting[2] === undefined ? 'at the start of the document' : 'inside the document'
    return `unexpected token ${quoting[1]} ${where}`
  }
  const position = POSITION.exec(message)
  if (position !== null) return message.slice(0, position.index + position[0].length)
  if (message === 'Unexpected end of JSON input') return message
  return UNPARSEABLE
}

/**
 * Say what a `JSON.parse` failure was, without reproducing the document.
 *
 * V8 reports a parse failure two ways and one of them quotes the input back:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`. A document
 * short enough to be only a credential is therefore reproduced in full by its
 * own error message, and `sanitize` does not stop that -- it strips control
 * characters and cuts from the end, while the quoted input sits at the front.
 *
 * The closing guard is deliberate belt and braces and is why this function is
 * safe against wordings it has never seen: across the measured corpus of V8
 * parse messages, every message carrying no quoted snippet carries no double
 * quote at all, because V8 quotes JSON punctuation with apostrophes. A double
 * quote surviving to the end therefore means a snippet survived, whatever the
 * branches above concluded, and the generic sentence is used instead.
 */
export function parseFailureDetail(error) {
  const message = describeValue(error?.message ?? '')
  const detail = describeParseFailure(message)
  return detail.includes('"') ? UNPARSEABLE : detail
}

/** A message whose literals have been checked and whose values are sanitised. */
export class SafeMessage {
  constructor(text) {
    this.text = text
    Object.freeze(this)
  }

  toString() {
    return this.text
  }
}

/**
 * Build a finding message.
 *
 * The tagged-template split is the point: `strings` is this tool's own voice
 * and is checked for claims it is not entitled to make, while `values` come
 * from the recording and are only sanitised. A region literally named
 * `announcer` must not stop the run, and a sentence this tool wrote saying an
 * update was announced must not ship.
 */
export function msg(strings, ...values) {
  let out = ''
  for (let index = 0; index < strings.length; index += 1) {
    // Runs of whitespace in the tool's own literals collapse to one space, so a
    // sentence may be wrapped across source lines without wrapping the report,
    // and so a phrase this tool may not use cannot be hidden by a line break.
    const literal = strings[index].replace(/\s+/gu, ' ')
    assertNoForbiddenClaim(literal, 'A finding message')
    out += literal
    if (index < values.length) out += sanitize(values[index])
  }
  return new SafeMessage(out)
}

export function at(file, pointer) {
  const location = {}
  if (file !== null && file !== undefined) location.file = file
  if (pointer !== null && pointer !== undefined) location.pointer = pointer
  return location
}

/** JSON Pointer escaping, applied to an already sanitised token. */
export function pointerToken(value) {
  return sanitize(value, MAX_ID_LENGTH).replace(/~/gu, '~0').replace(/\//gu, '~1')
}

export function makeFinding(ruleId, message, location, extra = {}) {
  if (!(message instanceof SafeMessage)) {
    throw new Error(`Finding "${ruleId}" must build its message with the msg tagged template`)
  }
  const finding = { ruleId, severity: severityFor(ruleId), message: message.text, location }
  if (extra.evidence !== undefined) finding.evidence = sanitize(extra.evidence)
  if (extra.suggestion !== undefined) {
    assertNoForbiddenClaim(extra.suggestion, 'A finding suggestion')
    // The suggestion crosses the same boundary as everything else that reaches
    // output. Every call site builds it from this tool's own literals today, so
    // sanitising changes no byte of any current report -- which is exactly why
    // it was the one string that skipped the boundary, and exactly the shape of
    // an invariant that is true only by accident.
    finding.suggestion = sanitize(extra.suggestion)
  }
  return finding
}

/** Findings sort by (file, pointer, ruleId, message), each by code unit. */
export function compareFindings(a, b) {
  return (
    byCodeUnit(a.location.file ?? '', b.location.file ?? '')
    || byCodeUnit(a.location.pointer ?? '', b.location.pointer ?? '')
    || byCodeUnit(a.ruleId, b.ruleId)
    || byCodeUnit(a.message, b.message)
  )
}

export function sortFindings(findings) {
  return [...findings].sort(compareFindings)
}

/**
 * Status is a function of the findings alone.
 *
 * Missing evidence outranks everything, including an error: a run that could
 * not read half the recording has not established that the half it read is the
 * whole story. There is no flag to delete.
 */
export function statusFor(findings) {
  for (const finding of findings) {
    if (EVIDENCE_MISSING_SET.has(finding.ruleId)) return 'incomplete'
  }
  for (const finding of findings) {
    if (finding.severity === 'error') return 'fail'
  }
  return 'pass'
}
