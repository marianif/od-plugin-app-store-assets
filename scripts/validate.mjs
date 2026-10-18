#!/usr/bin/env node
// Validate a generated asset plan against the spec snapshot + Apple copy rules.
//
//   node .app-store-assets/scripts/validate.mjs --plan asset-plan.json
//
// Exit code 0 = no P0 blockers, 1 = blockers, 2 = bad input.
// Writes validation-report.md next to the plan unless --report is given.

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, fail } from './lib/daemon.mjs';
import { loadSnapshot } from './lib/specs.mjs';
import { validatePlan, renderReport } from './lib/plan.mjs';

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(`validate.mjs — check generated assets

  --plan <file>       asset-plan.json (default asset-plan.json)
  --refdata <file>    spec snapshot (default .app-store-assets/references/refdata-snapshot.json)
  --report <file>     markdown report (default validation-report.md)
  --json              print the machine-readable result
  --strict            treat P1 warnings as failures too
`);
    return;
  }

  const planPath = path.resolve(String(flags.plan || 'asset-plan.json'));
  let plan;
  try {
    plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
  } catch (err) {
    fail(`cannot read ${planPath}: ${err.message}`, 2);
  }

  const snapshot = await loadSnapshot(typeof flags.refdata === 'string' ? flags.refdata : undefined);
  const { findings, summary } = await validatePlan({ plan, snapshot: snapshot.data, cwd: process.cwd() });
  const reportPath = path.resolve(String(flags.report || 'validation-report.md'));
  const report = renderReport({ plan, findings, summary });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, report, 'utf8');

  const result = {
    ok: summary.p0 === 0 && (!flags.strict || summary.p1 === 0),
    plan: path.relative(process.cwd(), planPath),
    report: path.relative(process.cwd(), reportPath),
    refdata: path.relative(process.cwd(), snapshot.path),
    summary,
    findings,
  };

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n${result.ok ? '✓ PASS' : '✗ FAIL'} · ${summary.assets} assets · P0 ${summary.p0} · P1 ${summary.p1} · P2 ${summary.p2}`);
    for (const finding of findings.filter((f) => f.severity !== 'P2')) {
      console.log(`  ${finding.severity} ${finding.assetId ? `[${finding.assetId}] ` : ''}${finding.message}`);
    }
    console.log(`\nreport: ${path.relative(process.cwd(), reportPath)}\n`);
  }

  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => fail(err?.stack || err?.message || String(err)));
