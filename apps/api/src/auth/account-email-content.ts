import {
  accountEmailUnavailable,
  type AccountEmailKind,
} from './account-email.service.js';

/**
 * Account email content and links, shared by every provider (Gmail, SMTP): the same subject,
 * text and single-use link whichever way the message is delivered.
 */
const DEVELOPMENT_WEB_ORIGIN = 'http://localhost:3000';

/** The page each kind of link opens; the token travels in the fragment (never sent to servers). */
const LINK_PATHS: Record<AccountEmailKind, string> = {
  invitation: '/accept-invitation',
  'password-reset': '/reset-password',
  verification: '/verify-email',
};

export function accountEmailContent(
  kind: AccountEmailKind,
  link: string,
  expiresAt: Date,
): { subject: string; text: string } {
  const expiry = `${expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  const ignore =
    'If you did not expect this email, you can ignore it; nothing changes until the link is used.';
  switch (kind) {
    case 'invitation':
      return {
        subject: 'Your HRMS account invitation',
        text: [
          'You have been invited to the HRMS, where you can see your schedule, time, leave, pay and profile.',
          '',
          'Choose your own password to activate your account:',
          link,
          '',
          `This link works once and expires on ${expiry}.`,
          ignore,
        ].join('\n'),
      };
    case 'password-reset':
      return {
        subject: 'Reset your HRMS password',
        text: [
          'A password reset was requested for your HRMS account.',
          '',
          'Choose a new password:',
          link,
          '',
          `This link works once and expires on ${expiry}.`,
          ignore,
        ].join('\n'),
      };
    case 'verification':
      return {
        subject: 'Verify your HRMS email address',
        text: [
          'Confirm this email address for your HRMS account:',
          link,
          '',
          `This link works once and expires on ${expiry}.`,
          ignore,
        ].join('\n'),
      };
  }
}

/** The link the message carries; the token travels in the fragment (never sent to servers). */
export function accountEmailLink(
  kind: AccountEmailKind,
  token: string,
  settings: { production: boolean; webOrigin?: string },
) {
  let origin = settings.webOrigin;
  if (!origin) {
    if (settings.production)
      throw accountEmailUnavailable(
        'WEB_ORIGIN is required to build account email links.',
      );
    origin = DEVELOPMENT_WEB_ORIGIN;
  }
  return `${origin}${LINK_PATHS[kind]}#token=${encodeURIComponent(token)}`;
}
