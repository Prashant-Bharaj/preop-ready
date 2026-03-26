/**
 * SNIPPET: SMTP Email Client (Bayer Internal)
 * CATEGORY: Integration
 * LANGUAGE: JavaScript (Node.js)
 * STATUS: Ready
 *
 * DESCRIPTION:
 *   Sends emails via Bayer's internal SMTP relay (exsmtp.na.bayer.cnb).
 *   Supports plain text, HTML, attachments, and template-based emails.
 *   In development mode, emails are logged to the console instead of sent.
 *
 * DEPENDENCIES:
 *   npm install nodemailer
 *
 * ENVIRONMENT VARIABLES (GitHub Secrets -> Container):
 *   SMTP credentials are your Bayer network credentials (same as VPN login).
 *
 *   Option A — use APP_SECRET_1 + APP_SECRET_2:
 *     APP_SECRET_1  ->  SECRET_1  ->  SMTP_USER      (e.g. first.last@bayer.com)
 *     APP_SECRET_2  ->  SECRET_2  ->  SMTP_PASSWORD   (Bayer network password)
 *
 *   Option B — use APP_SECRET_3 + APP_SECRET_4 (if slots 1-2 are taken):
 *     APP_SECRET_3  ->  SECRET_3  ->  SMTP_USER
 *     APP_SECRET_4  ->  SECRET_4  ->  SMTP_PASSWORD
 *
 *   Map the secret to the env var name in your stack config, e.g.:
 *     environment:
 *       SMTP_USER: ${SECRET_1}
 *       SMTP_PASSWORD: ${SECRET_2}
 *
 * SETUP — GitHub Secrets:
 *   1. Go to your repo -> Settings -> Secrets and Variables -> Actions
 *   2. Add APP_SECRET_1 with your Bayer email (first.last@bayer.com)
 *   3. Add APP_SECRET_2 with your Bayer network password
 *   4. Deploy — the platform maps APP_SECRET_* to SECRET_* env vars in the
 *      container. Then alias them to SMTP_USER / SMTP_PASSWORD in your stack.
 *
 * LOCAL DEVELOPMENT:
 *   When NODE_ENV=development, emails are NOT sent. Instead, the full email
 *   payload is logged to the console so you can verify content and recipients
 *   without needing SMTP access or credentials.
 *
 * USAGE:
 *   const { sendEmail, sendTemplateEmail } = require('./smtp-client');
 *
 *   // Simple email
 *   await sendEmail({
 *     to: 'colleague@bayer.com',
 *     subject: 'Hello from DD Platform',
 *     text: 'This is a plain text email.',
 *   });
 *
 *   // HTML email
 *   await sendEmail({
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
 *     'team@bayer.com',
 *     'Weekly Report',
 *     reportTemplate,
 *     { title: 'Sprint 42', status: 'On Track' }
 *   );
 *
 *   // With attachments
 *   await sendEmail({
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
  host: 'exsmtp.na.bayer.cnb',
  port: 25,
  // Bayer internal SMTP — no TLS required on the internal network
  secure: false,
  // Some internal relays don't advertise STARTTLS; disable to avoid hangs
  tls: { rejectUnauthorized: false },
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

  // -------------------------------------------------------------------------
  // Development mock — log emails to console instead of sending
  // -------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Send functions
// ---------------------------------------------------------------------------

/**
 * Sends an email via Bayer's internal SMTP server.
 *
 * @param {Object} options
 * @param {string|string[]} options.to       — recipient(s)
 * @param {string}          options.subject  — email subject
 * @param {string}          [options.html]   — HTML body
 * @param {string}          [options.text]   — plain text body
 * @param {string|string[]} [options.cc]     — CC recipient(s)
 * @param {string|string[]} [options.bcc]    — BCC recipient(s)
 * @param {string}          [options.from]   — sender address (defaults to SMTP_USER)
 * @param {Array}           [options.attachments] — nodemailer attachment objects
 * @returns {Promise<Object>} nodemailer send result ({ messageId, accepted, ... })
 */
async function sendEmail({ to, subject, html, text, cc, bcc, from, attachments } = {}) {
  if (!to) throw new Error('sendEmail: "to" is required.');
  if (!subject) throw new Error('sendEmail: "subject" is required.');
  if (!html && !text) throw new Error('sendEmail: provide at least "html" or "text" body.');

  const transporter = createTransporter();

  const mailOptions = {
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
    console.error(`[SMTP] Failed to send email to ${to}:`, error.message);
    throw new Error(`Failed to send email: ${error.message}`);
  }
}

/**
 * Sends an HTML email built from a template function.
 *
 * Convenience wrapper around sendEmail — pass a function that receives data
 * and returns an HTML string.
 *
 * @param {string|string[]} to         — recipient(s)
 * @param {string}          subject    — email subject
 * @param {Function}        templateFn — (data) => htmlString
 * @param {Object}          data       — data passed to the template function
 * @returns {Promise<Object>} nodemailer send result
 */
async function sendTemplateEmail(to, subject, templateFn, data = {}) {
  if (typeof templateFn !== 'function') {
    throw new Error('sendTemplateEmail: templateFn must be a function that returns an HTML string.');
  }

  const html = templateFn(data);
  return sendEmail({ to, subject, html });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  createTransporter,
  sendEmail,
  sendTemplateEmail,
};
