# Live Region Event Auditor documentation

The user-facing documentation is the [README](../README.md): input shapes, the
rule table, the urgency table, exit codes, limits and non-goals all live there so
that there is one place to keep true.

This file records the design decisions that are easy to undo by accident.

## Why the vocabulary is enforced in code

The one word that would make this tool dishonest is "announcement". A recording
of element changes shows that a region was written to; it shows nothing about
what any person was told. The two words are close enough that a report would
drift from one to the other in a single careless sentence, and the team reading
it would believe a check had been made that was not.

So the forbidden words are checked when a finding is built, against this tool's
own literals only. A region a team named `announcer` is data and must not stop
the run; a sentence this tool wrote saying an update was announced must not
ship. The `msg` tagged template is what keeps the two apart.

## Why the urgency table is six roles and not the ARIA specification

Implementing implicit live-region semantics properly means implementing a good
deal of ARIA, and a partial implementation that guesses is worse than none: a
region this tool believed was polite, that a real implementation treats
differently, would produce a confident wrong verdict.

Six roles cover what live-region code actually uses, and everything outside them
is reported as undetermined, which makes the run incomplete. That is the honest
failure mode: the check was not made, and the report says so.

## Why `update-time-not-captured` exists

The repeat check needs two times. Without one, an update cannot be placed inside
or outside the window — and "cannot be placed outside" is not "is outside". An
earlier shape of this tool would have quietly skipped such an update and
reported no repeats, which is the tool narrowing what it checked rather than
saying it could not check it.

## Why the repeat walk sorts by time

It did not, at first, and a test caught it: a recording that listed a later
update between two repeats reported no repeat at all, because the walk followed
file order and the two were no longer adjacent. The recording's order is the
exporter's business; the journey's order is what the check is about.

The sort keys are three integers — the recorded time, the step's position, the
update's position — so no string comparison and no collation is involved.

## Why there is no `--out`

The tool is read-only. Adding a destination would bring the three data-loss
holes — a symlinked destination, a symlinked parent, a hard link to an input —
and the guard for them, for the sake of something `> report.json` already does.

## Mutations to watch

Each of these is a single edit that changes real output. Each has a test that
fails when it is made:

| Edit | What it would do |
| --- | --- |
| delete `reasons.length === 0` from `complete` in `buildIndex` | an unobserved subtree would stop downgrading a missing update; exit 2 becomes exit 1 |
| remove a rule from `EVIDENCE_MISSING_RULES` | a gap in the recording becomes a pass; exit 2 becomes exit 0 for the eleven warning rules |
| drop the `timeCaptured`/`textCaptured` filter in `checkDuplicates` | an update with no time would be compared as though it had one |
| remove the sort in `checkDuplicates` | the repeat verdict follows the order of the file |
| give `effectivePoliteness` a default for an unknown role | an undetermined urgency becomes a confident one |
| swap `byCodeUnit` for a collator | ordering becomes machine-dependent |
| move the position branch ahead of the quoting branch in `parseFailureDetail` | a document reading `at position 1` is sliced back into the message |
| give `showsSomething` a length cap again | an update longer than the cap is reported as leaving the region showing nothing |
| replace any one of the four sort keys with `0` | ordering stops being what the README documents |
| drop the `UNREADABLE_REASONS` or `RECORDING_STATES` check | a typo is accepted as a documented value, and a partial recording reads as complete |

## What the sweep is, and what it found

The sweep is mechanical, and the enumeration rather than the adjective is what
is worth reporting. Four categories, derived from the source text rather than
from a list somebody thought of:

- every entry in `EVIDENCE_MISSING_RULES`, deleted (27)
- every severity in `RULE_SEVERITY`, flipped one step (34)
- every named guard, refusal or validation in `src/`, neutered (61)
- the ordering primitive given a collator, and each sort key dropped (6)

The run over this tree was 128 mutations. Eight survived, none of them an
equivalent mutant: the repeat walk's filter on updates with no recorded time or
text, the named required keys of a region record, the `capture.recording` value
check, the unreadable-reason check, the sanitising of a suggestion, and three of
the four sort keys. Each now has a test that fails when the guard is removed.
