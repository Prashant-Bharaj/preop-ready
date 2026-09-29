/**
 * scopes: [backend]
 * flags: [notifications-email]
 * description: SMTP client (TypeScript) for sending email via Bayer EBR (ebr.bayer.com:2525) — no credentials.
 */

/**
 * SMTP Email Client (Bayer EBR) — TypeScript
 *
 * Sends emails via Bayer's External Bayer Relay (ebr.bayer.com:2525), the
 * approved way to send @bayer.com email from the platform's AWS account.
 * Supports plain text, HTML, attachments, and template-based emails.
 * In development mode, emails are logged to the console instead of sent.
 *
 * Dependencies:
 *   npm install nodemailer
 *   npm install -D @types/nodemailer
 *
 * NO SMTP CREDENTIALS — none exist, do not ask the user for any:
 *   EBR allows the platform's outbound IPs; it does not authenticate.
 *   Never add SMTP_USER / SMTP_PASSWORD or put a personal Bayer password
 *   in a GitHub Secret for this.
 *
 * Environment variables:
 *   SMTP_HOST = ebr.bayer.com   (auto-injected into every backend container)
 *   SMTP_PORT = 2525            (auto-injected)
 *
 *   Default sender (optional):
 *     Local dev: EMAIL_SENDER in backend/.env.
 *     Production: add GitHub Secret APP_SECRET_3 with a @bayer.com address;
 *     it becomes SECRET_3 in the container.
 *   Resolution order: explicit `from` → EMAIL_SENDER → SECRET_3.
 *
 * Sender address — MUST be @bayer.com (EBR rejects anything else):
 *   1. Send as the logged-in user (user-triggered email): use `req.user.email`
 *      from snippets/auth/user-identity.ts. No setup.
 *   2. Send from a shared mailbox (notifications, cron jobs): e.g.
 *      noreply-<project>@bayer.com, requested once from the Bayer Messaging
 *      team via ServiceNow (Order Something → Messaging Engineer/Analyst).
 *
 * TLS: EBR requires StartTLS, TLSv1.2 or higher.
 *
 * Local development:
 *   When NODE_ENV=development, emails are NOT sent — the full payload is
 *   logged. EBR only accepts the platform's AWS IPs, so real sends only
 *   work from the deployed app.
 *
 * Example:
 *   import { sendEmail, sendTemplateEmail } from './smtp-client.js';
 *
 *   await sendEmail({
 *     from: req.user.email,
 *     to: 'colleague@bayer.com',
 *     subject: 'Hello',
 *     text: 'hi',
 *   });
 *
 *   await sendTemplateEmail({
 *     from: 'noreply-myproject@bayer.com',
 *     to: 'team@bayer.com',
 *     subject: 'Weekly report',
 *     templateFn: (d: { title: string }) => `<h1>${d.title}</h1>`,
 *     data: { title: 'Sprint 42' },
 *   });
 */

import nodemailer, {
  type Transporter,
  type SendMailOptions,
  type SentMessageInfo,
} from 'nodemailer';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const SMTP_CONFIG = {
  host: process.env.SMTP_HOST || 'ebr.bayer.com',
  port: parseInt(process.env.SMTP_PORT || '2525', 10),
  secure: false,
  requireTLS: true,
  tls: { minVersion: 'TLSv1.2' },
} as const;

export type EmailAddress = string | string[];

export interface SendEmailOptions {
  to: EmailAddress;
  subject: string;
  html?: string;
  text?: string;
  cc?: EmailAddress;
  bcc?: EmailAddress;
  /** Sender — must be @bayer.com. Falls back to EMAIL_SENDER, then SECRET_3. */
  from?: string;
  attachments?: SendMailOptions['attachments'];
}

export type EmailTemplateFn<T> = (data: T) => string;

export interface SendTemplateEmailOptions<T> {
  to: EmailAddress;
  subject: string;
  templateFn: EmailTemplateFn<T>;
  data: T;
  from?: string;
}

// Mock transport returns a partial of SentMessageInfo — keep the shape compatible.
interface MockSentMessageInfo {
  messageId: string;
  accepted: string[];
}

type MaybeTransporter =
  | Transporter
  | {
      sendMail: (options: SendMailOptions) => Promise<MockSentMessageInfo>;
    };

let _transporter: MaybeTransporter | null = null;

/**
 * Create (or return the cached) nodemailer transporter.
 *
 * In development mode, returns a mock transport that logs to console.
 */
export function createTransporter(): MaybeTransporter {
  if (_transporter) return _transporter;

  // -------------------------------------------------------------------------
  // Development mock — log emails to console instead of sending
  // -------------------------------------------------------------------------
  if (process.env.NODE_ENV === 'development') {
    console.log('[SMTP Mock] Using mock transporter — emails will be logged, not sent.');
    _transporter = {
      sendMail: async (mailOptions: SendMailOptions): Promise<MockSentMessageInfo> => {
        console.log('\n===== MOCK EMAIL =====');
        console.log('From:   ', mailOptions.from);
        console.log('To:     ', mailOptions.to);
        if (mailOptions.cc) console.log('CC:     ', mailOptions.cc);
        if (mailOptions.bcc) console.log('BCC:    ', mailOptions.bcc);
        console.log('Subject:', mailOptions.subject);
        if (mailOptions.text) console.log('Text:   ', mailOptions.text);
        if (mailOptions.html) console.log('HTML:   ', mailOptions.html);
        if (Array.isArray(mailOptions.attachments)) {
          console.log(
            'Attachments:',
            mailOptions.attachments.map((a) => a.filename).join(', ')
          );
        }
        console.log('======================\n');
        const toArr = Array.isArray(mailOptions.to)
          ? (mailOptions.to as string[])
          : [String(mailOptions.to ?? '')];
        return {
          messageId: `mock-${Date.now()}@development`,
          accepted: toArr,
        };
      },
    };
    return _transporter;
  }

  // -------------------------------------------------------------------------
  // Production transporter — EBR, no auth
  // -------------------------------------------------------------------------
  _transporter = nodemailer.createTransport(SMTP_CONFIG);
  return _transporter;
}

/**
 * Sends an email via Bayer's External Bayer Relay (EBR).
 */
export async function sendEmail(
  options: SendEmailOptions
): Promise<SentMessageInfo | MockSentMessageInfo> {
  const { to, subject, html, text, cc, bcc, from, attachments } = options;

  // Sender resolution order: explicit arg -> local-dev env var -> platform secret slot
  const sender = from || process.env.EMAIL_SENDER || process.env.SECRET_3;
  if (!sender) {
    throw new Error(
      'sendEmail: sender required (must be a @bayer.com address). ' +
        'Pass `from` per-call, set EMAIL_SENDER in backend/.env for local dev, ' +
        'or add APP_SECRET_3 (@bayer.com address) in GitHub Secrets for prod.'
    );
  }
  if (!to) throw new Error('sendEmail: "to" is required.');
  if (!subject) throw new Error('sendEmail: "subject" is required.');
  if (!html && !text) {
    throw new Error('sendEmail: provide at least "html" or "text" body.');
  }
  if (!sender.toLowerCase().endsWith('@bayer.com')) {
    throw new Error(
      `sendEmail: sender must be a @bayer.com address (got "${sender}"). EBR rejects other senders.`
    );
  }

  const transporter = createTransporter();

  const mailOptions: SendMailOptions = {
    from: sender,
    to,
    subject,
    ...(text && { text }),
    ...(html && { html }),
    ...(cc && { cc }),
    ...(bcc && { bcc }),
    ...(attachments && { attachments }),
  };

  try {
    const result = await transporter.sendMail(mailOptions);
    console.log(`[SMTP] Email sent — messageId: ${result.messageId}`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[SMTP] Failed to send email:', message);
    throw new Error(`Failed to send email: ${message}`);
  }
}

/**
 * Sends an HTML email built from a template function.
 */
export async function sendTemplateEmail<T>(
  options: SendTemplateEmailOptions<T>
): Promise<SentMessageInfo | MockSentMessageInfo> {
  const { from, to, subject, templateFn, data } = options;
  if (typeof templateFn !== 'function') {
    throw new Error(
      'sendTemplateEmail: templateFn must be a function that returns an HTML string.'
    );
  }

  const html = templateFn(data);
  return sendEmail({ from, to, subject, html });
}
