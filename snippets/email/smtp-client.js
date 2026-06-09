/**
 * scopes: [backend]
 * flags: [notifications-email]
 * description: SMTP client for sending email via Bayer EBR (ebr.bayer.com:2525).
 */

/**
 * SNIPPET: SMTP Email Client (Bayer EBR)
 * CATEGORY: Integration
 * LANGUAGE: JavaScript (Node.js)
 * STATUS: Ready
 *
 * DESCRIPTION:
 *   Sends emails via Bayer's External Bayer Relay (ebr.bayer.com:2525).
 *   The EBR is the approved method for sending @bayer.com emails from AWS.
 *   Supports plain text, HTML, attachments, and template-based emails.
 *   In development mode, emails are logged to the console instead of sent.
 *
 * DEPENDENCIES:
 *   npm install nodemailer
 *
 * ENVIRONMENT VARIABLES:
 *   SMTP_HOST and SMTP_PORT are automatically injected by the platform
 *   into every backend container — no setup required:
 *
 *     SMTP_HOST  = ebr.bayer.com   (auto-injected)
 *     SMTP_PORT  = 2525            (auto-injected)
 *
 *   EBR uses IP-based whitelisting (the AWS VPC's Central NAT Gateway
 *   public IPs are pre-whitelisted on the EBR side), so no SMTP
 *   credentials are needed.
 *
 *   Default sender (optional):
 *     For local dev, you can name your own env var (e.g. EMAIL_SENDER)
 *     in `backend/.env` or docker-compose.yml.
 *     For prod, use the platform's generic "admin email" slot:
 *       Add `APP_SECRET_3` in GitHub Secrets with your @bayer.com
 *       sender address. It becomes `SECRET_3` in the container.
 *     The snippet falls back through: explicit `from` arg → EMAIL_SENDER
 *     env var → SECRET_3.
 *
 * SENDER ADDRESS REQUIREMENT:
 *   The "From" address MUST be a valid @bayer.com address. EBR will
 *   reject emails with non-Bayer sender addresses.
 *
 *   Two valid sender patterns:
 *
 *   1. "Send as the logged-in user" — for emails triggered by a user
 *      action (e.g. "send this report to a colleague"). Use the user's
 *      email from the OIDC token (x-amzn-oidc-data header). See the
 *      auth/user-identity snippet for details.
 *
 *      Pros: clean audit trail (real sender), no extra setup.
 *      Cons: requires a logged-in user; can't be used for system jobs.
 *
 *   2. "Send from a shared mailbox" — for app-generated emails not tied
 *      to a specific user (notifications, alerts, cron job output, etc.).
 *      Requires a shared mailbox provisioned by the Bayer Messaging team
 *      via ServiceNow (Order Something -> Messaging Engineer/Analyst).
 *      Common pattern: noreply-<project>@bayer.com.
 *
 *      Pros: works for system-generated email; clear "from app" identity.
 *      Cons: one-time provisioning request needed.
 *
 * TLS:
 *   EBR requires StartTLS with TLSv1.2 or higher.
 *
 * LOCAL DEVELOPMENT:
 *   When NODE_ENV=development, emails are NOT sent. Instead, the full
 *   email payload is logged to the console so you can verify content
 *   and recipients without hitting EBR.
 *
 * USAGE:
 *   const { sendEmail, sendTemplateEmail } = require('./smtp-client');
 *
 *   // Pattern 1: send as the logged-in user (from OIDC)
 *   await sendEmail({
 *     from: userEmail,  // e.g. extracted from x-amzn-oidc-data
 *     to: 'colleague@bayer.com',
 *     subject: 'Hello from DD Platform',
 *     text: 'This is a plain text email.',
 *   });
 *
 *   // Pattern 2: send from a shared mailbox (provisioned via Messaging team)
 *   await sendEmail({
 *     from: 'noreply-myproject@bayer.com',
 *     to: 'user@bayer.com',
 *     subject: 'Your weekly report is ready',
 *     text: 'Daily digest of your project activity.',
 *   });
 *
 *   // HTML email
 *   await sendEmail({
 *     from: userEmail,
 *     to: ['alice@bayer.com', 'bob@bayer.com'],
 *     cc: 'manager@bayer.com',
 *     subject: 'Weekly Report',
 *     html: '<h1>Report</h1><p>Everything is on track.</p>',
 *   });
 *
 *   // Template email
 *   const reportTemplate = (data) => `
 *     <h1>${data.title}</h1>
 *     <p>Status: ${data.status}</p>
 *     <p>Generated: ${new Date().toISOString()}</p>
 *   `;
 *   await sendTemplateEmail(
 *     userEmail,
 *     'team@bayer.com',
 *     'Weekly Report',
 *     reportTemplate,
 *     { title: 'Sprint 42', status: 'On Track' }
 *   );
 *
 *   // With attachments
 *   await sendEmail({
 *     from: userEmail,
 *     to: 'colleague@bayer.com',
 *     subject: 'File attached',
 *     text: 'Please see the attached file.',
 *     attachments: [
 *       { filename: 'report.pdf', path: '/tmp/report.pdf' },
 *       { filename: 'data.csv', content: 'col1,col2\nval1,val2' },
 *     ],
 *   });
 */

const nodemailer = require('nodemailer');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const SMTP_CONFIG = {
  host: process.env.SMTP_HOST || 'ebr.bayer.com',
  port: parseInt(process.env.SMTP_PORT || '2525', 10),
  secure: false,
  requireTLS: true,
  tls: { minVersion: 'TLSv1.2' },
};

// ---------------------------------------------------------------------------
// Transporter
// ---------------------------------------------------------------------------

/** @type {import('nodemailer').Transporter | null} */
let _transporter = null;

/**
 * Creates (or returns the cached) nodemailer transporter.
 *
 * In development mode, returns a mock transport that logs to console.
 *
 * @returns {import('nodemailer').Transporter}
 */
function createTransporter() {
  if (_transporter) return _transporter;

  if (process.env.NODE_ENV === 'development') {
    console.log('[SMTP Mock] Using mock transporter — emails will be logged, not sent.');
    _transporter = {
      sendMail: async (mailOptions) => {
        console.log('\n===== MOCK EMAIL =====');
        console.log('From:   ', mailOptions.from);
        console.log('To:     ', mailOptions.to);
        if (mailOptions.cc) console.log('CC:     ', mailOptions.cc);
        if (mailOptions.bcc) console.log('BCC:    ', mailOptions.bcc);
        console.log('Subject:', mailOptions.subject);
        if (mailOptions.text) console.log('Text:   ', mailOptions.text);
        if (mailOptions.html) console.log('HTML:   ', mailOptions.html);
        if (mailOptions.attachments) {
          console.log('Attachments:', mailOptions.attachments.map((a) => a.filename).join(', '));
        }
        console.log('======================\n');
        return { messageId: `mock-${Date.now()}@development`, accepted: [mailOptions.to].flat() };
      },
    };
    return _transporter;
  }

  _transporter = nodemailer.createTransport(SMTP_CONFIG);
  return _transporter;
}

// ---------------------------------------------------------------------------
// Send functions
// ---------------------------------------------------------------------------

/**
 * Sends an email via Bayer's External Bayer Relay (EBR).
 *
 * @param {Object} options
 * @param {string}          options.from      — sender address (REQUIRED, must be @bayer.com)
 * @param {string|string[]} options.to        — recipient(s)
 * @param {string}          options.subject   — email subject
 * @param {string}          [options.html]    — HTML body
 * @param {string}          [options.text]    — plain text body
 * @param {string|string[]} [options.cc]      — CC recipient(s)
 * @param {string|string[]} [options.bcc]     — BCC recipient(s)
 * @param {Array}           [options.attachments] — nodemailer attachment objects
 * @returns {Promise<Object>} nodemailer send result ({ messageId, accepted, ... })
 */
async function sendEmail({ from, to, subject, html, text, cc, bcc, attachments } = {}) {
  // Sender resolution order: explicit arg -> local-dev env var -> platform secret slot
  const sender = from || process.env.EMAIL_SENDER || process.env.SECRET_3;
  if (!sender) {
    throw new Error(
      'sendEmail: sender required (must be a @bayer.com address). ' +
        'Pass `from` per-call, set EMAIL_SENDER env var for local dev, ' +
        'or add APP_SECRET_3 (@bayer.com address) in GitHub Secrets for prod.'
    );
  }
  if (!to) throw new Error('sendEmail: "to" is required.');
  if (!subject) throw new Error('sendEmail: "subject" is required.');
  if (!html && !text) throw new Error('sendEmail: provide at least "html" or "text" body.');
  if (!String(sender).toLowerCase().endsWith('@bayer.com')) {
    throw new Error(`sendEmail: sender must be a @bayer.com address (got "${sender}"). EBR will reject other senders.`);
  }

  const transporter = createTransporter();

  const mailOptions = {
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
    console.log(`[SMTP] Email sent to ${to} — messageId: ${result.messageId}`);
    return result;
  } catch (error) {
    console.error(`[SMTP] Failed to send email to ${to}:`, error.message);
    throw new Error(`Failed to send email: ${error.message}`);
  }
}

/**
 * Sends an HTML email built from a template function.
 *
 * @param {string}          from       — sender address (must be @bayer.com)
 * @param {string|string[]} to         — recipient(s)
 * @param {string}          subject    — email subject
 * @param {Function}        templateFn — (data) => htmlString
 * @param {Object}          data       — data passed to the template function
 * @returns {Promise<Object>} nodemailer send result
 */
async function sendTemplateEmail({ from, to, subject, templateFn, data = {} } = {}) {
  if (typeof templateFn !== 'function') {
    throw new Error('sendTemplateEmail: templateFn must be a function that returns an HTML string.');
  }

  const html = templateFn(data);
  return sendEmail({ from, to, subject, html });
}

module.exports = {
  createTransporter,
  sendEmail,
  sendTemplateEmail,
};
