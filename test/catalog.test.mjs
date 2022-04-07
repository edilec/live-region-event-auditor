/**
 * The documented catalog and the code, checked against each other in BOTH
 * directions.
 *
 * A rule the README describes but the code never emits is a documentation
 * overclaim; a rule the code emits but the README does not list is a surprise.
 * The tables are parsed out of the README rather than repeated here, so there
 * is no third declaration to edit into agreement.
 */

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import test from 'node:test'

import { CATALOG, TOOL_ID, DEFAULT_LIMITS, POLITENESS_VALUES, REFUSED_POLICY_KEYS } from '../src/index.mjs'
import { ROOT, cleanExpectations, cleanJourney, runCli, runCliRaw } from './helpers.mjs'

async function readme() {
  return readFile(join(ROOT, 'README.md'), 'utf8')
}

test('the README rule table and the severity table agree, both ways', async () => {
  const text = await readme()
  const rows = new Map()
  for (const match of text.matchAll(/^\| `([a-z0-9-]+)` \| (error|warning|info) \| (yes|no) \|$/gmu)) {
    rows.set(match[1], { severity: match[2], evidenceMissing: match[3] === 'yes' })
  }
  assert.equal(rows.size, CATALOG.ruleIds.length, 'the README lists a different number of rules')
  assert.deepEqual([...rows.keys()].sort(), [...CATALOG.ruleIds].sort())
  for (const [ruleId, row] of rows) {
    assert.equal(row.severity, CATALOG.severity[ruleId], `${ruleId} severity`)
    assert.equal(
      row.evidenceMissing,
      CATALOG.evidenceMissing.includes(ruleId),
      `${ruleId} evidence-missing marking`,
    )
  }
})

test('the README urgency table is the table the code applies, both ways', async () => {
  const text = await readme()
  const rows = new Map()
  for (const match of text.matchAll(/^\| `(alert|status|log|timer|marquee)` \| (assertive|polite|off) \|$/gmu)) {
    rows.set(match[1], match[2])
  }
  assert.deepEqual([...rows.keys()].sort(), [...CATALOG.knownRoles].sort())
  for (const [role, politeness] of rows) {
    assert.equal(CATALOG.rolePoliteness[role], politeness, role)
  }
  assert.equal(Object.keys(CATALOG.rolePoliteness).length, rows.size)
})

test('the README limit table names every limit, with the real default', async () => {
  const text = await readme()
  for (const [name, value] of Object.entries(DEFAULT_LIMITS)) {
    assert.match(text, new RegExp(`\\| \`${name}\` \\| ${value} \\|`, 'u'), name)
  }
  const documented = [...text.matchAll(/^\| `(max[A-Za-z]+)` \| \d+ \|/gmu)].map((match) => match[1])
  assert.deepEqual(documented.sort(), Object.keys(DEFAULT_LIMITS).sort())
})

test('every refused policy key is named in the README', async () => {
  const text = await readme()
  for (const key of REFUSED_POLICY_KEYS) assert.match(text, new RegExp(`\`${key}\``, 'u'), key)
})

test('every politeness value and recording state the code accepts is documented', async () => {
  const text = await readme()
  // The backticks are REQUIRED, not optional. Writing them as `\`?${value}\`?`
  // made both of them optional, which degrades the pattern to a bare substring
  // search: `off` then matches inside "offer" or "of the", so it could not fail
  // for any plausible README and was not a check at all. The refused-key test
  // above already requires the backticked form; this now matches it, and the
  // test below proves the pattern can fail.
  for (const value of POLITENESS_VALUES) assert.match(text, new RegExp(`\`${value}\``, 'u'), value)
  for (const state of CATALOG.recordingStates) assert.match(text, new RegExp(`"${state}"`, 'u'), state)
})

test('the politeness check would fail on a document that only mentions the word', async () => {
  // The guard for the guard. A document holding "offer", "politeness" and
  // "assertiveness" names none of the three values, and the pattern above has
  // to say so; the pattern it replaces matched all three.
  const decoy = 'An offer, some politeness and a little assertiveness.'
  for (const value of POLITENESS_VALUES) {
    assert.doesNotMatch(decoy, new RegExp(`\`${value}\``, 'u'), value)
    assert.match(decoy, new RegExp(value, 'u'), `${value} really is present as a bare substring`)
  }
})

test('the README does not claim a capability this tool refuses to have', async () => {
  const text = await readme()
  assert.ok(!/\bwe (drive|replay|render|visit|fetch)\b/iu.test(text))
  assert.match(text, /A recorded update is not an announcement/u)
  assert.match(text, /Not a screen-reader emulator/u)
  assert.match(text, /Actual spoken output requires separate\s+manual evidence/u)
  assert.match(text, /Not an HTML parser/u)
  assert.match(text, /Not an ARIA implementation/u)
  assert.match(text, /writes no\s+file/u)
  // `--out` may appear only in the sentence that says there is none.
  assert.match(text, /It has no `--out`/u)
  assert.equal(text.split('--out').length - 1, 1, 'the only mention of --out is the one saying there is none')
})

test('the schema versions the README shows are the ones the code requires', async () => {
  const text = await readme()
  assert.equal(CATALOG.journeySchemaVersion, '1')
  assert.equal(CATALOG.policySchemaVersion, '1')
  assert.equal(CATALOG.reportSchemaVersion, '1')
  assert.match(text, /"schemaVersion": "1"/u)
})

test('the exit code table matches what the code returns', async () => {
  const text = await readme()
  assert.match(text, /^\| `0` \| every recorded update was checked/mu)
  assert.match(text, /^\| `1` \| the check completed and the journey broke an expectation \|$/mu)
  assert.match(text, /^\| `2` \| invalid configuration, or evidence the check could not obtain \|$/mu)
})

test('the count of warning-severity evidence-missing rules the README states is true', async () => {
  const text = await readme()
  const warnings = CATALOG.evidenceMissing.filter((ruleId) => CATALOG.severity[ruleId] === 'warning')
  assert.equal(warnings.length, 11)
  assert.match(text, /The eleven `warning` rules marked `yes`/u)
})

test('the README tells the truth about the clock, which a run without --now reads', async () => {
  // The README said "Nothing here reads the wall clock on its own behalf" two
  // sentences before saying --now "defaults to the system clock". The two
  // contradicted each other and the first was false of the code, which is worse
  // than silence because it reads as a guarantee. The behaviour is asserted
  // first, so the documents are checked against the tool rather than each other.
  const journey = await cleanJourney()
  journey.capture.recordedAt = '2000-01-01'
  const expectations = { ...(await cleanExpectations()), maxRecordingAgeDays: 1 }
  const withoutNow = await runCli(journey, expectations, ['--json'])
  assert.equal(withoutNow.code, 2, 'a run with no --now still judges age, so it did read a clock')
  assert.ok(
    JSON.parse(withoutNow.stdout).findings.some((finding) => finding.ruleId === 'journey-stale'),
    'the staleness verdict is a function of the day the run happens',
  )

  const text = await readme()
  assert.ok(
    !/reads the wall clock on its own behalf/u.test(text),
    'the README may not claim a clock reading the code performs',
  )
  assert.match(text, /a run that omits `--now` \*\*is not reproducible\*\*/u)
  const help = await runCliRaw(['--help'])
  assert.match(help.stderr, /Defaults to the system clock\./u)
})

test('TOOL_ID is the directory name, the package name and the tool field of the report', async () => {
  const directory = basename(ROOT)
  assert.equal(TOOL_ID, 'live-region-event-auditor')
  assert.equal(TOOL_ID, directory, 'the exported id and the directory must not drift apart')
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(manifest.name, TOOL_ID)
  assert.equal(Object.keys(manifest.bin)[0], TOOL_ID)
  assert.deepEqual(manifest.dependencies, undefined, 'zero runtime dependencies')
  assert.deepEqual(manifest.devDependencies, undefined, 'zero dev dependencies')
})

test('nothing in the source can reach the network', async () => {
  const sources = await readdir(join(ROOT, 'src'))
  const forbidden = /node:(net|http|https|dns|tls|dgram)|\bfetch\(|XMLHttpRequest|WebSocket/u
  for (const name of [...sources.map((file) => join('src', file)), join('bin', `${TOOL_ID}.mjs`)]) {
    const text = await readFile(join(ROOT, name), 'utf8')
    assert.equal(forbidden.test(text), false, `${name} must not reach the network`)
  }
})
