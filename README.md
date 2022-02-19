# Live Region Event Auditor

Report repeated updates, expected updates a recording does not hold, and regions
whose urgency is not the urgency the expectations declare, from a recording of
the changes a journey made to a document.

- **Repository:** [edilec/live-region-event-auditor](https://github.com/edilec/live-region-event-auditor)
- **Area:** Accessibility
- **License:** MIT

## What it does

It reads two documents and compares them:

- a **journey recording** (`--journey`), exported by somebody else: the live
  regions a page declares, with the `role` and `aria-live` each one carries, and
  a sequence of named steps recording every change written into them, with the
  text and the time;
- an **expectations document** (`--expectations`), which supplies everything it
  judges by: what urgency each region should resolve to, which updates each step
  should produce, how close two identical updates have to be to count as a
  repeat, and the size limits.

From that it reports four things: a region written twice with the same text
inside the repeat window, a region whose resolved urgency is not the expected
one, an update the expectations wanted that the recording does not hold, and a
region that was inserted into the document already carrying its message.

It writes the result as JSON on stdout and a human summary on stderr.

## Why it exists

Live regions fail quietly. The same toast fires twice and a person hears the
same sentence twice; a form error is put in a `role="status"` region and waits
behind whatever is already queued; a region is created with its text already in
it and nothing is conveyed at all. None of that shows up in a screenshot and
none of it throws.

All four are visible in a recording of what changed and when, which is evidence
somebody can already produce from a test run. What is *not* visible there is the
thing everybody actually wants to know.

## A recorded update is not an announcement

This is the whole honesty of the tool, so it is behaviour and not a footnote.

This tool opens no browser, resolves no host, replays nothing and writes no
file — in normal use and in its tests. It has no network access at any point. It
runs no assistive technology and never will. It can establish that a region was
written to, what the markup says its urgency is, and that two writes were close
together. It cannot establish what anybody was told, in what order, or whether
one update interrupted another.

So:

- The report says **update**, never *announcement*. A finding whose wording would
  claim otherwise throws when it is built, not when somebody reviews it.
- An expectation about spoken output — `spokenText`, `announcedText`,
  `expectSpoken`, `expectAnnouncement`, `announcementOrder`, `screenReader`,
  `screenReaderOutput`, `heardBy` — is **refused**: exit 2, empty stdout. It is
  not quietly ignored, because an ignored expectation is one a team believes was
  checked.
- Every report carries `manualEvidenceRequired`: the list of things somebody
  still has to establish by listening, with the assistive technology the audience
  actually uses. That is a handover, not a disclaimer.

### Non-goals

- **Not an HTML parser.** It does not read `.html` files or markup fragments.
  The recording is JSON with the documented shape.
- **Not a screen-reader emulator.** Actual spoken output requires separate
  manual evidence.
- **Not a browser driver.** It cannot produce a recording; that is your side of
  the contract.
- **Not an ARIA implementation.** It knows the urgency of exactly six roles (see
  [Urgency](#urgency)) and refuses to guess about any other.
- **Not a judge of wording.** Whether the text of an update is useful is outside
  this evidence.
- **Not a writer.** It has no `--out`, creates no directory and modifies
  nothing. Redirect stdout if you want the report in a file.

## Quick start

```sh
# a journey whose live regions behave
node bin/live-region-event-auditor.mjs \
  --journey examples/clean/journey.json \
  --expectations examples/clean/expectations.json \
  --now 2026-09-18
echo $?   # 0

# the same journey with a repeated basket message, an error region built as a
# status region, a confirmation that never arrives, and a progress region
# created with its text already in it
node bin/live-region-event-auditor.mjs \
  --journey examples/broken/journey.json \
  --expectations examples/broken/expectations.json \
  --now 2026-09-18
echo $?   # 1
```

`npm run example` runs the first of those and `npm run example:broken` the
second. `--now` is passed so the verdict does not depend on the day it is run;
see [The clock](#the-clock).

## The recording

```json
{
  "schemaVersion": "1",
  "capture": {
    "id": "checkout-journey",
    "source": "dom-mutation-record",
    "recordedAt": "2026-09-12",
    "recording": "complete"
  },
  "unreadableRegions": [{ "hostId": "cart-widget", "reason": "shadow-root" }],
  "regions": [
    { "id": "cart-status", "role": "status", "ariaLive": null, "presentAtStart": true },
    {
      "id": "form-errors",
      "role": "alert",
      "ariaLive": null,
      "presentAtStart": false,
      "insertedAtStep": "01-open-checkout"
    }
  ],
  "steps": [
    { "name": "01-open-checkout", "updates": [] },
    {
      "name": "02-submit-empty",
      "updates": [{ "region": "form-errors", "text": "There is a problem", "atMs": 1200 }]
    }
  ]
}
```

- `capture.source` must be `"dom-mutation-record"`. Anything else is refused
  rather than reinterpreted.
- `capture.recording` is `"complete"` or `"partial"` and decides whether a
  missing update is a defect or a gap.
- A region must record `role`, `ariaLive` and `presentAtStart`. Use `null` for
  an attribute that was not there.
- `insertedAtStep` is required in effect for a region that was not present at
  the start: without it, whether the region existed before it was written to is
  not established. Use `null` when the element was never added during the
  journey.
- An update records `region`, `text` and `atMs`. `text` may be `null` for a
  region that was emptied; `atMs` is milliseconds from the start of the journey.

### Absent is not the same as not captured

| In the recording | Means | Effect |
| --- | --- | --- |
| `"ariaLive": null` | the exporter looked, the attribute was not there | evidence; can decide a check |
| key omitted | nobody recorded it | a gap; makes the run incomplete |

An update that omits `text` cannot be compared with anything, and an update that
omits `atMs` cannot be placed inside or outside the repeat window. Both are
reported and both leave the update out of the repeat comparison rather than
counting it as "no repeat".

## Urgency

`aria-live` decides when it is present, as it does in the platform. When it is
absent, the role decides, from this fixed table:

| Role | Urgency |
| --- | --- |
| `alert` | assertive |
| `status` | polite |
| `log` | polite |
| `progressbar` | polite |
| `timer` | off |
| `marquee` | off |

That table is the whole of what this tool knows about implicit semantics. A
region with some other role, with no role and no `aria-live`, or with an
`aria-live` value outside `off`/`polite`/`assertive`, has an urgency this tool
does **not** determine: the run is incomplete and the expectation for that region
is reported as not checked. It is never assumed to be polite.

## Repeats

Two updates are a repeat when they name the same region, carry the same text,
and their recorded times are no more than `duplicateWindowMs` apart. The
comparison walks each region's updates **in recorded-time order**, not in the
order the file listed them, and every repeat is counted: `summary.duplicateUpdates`
carries the total and there is one finding per repeat.

Text is compared exactly, at any length. An update whose text or time was not
recorded is left out of the comparison and reported, because "not comparable" is
not "not a repeat".

## The expectations

```json
{
  "schemaVersion": "1",
  "duplicateWindowMs": 1000,
  "maxUpdatesPerStep": 5,
  "maxRecordingAgeDays": 90,
  "regions": {
    "cart-status": { "politeness": "polite" },
    "form-errors": { "politeness": "assertive" }
  },
  "steps": [
    {
      "name": "02-submit-empty",
      "exhaustive": true,
      "expect": [{ "region": "form-errors", "text": "There is a problem" }]
    }
  ],
  "limits": { "maxJourneyBytes": 4194304, "maxRegions": 200, "maxSteps": 500 }
}
```

`schemaVersion`, `duplicateWindowMs`, `maxUpdatesPerStep`, `regions` and `steps`
are required; `maxRecordingAgeDays` and `limits` are optional. Unknown keys —
at the top level, inside a step, inside an expectation or inside a region
expectation — are refused, because an accepted key that is silently ignored
turns a real failure into a green run.

An expectation with no `text` matches any update to that region. `exhaustive`
means the listed updates are the only ones that step may produce; anything else
recorded there is reported. A policy with no region expectations and no steps
states nothing to check, and is refused rather than run green over anything.

## Rules

`evidence?` marks a rule that says the tool did not obtain evidence a verdict
would need. Any one of those makes the whole report `incomplete` and the process
exit 2, whatever the rule's own severity is.

| Rule | Severity | Evidence missing |
| --- | --- | --- |
| `capture-source-unsupported` | error | yes |
| `duplicate-region-id` | error | yes |
| `duplicate-update` | error | no |
| `expected-region-not-captured` | warning | yes |
| `expected-update-missing` | error | no |
| `journey-age-unknown` | warning | yes |
| `journey-invalid` | error | yes |
| `journey-not-utf8` | error | yes |
| `journey-stale` | warning | yes |
| `journey-too-large` | error | yes |
| `journey-unparsable` | error | yes |
| `journey-unreadable` | error | yes |
| `no-updates-checked` | error | yes |
| `politeness-mismatch` | error | no |
| `politeness-unknown` | warning | yes |
| `politeness-value-invalid` | error | yes |
| `recording-incomplete` | warning | yes |
| `region-created-with-content` | error | no |
| `region-insertion-not-captured` | warning | yes |
| `region-invalid` | error | yes |
| `region-limit-exceeded` | error | yes |
| `region-off-with-updates` | error | no |
| `region-unknown` | error | yes |
| `step-invalid` | error | yes |
| `step-limit-exceeded` | error | yes |
| `step-not-recorded` | warning | yes |
| `step-update-limit-exceeded` | error | yes |
| `subtree-not-captured` | warning | yes |
| `unexpected-update` | error | no |
| `update-invalid` | error | yes |
| `update-text-empty` | error | no |
| `update-text-not-captured` | warning | yes |
| `update-time-not-captured` | warning | yes |
| `update-unverifiable` | warning | yes |

The eleven `warning` rules marked `yes` are the ones where that marking is the
only thing preventing a green run, so each has a test that drives it from a real
recording and asserts `incomplete` with no error-severity finding present.

## When absence stops being evidence

`expected-update-missing` says the journey did not do something. That is a claim
about the journey, and it is only made when the recording can support it:
`capture.recording` is `"complete"`, no `unreadableRegions` are listed, the
region is one the recording describes, and the step stayed inside
`maxUpdatesPerStep`. Otherwise the same absence is reported as
`update-unverifiable` and the run is incomplete.

A recording that declares itself `"complete"` while listing a subtree it could
not observe is contradicting itself, and the unobserved subtree wins.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | every recorded update was checked and the expectations held |
| `1` | the check completed and the journey broke an expectation |
| `2` | invalid configuration, or evidence the check could not obtain |

Exit 2 has two shapes, and the difference matters to anything piping stdout:

| Situation | stdout | stderr | `status` |
| --- | --- | --- | --- |
| invalid configuration, unknown option, any problem with the expectations document | **empty** | the message | no report |
| input that could not be read, decoded or parsed, or evidence that was not obtained | a report | diagnostics | `incomplete` |

## The report

```json
{
  "schemaVersion": "1",
  "tool": "live-region-event-auditor",
  "status": "pass",
  "evidenceBasis": "dom-mutation-record",
  "disclaimer": "…",
  "notEstablished": ["…"],
  "manualEvidenceRequired": ["…"],
  "summary": {
    "checked": 3, "errors": 0, "warnings": 0, "info": 0,
    "regions": 3, "steps": 3, "updates": 3, "duplicateUpdates": 0
  },
  "findings": []
}
```

`location.file` is the recording's base name, never an absolute host path, and
`location.pointer` is a JSON Pointer into the recording.

## Determinism

Findings sort by `(location.file, location.pointer, ruleId, message)`, each
compared by **UTF-16 code unit**. No locale collation is used anywhere:
`localeCompare` and `Intl.Collator` depend on ICU data that differs between Node
builds. The repeat walk orders by three integers. Two runs over identical inputs
produce byte-identical stdout.

## The clock

Nothing here reads the wall clock on its own behalf. `maxRecordingAgeDays` is
compared against `--now`, which defaults to the system clock and takes
`YYYY-MM-DD` or `YYYY-MM-DDTHH:MM:SSZ`. Passing it makes an age-checking run
reproducible; the examples pass it for that reason.

## Limits

| Limit | Default | Exceeding it |
| --- | ---: | --- |
| `maxJourneyBytes` | 4194304 | `journey-too-large`, nothing checked |
| `maxRegions` | 200 | `region-limit-exceeded`, nothing checked |
| `maxSteps` | 500 | `step-limit-exceeded`, nothing checked |

`maxUpdatesPerStep` is a required expectation rather than a limit with a
default, because it is a statement about the interface as much as about the
size of the document. A step that exceeds it is not checked at all and the run
is incomplete.

Exceeding a limit is an incomplete result naming the limit. It is never a silent
truncation and never a pass. Bounds that are not configurable: an id or step
name is at most 128 characters, `unreadableRegions` holds at most 200 entries,
and the expectations document itself is at most 262144 bytes.

Update text is **not** length-capped beyond `maxJourneyBytes`, in either the
repeat comparison or the emptiness check. An update longer than any cap shows
plenty, and reporting it as empty would be a confident false accusation about
the interface. `evidence` in a finding is a bounded excerpt at 200 characters,
which is a bound on the report rather than on the document.

## Safety of the report

Every untrusted string — region ids, step names, roles, update text, file names
— is stripped of C0, DEL, C1, `U+2028`, `U+2029` and the bidi controls before it
reaches the report or the summary, then bounded to 200 characters. A region id
carrying a newline cannot forge a line in the report.

A `JSON.parse` failure is described without reproducing the document: V8 quotes
the offending input back in some of its messages, so a short document that is
only a credential would otherwise be echoed by its own error message.

## Verification

```sh
npm run check     # lint, tests, both examples, and a packaging dry run
```

`npm test` runs the suite alone. The tests cover each acceptance criterion by
name, drive every rule in the table above from a real recording, and assert exit
codes from the real CLI rather than asserting about severity tables.

## License

MIT. See [LICENSE](./LICENSE).
