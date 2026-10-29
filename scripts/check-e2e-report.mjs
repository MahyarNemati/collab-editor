#!/usr/bin/env node
/**
 * Fail CI when the browser suite did not actually run.
 *
 * Same reasoning as `check-test-report.mjs`: Playwright exits 0 when it has
 * nothing to run, and a browser suite is the easiest kind to silently skip —
 * a bad selector, a webServer that never came up, a filter that matched
 * nothing. So the report is read and the specific specs that cover
 * convergence and offline persistence are required by name.
 *
 * Usage: node scripts/check-e2e-report.mjs <report.json> <minSpecs> <pattern...>
 */
import { readFile } from 'node:fs/promises';

const [reportPath, minSpecsRaw, ...patterns] = process.argv.slice(2);
if (reportPath === undefined || minSpecsRaw === undefined) {
  console.error('usage: check-e2e-report.mjs <report.json> <minSpecs> [pattern...]');
  process.exit(2);
}
const minSpecs = Number(minSpecsRaw);
const report = JSON.parse(await readFile(reportPath, 'utf8'));

const collectSpecs = (suite) => [
  ...(suite.specs ?? []),
  ...(suite.suites ?? []).flatMap(collectSpecs),
];
const specs = (report.suites ?? []).flatMap(collectSpecs);
const stats = report.stats ?? {};

const problems = [];
if (specs.length < minSpecs) {
  problems.push(`only ${specs.length} spec(s) ran, expected at least ${minSpecs}`);
}
const failed = specs.filter((spec) => spec.ok !== true).map((spec) => spec.title);
if (failed.length > 0) problems.push(`failed spec(s): ${failed.join(', ')}`);
if (Number(stats.unexpected ?? 0) > 0) {
  problems.push(`${stats.unexpected} unexpected result(s)`);
}
if (Number(stats.skipped ?? 0) > 0) {
  problems.push(`${stats.skipped} spec(s) were skipped`);
}
for (const pattern of patterns) {
  const regex = new RegExp(pattern, 'i');
  if (!specs.some((spec) => regex.test(spec.title ?? ''))) {
    problems.push(`no spec matched required pattern /${pattern}/i`);
  }
}

if (problems.length > 0) {
  console.error('e2e report check failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`e2e ok: ${specs.length} spec(s) passed, required patterns present`);
