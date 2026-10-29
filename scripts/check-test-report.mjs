#!/usr/bin/env node
/**
 * Fail CI when the test suite ran but did not test anything.
 *
 * A suite that compiles, runs and reports success while exercising nothing goes
 * green and teaches you nothing. So CI does not trust the tick: it reads the
 * machine-readable report and asserts a floor on the number of tests, zero
 * failures, and that the named suites which cover the hard parts were actually
 * present in this run.
 *
 * Usage: node scripts/check-test-report.mjs <report.json> <minTests> <pattern...>
 */
import { readFile } from 'node:fs/promises';

const [reportPath, minTestsRaw, ...patterns] = process.argv.slice(2);
if (reportPath === undefined || minTestsRaw === undefined) {
  console.error(
    'usage: check-test-report.mjs <report.json> <minTests> [requiredPattern...]',
  );
  process.exit(2);
}
const minTests = Number(minTestsRaw);

const report = JSON.parse(await readFile(reportPath, 'utf8'));

const results = Array.isArray(report.testResults) ? report.testResults : [];
const titles = results.flatMap((file) =>
  (file.assertionResults ?? []).map(
    (test) => `${file.name ?? ''} ${(test.ancestorTitles ?? []).join(' ')} ${test.title ?? ''}`,
  ),
);
const passed = Number(report.numPassedTests ?? 0);
const failed = Number(report.numFailedTests ?? 0);
const total = Number(report.numTotalTests ?? 0);

const problems = [];
if (failed > 0) problems.push(`${failed} test(s) failed`);
if (total < minTests) {
  problems.push(`only ${total} tests ran, expected at least ${minTests}`);
}
if (passed !== total) {
  problems.push(`${total - passed} test(s) did not pass (skipped or todo)`);
}
for (const pattern of patterns) {
  const regex = new RegExp(pattern, 'i');
  if (!titles.some((title) => regex.test(title))) {
    problems.push(`no test matched required pattern /${pattern}/i`);
  }
}

if (problems.length > 0) {
  console.error('test report check failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `test report ok: ${passed}/${total} passed across ${results.length} files, ` +
    `all ${patterns.length} required suite pattern(s) present`,
);
