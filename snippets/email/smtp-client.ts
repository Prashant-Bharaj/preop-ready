/**
 * scopes: [backend]
 * flags: [notifications-email]
 * description: SMTP client (TypeScript) for sending transactional email via the corp relay.
 */

/**
 * SMTP Email Client (Bayer Internal) — TypeScript
 *
 * Sends emails via Bayer's internal SMTP relay (exsmtp.na.bayer.cnb).
 * Supports plain text, HTML, attachments, and template-based emails.
 * In development mode, emails are logged to the console instead of sent.
 *
 * Dependencies:
 *   npm install nodemailer
 *   npm install -D @types/nodemailer
 *
 * Environment variables (GitHub Secrets -> Container):
 *   SMTP_USER       — Bayer email (first.last@bayer.com)
 *   SMTP_PASSWORD   — Bayer network password
 *
 *   Map APP_SECRET_1/2 (or 3/4) -> SECRET_1/2 -> SMTP_USER/SMTP_PASSWORD in your stack config:
 *     environment:
 *       SMTP_USER: ${SECRET_1}
 *       SMTP_PASSWORD: ${SECRET_2}
 *
 * Local development:
 *   When NODE_ENV=development, emails are NOT sent. Instead, the full email
 *   payload is logged so you can verify content without SMTP credentials.
 *
 * Example:
 *   import { sendEmail, sendTemplateEmail } from './smtp-client.js';
 *   await sendEmail({ to: 'a@bayer.com', subject: 'Hello', text: 'hi' });
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
  host: 'exsmtp.na.bayer.cnb',
  port: 25,
  secure: false, // Bayer internal SMTP — no TLS required
  tls: { rejectUnauthorized: false },
} as const;

export type EmailAddress = string | string[];

export interface SendEmailOptions {
  to: EmailAddress;
  subject: string;
  html?: string;
  text?: string;
  cc?: EmailAddress;
  bcc?: EmailAddress;
  from?: string;
  attachments?: SendMailOptions['attachments'];
}

export type EmailTemplateFn<T> = (data: T) => string;

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
  // Production transporter
  // -------------------------------------------------------------------------
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;

  if (!user || !pass) {
    throw new Error(
      'SMTP credentials not configured. Set SMTP_USER and SMTP_PASSWORD environment variables. ' +
        'See the snippet header for GitHub Secrets setup instructions.'
    );
  }

  _transporter = nodemailer.createTransport({
    ...SMTP_CONFIG,
    auth: { user, pass },
  });

  return _transporter;
}

/**
 * Sends an email via Bayer's internal SMTP server.
 */
export async function sendEmail(
  options: SendEmailOptions
): Promise<SentMessageInfo | MockSentMessageInfo> {
  const { to, subject, html, text, cc, bcc, from, attachments } = options;

  if (!to) throw new Error('sendEmail: "to" is required.');
  if (!subject) throw new Error('sendEmail: "subject" is required.');
  if (!html && !text) {
    throw new Error('sendEmail: provide at least "html" or "text" body.');
  }

  const transporter = createTransporter();

  const mailOptions: SendMailOptions = {
    from: from || process.env.SMTP_USER,
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
    console.log(`[SMTP] Email sent to ${to} — messageId: ${result.messageId}`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[SMTP] Failed to send email to ${to}:`, message);
    throw new Error(`Failed to send email: ${message}`);
  }
}

/**
 * Sends an HTML email built from a template function.
 */
export async function sendTemplateEmail<T extends object>(
  to: EmailAddress,
  subject: string,
  templateFn: EmailTemplateFn<T>,
  data: T
): Promise<SentMessageInfo | MockSentMessageInfo> {
  if (typeof templateFn !== 'function') {
    throw new Error(
      'sendTemplateEmail: templateFn must be a function that returns an HTML string.'
    );
  }

  const html = templateFn(data);
  return sendEmail({ to, subject, html });
}
