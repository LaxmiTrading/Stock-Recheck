/**
 * SHIPPED SECURITY HEADERS — specification section 34.
 *
 * The `dev` context in netlify.toml relaxes the Content-Security-Policy so
 * Vite's inline Fast-Refresh preamble can run locally. That relaxation must
 * never leak into the policy that is actually deployed.
 *
 * The obvious way to break this is to "fix" a future local rendering problem by
 * loosening the top-level `[[headers]]` block instead of the dev override, so
 * these tests read netlify.toml directly and assert the shipped policy stays
 * strict.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const netlifyToml = readFileSync(
  fileURLToPath(new URL('../../netlify.toml', import.meta.url)),
  'utf8',
);

/**
 * Splits the file at the `[[context.dev.headers]]` marker. Everything before it
 * is what deploys; everything after is local-only.
 */
const DEV_CONTEXT_MARKER = '[[context.dev.headers]]';
const devContextIndex = netlifyToml.indexOf(DEV_CONTEXT_MARKER);
const deployedSection = devContextIndex === -1 ? netlifyToml : netlifyToml.slice(0, devContextIndex);
const devSection = devContextIndex === -1 ? '' : netlifyToml.slice(devContextIndex);

function extractCsp(section: string): string | null {
  const match = /Content-Security-Policy\s*=\s*"([^"]+)"/.exec(section);
  return match === null ? null : (match[1] as string);
}

function directive(policy: string, name: string): string {
  const found = policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  return found ?? '';
}

describe('deployed security headers', () => {
  const deployedCsp = extractCsp(deployedSection);

  it('defines a Content-Security-Policy for every deployed path', () => {
    expect(deployedCsp).not.toBeNull();
  });

  it('never allows inline or eval script in the deployed policy', () => {
    const scriptSrc = directive(deployedCsp as string, 'script-src');
    expect(scriptSrc).toBe("script-src 'self'");
    expect(scriptSrc).not.toContain('unsafe-inline');
    expect(scriptSrc).not.toContain('unsafe-eval');
  });

  it('keeps the remaining hardening directives', () => {
    const policy = deployedCsp as string;
    expect(directive(policy, 'object-src')).toBe("object-src 'none'");
    expect(directive(policy, 'frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive(policy, 'base-uri')).toBe("base-uri 'self'");
    expect(directive(policy, 'form-action')).toBe("form-action 'self'");
    expect(directive(policy, 'default-src')).toBe("default-src 'self'");
  });

  it('ships the other section 34 headers', () => {
    expect(deployedSection).toContain('X-Frame-Options = "DENY"');
    expect(deployedSection).toContain('X-Content-Type-Options = "nosniff"');
    expect(deployedSection).toContain('Referrer-Policy = "strict-origin-when-cross-origin"');
    expect(deployedSection).toContain('Strict-Transport-Security');
  });

  it('does not permit a remote script origin to be added unnoticed', () => {
    // `script-src 'self'` only — no https:, no wildcard, no CDN host.
    const scriptSrc = directive(deployedCsp as string, 'script-src');
    expect(scriptSrc).not.toMatch(/https?:|\*/);
  });
});

describe('local-development CSP override', () => {
  it('is scoped to the dev context only', () => {
    // If the relaxation ever appears outside `[[context.dev.headers]]`, the
    // deployed policy assertions above are the ones that must fail loudly —
    // this guards the scoping itself.
    expect(devContextIndex).toBeGreaterThan(-1);
    expect(deployedSection).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it('relaxes script-src enough for the Vite preamble', () => {
    const devCsp = extractCsp(devSection);
    expect(devCsp).not.toBeNull();
    expect(directive(devCsp as string, 'script-src')).toContain("'unsafe-inline'");
  });

  it('still forbids plugins and framing while developing', () => {
    const devCsp = extractCsp(devSection) as string;
    expect(directive(devCsp, 'object-src')).toBe("object-src 'none'");
    expect(directive(devCsp, 'frame-ancestors')).toBe("frame-ancestors 'none'");
  });
});
