/**
 * Outbound invitation / password-reset delivery.
 *
 * This deployment is its own authentication provider (section 4.5 permits
 * "another Netlify-compatible JWT authentication mechanism"), so it must also
 * deliver the invite and reset links.
 *
 * Two modes:
 *   - `EMAIL_WEBHOOK_URL` set → the link is POSTed to that endpoint, which is
 *     where you wire up Postmark / SendGrid / SES / an internal relay.
 *   - not set → nothing is sent. The link is returned to the administrator in
 *     the API response so it can be delivered out of band, and a note is
 *     logged. The link itself is NEVER written to the log.
 *
 * Keeping this behind one interface means adding a real provider is a
 * single-file change.
 */

import { logInfo } from './http';

export type DeliveryKind = 'invite' | 'password_reset';

export interface DeliveryRequest {
  kind: DeliveryKind;
  to: string;
  recipientName: string;
  link: string;
  expiresAt: Date;
  correlationId: string;
}

export interface DeliveryResult {
  /** True when an external provider accepted the message. */
  delivered: boolean;
  /**
   * Present only when no provider is configured, so the administrator can copy
   * the link manually. Returned to administrators only.
   */
  manualLink?: string;
}

const SUBJECTS: Record<DeliveryKind, string> = {
  invite: 'You have been invited to Stock Recheck',
  password_reset: 'Reset your Stock Recheck password',
};

function buildBody(request: DeliveryRequest): string {
  const expiry = request.expiresAt.toISOString();
  if (request.kind === 'invite') {
    return [
      `Hello ${request.recipientName},`,
      '',
      'You have been invited to the Stock Recheck application.',
      'Use the link below to choose a password and activate your account:',
      '',
      request.link,
      '',
      `This link expires at ${expiry}.`,
    ].join('\n');
  }
  return [
    `Hello ${request.recipientName},`,
    '',
    'A password reset was requested for your Stock Recheck account.',
    'If this was you, use the link below to choose a new password:',
    '',
    request.link,
    '',
    `This link expires at ${expiry}. If you did not request this, ignore this message.`,
  ].join('\n');
}

export async function deliverLink(request: DeliveryRequest): Promise<DeliveryResult> {
  const webhookUrl = process.env.EMAIL_WEBHOOK_URL;

  if (webhookUrl === undefined || webhookUrl === '') {
    // No provider configured. Note the fact WITHOUT logging the link itself —
    // a link in a log file is a credential in a log file.
    logInfo('mailer.not_configured', {
      correlationId: request.correlationId,
      kind: request.kind,
      note: 'EMAIL_WEBHOOK_URL is unset; the link was returned to the administrator for manual delivery.',
    });
    return { delivered: false, manualLink: request.link };
  }

  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const token = process.env.EMAIL_WEBHOOK_TOKEN;
    if (token !== undefined && token !== '') headers.authorization = `Bearer ${token}`;

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        to: request.to,
        subject: SUBJECTS[request.kind],
        text: buildBody(request),
        kind: request.kind,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      logInfo('mailer.delivery_failed', {
        correlationId: request.correlationId,
        kind: request.kind,
        status: response.status,
      });
      return { delivered: false, manualLink: request.link };
    }

    logInfo('mailer.delivered', { correlationId: request.correlationId, kind: request.kind });
    return { delivered: true };
  } catch (error) {
    logInfo('mailer.delivery_error', {
      correlationId: request.correlationId,
      kind: request.kind,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return { delivered: false, manualLink: request.link };
  }
}

export function buildInviteLink(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/accept-invite?token=${encodeURIComponent(token)}`;
}

export function buildResetLink(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
}
