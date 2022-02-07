#!/usr/bin/env node

import { ConfigError, auditJourney, exitCodeFor, formatSummary, parseInstant, renderReport } from '../src/index.mjs'

const HELP = `live-region-event-auditor

Report repeated updates, expected updates the recording does not hold, and
regions whose urgency is not the urgency the expectations declare, from a
recording of the changes a journey made to a document.

This tool reads evidence. It opens no browser, resolves no host, replays
nothing and writes no file. It runs no assistive technology, so it reports
UPDATES, never announcements: a recorded update is a change to an element, and
whether anybody was told about it, in what order, or whether it interrupted
something else, is not in this evidence. That needs separate manual evidence
from somebody who listened, and every report says so and lists what is left to
check. An expectation that asks this tool to judge spoken output is refused
rather than answered.

An update the recording does not hold is judged missing only when the recording
declares itself complete, lists no subtree it failed to observe, and the step
stayed inside the per-step limit. Otherwise its absence is a gap, not a defect,
and the run is incomplete.

Usage:
  live-region-event-auditor --journey FILE --expectations FILE [--now INSTANT] [--json]

Options:
  --journey FILE       Journey recording to audit (required)
  --expectations FILE  Expectations document: the policy (required)
  --now INSTANT        Treat this instant as the present when applying the
                       expectations' maxRecordingAgeDays, as YYYY-MM-DD or
                       YYYY-MM-DDTHH:MM:SSZ. Defaults to the system clock.
                       Supply it to make an age-checking run reproducible.
  --json               Suppress the human summary on stderr
  -h, --help           Show this help

Streams:
  stdout  the JSON report and nothing else, so it can be piped into a parser
  stderr  the human summary and any diagnostics

Exit codes:
  0  every recorded update was checked and the expectations held
  1  the check completed and the journey broke an expectation
  2  invalid configuration, or evidence the check could not obtain. A region
     whose urgency the markup does not determine, an update whose text or time
     nobody recorded, a step the expectations name and the recording never
     reached, a subtree the exporter could not observe, a recording older than
     the expectations allow -- all land here, and none of them is ever reported
     as an absence of a problem.
     On a configuration error -- including any problem with the expectations
     document, which is the policy -- stdout stays EMPTY and the message goes to
     stderr. On unreadable or incomplete evidence stdout carries an "incomplete"
     report naming what was not established.
`

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { journey: null, expectations: null, now: undefined, json: false }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }
    if (argument === '--json') options.json = true
    else if (argument === '--journey') options.journey = takeValue('--journey')
    else if (argument === '--expectations') options.expectations = takeValue('--expectations')
    else if (argument === '--now') {
      const raw = takeValue('--now')
      const instant = parseInstant(raw)
      if (!instant.ok) throw new Error('--now requires YYYY-MM-DD or YYYY-MM-DDTHH:MM:SSZ')
      options.now = instant.ms
    } else throw new Error(`Unknown option "${argument}"`)
  }

  if (options.journey === null) throw new Error('--journey is required')
  if (options.expectations === null) throw new Error('--expectations is required')
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stderr.write(HELP)
    return 0
  }

  let report
  try {
    report = await auditJourney({
      journey: options.journey,
      expectations: options.expectations,
      ...(options.now === undefined ? {} : { now: options.now }),
    })
  } catch (error) {
    // A ConfigError means the run never had a subject: stdout stays empty, by
    // the contract. Anything else escaping here is a defect in this tool, and
    // it is reported the same way rather than as a report about the journey.
    process.stderr.write(`${error instanceof ConfigError ? error.message : `Execution failure: ${error.message}`}\n`)
    return 2
  }

  process.stdout.write(renderReport(report))
  if (!options.json) process.stderr.write(formatSummary(report))
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
