# Changelog

All notable changes to this project are documented here. Rule ids are part of
the public surface: renaming one is a breaking change and is recorded here.

## 0.1.0 — 2026-09-18

First working version.

### Added

- Repeat detection: two updates to one region carrying the same text, no further
  apart than `duplicateWindowMs`, walked in recorded-time order. Every repeat is
  counted in `summary.duplicateUpdates` and reported individually.
- Urgency resolution from `aria-live`, falling back to a fixed table of six
  roles, with every undetermined case reported rather than assumed.
- Expectation checks per step, including `exhaustive` steps, with a missing
  update judged a defect only when the recording can support that claim.
- `region-created-with-content` for a region inserted and written to in the same
  step, and `region-off-with-updates` for a region written to with no urgency.
- A 34-rule catalog with one frozen severity table, and an evidence-missing list
  that makes any gap in the recording an `incomplete` report and exit 2.
- Expectations document with `duplicateWindowMs`, `maxUpdatesPerStep`,
  `regions`, `steps`, `maxRecordingAgeDays` and three size limits. Unknown keys
  are refused at every level, and a policy that states nothing to check is
  refused rather than run green.
- Refusal of any expectation about spoken or screen-reader output: exit 2 with
  empty stdout, because a recording of element changes cannot settle it.
- `manualEvidenceRequired` in every report: what somebody still has to establish
  by listening.
- `--now` so an age-checking run is reproducible.

### Notes

- The tool writes no file, opens no browser and touches no network.
- It reports updates, never announcements. A finding whose wording would claim
  otherwise throws at construction rather than shipping.
