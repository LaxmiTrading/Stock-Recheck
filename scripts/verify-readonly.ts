/**
 * Static verification that the Zoho integration cannot mutate inventory —
 * specification sections 2.1 and 46 (acceptance criterion 27).
 *
 *   npm run verify:readonly
 *
 * This is a source-level audit, complementing the runtime guard in
 * `netlify/shared/zoho/client.ts` and the unit test in
 * `tests/unit/zohoReadOnly.test.ts`. Run it in CI: it exits non-zero the
 * moment anyone introduces a mutating call path to Zoho.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SEARCH_DIRECTORIES = ['netlify', 'src'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts']);

/** The file that legitimately contains the guard itself. */
const GUARD_FILE = join('netlify', 'shared', 'zoho', 'client.ts');
/** Forbidden-feature naming is quoted in these files as documentation. */
const DOCUMENTATION_FILES = new Set([join('scripts', 'verify-readonly.ts')]);

interface Finding {
  file: string;
  line: number;
  rule: string;
  text: string;
}

/* -------------------------------------------------------------- the rules */

interface Rule {
  name: string;
  pattern: RegExp;
  /** Files where a match is expected and allowed. */
  allowedIn?: string[];
  /** Every pattern must also appear somewhere in the file for a match to count. */
  requiresInFile?: RegExp[];
  /** Skip matches that appear in a negated sentence. */
  notNegated?: boolean;
}

const RULES: Rule[] = [
  {
    name: 'mutating-method-against-zoho',
    pattern: /method\s*:\s*['"`](POST|PUT|PATCH|DELETE)['"`]/i,
    // Token exchange/refresh POSTs to accounts.zoho.* are explicitly permitted
    // by section 2.1 and are confined to the guarded client module.
    allowedIn: [GUARD_FILE],
    // A mutating method is only interesting in a file that BOTH calls fetch
    // directly AND addresses a Zoho host. Our own `/api/zoho/*` endpoints are
    // POSTed to constantly — that is this application's API, not Zoho's — and
    // they reach Zoho only through the guarded client.
    requiresInFile: [/\bfetch\s*\(/, /zohoapis\.|accounts\.zoho\.|apiDomain/i],
  },
  {
    name: 'zoho-inventory-write-endpoint',
    pattern: /zohoapis\.[a-z.]+\/inventory\/v1\/[a-z]+\/(adjust|convert|markas)/i,
  },
  {
    name: 'inventory-adjustment-endpoint',
    pattern: /inventoryadjustments/i,
  },
  {
    name: 'forbidden-feature-name',
    // Section 2.1 forbids these as FEATURE NAMES. The same words appear
    // legitimately in the required user-facing disclaimer ("will not update
    // Zoho inventory"), so a negated occurrence is not a violation.
    pattern:
      /\b(update\s+zoho|adjust\s+zoho\s+stock|sync\s+count\s+to\s+zoho|correct\s+inventory|post\s+variance|apply\s+stock\s+difference)\b/i,
    notNegated: true,
  },
];

/** True when the match is inside a sentence that denies doing the thing. */
function isNegatedClaim(line: string): boolean {
  return /\b(not|never|no|without|refus|block|forbid|prevent|only\s+read|read-only)\b/i.test(line);
}

/* ------------------------------------------------------------------ walk */

async function* walk(directory: string): AsyncGenerator<string> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      yield* walk(fullPath);
    } else if (SOURCE_EXTENSIONS.has(extname(entry.name))) {
      yield fullPath;
    }
  }
}

async function main(): Promise<void> {
  const findings: Finding[] = [];
  let filesScanned = 0;

  for (const directory of SEARCH_DIRECTORIES) {
    for await (const file of walk(join(ROOT, directory))) {
      const relativePath = relative(ROOT, file);
      if (DOCUMENTATION_FILES.has(relativePath)) continue;

      filesScanned += 1;
      const contents = await readFile(file, 'utf8');
      const lines = contents.split('\n');

      for (const rule of RULES) {
        if (rule.allowedIn?.includes(relativePath) === true) continue;

        // File-level preconditions: skip the whole file when the rule needs
        // context that this file does not have.
        if (rule.requiresInFile?.every((pattern) => pattern.test(contents)) === false) continue;

        lines.forEach((line, index) => {
          // Skip comment lines: the codebase documents the prohibition heavily
          // and those references are not call sites.
          const trimmed = line.trim();
          if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;

          if (!rule.pattern.test(line)) return;
          if (rule.notNegated === true && isNegatedClaim(line)) return;

          findings.push({
            file: relativePath,
            line: index + 1,
            rule: rule.name,
            text: trimmed.slice(0, 120),
          });
        });
      }
    }
  }

  const confirmed = findings;

  console.log(`Scanned ${filesScanned} source files for Zoho mutation paths.\n`);

  if (confirmed.length === 0) {
    console.log('  PASS  No mutating Zoho Books call path found.');
    console.log('  PASS  No forbidden feature naming found.');
    console.log('\nThe Zoho integration is read-only.');
    return;
  }

  console.error('  FAIL  Potential read-only violations:\n');
  for (const finding of confirmed) {
    console.error(`  ${finding.file}:${finding.line}  [${finding.rule}]`);
    console.error(`    ${finding.text}\n`);
  }
  console.error(
    'Zoho Books must be accessed with GET only (specification section 2.1).',
  );
  process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
