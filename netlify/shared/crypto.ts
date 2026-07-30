/**
 * Symmetric encryption for secrets that must be persisted server-side.
 *
 * Used only for the Zoho refresh token obtained through the in-app OAuth flow
 * (see migration 0002 for why it cannot live in an environment variable in
 * that path).
 *
 * AES-256-GCM provides confidentiality AND integrity, so a tampered ciphertext
 * fails to decrypt rather than yielding attacker-chosen plaintext.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const KEY_BYTES = 32;
/** Fixed salt: the input key material is already high-entropy secret material. */
const KEY_SALT = 'stock-recheck.secret-box.v1';

function deriveKey(): Buffer {
  const material = process.env.ZOHO_TOKEN_KEY ?? process.env.AUTH_JWT_SECRET;
  if (material === undefined || material.length < 32) {
    throw new Error(
      'Cannot encrypt secrets: set ZOHO_TOKEN_KEY (or AUTH_JWT_SECRET) to at least 32 characters.',
    );
  }
  return scryptSync(material, KEY_SALT, KEY_BYTES);
}

/** Returns `iv.tag.ciphertext`, each part base64url-encoded. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, deriveKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(
    '.',
  );
}

/** Returns null when the value is malformed or fails authentication. */
export function decryptSecret(encoded: string): string | null {
  const parts = encoded.split('.');
  if (parts.length !== 3) return null;

  try {
    const [ivRaw, tagRaw, dataRaw] = parts as [string, string, string];
    const decipher = createDecipheriv(
      ALGORITHM,
      deriveKey(),
      Buffer.from(ivRaw, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));

    return Buffer.concat([
      decipher.update(Buffer.from(dataRaw, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Wrong key or tampered ciphertext.
    return null;
  }
}
