const nodemailer = require("nodemailer");
const { normalizeAppUrl } = require("./appUrl");

// ---------------------------------------------------------------------------
// Email provider — Gmail SMTP only
//
// Transactional mail (signup/password OTPs, order confirmation links, receipts,
// admin alerts) is delivered through a single Gmail account using an App
// Password. Resend was removed: an unverified key or sandbox sender failed
// silently, while Gmail needs no DNS setup and works as soon as the credentials
// are present.
//
// Setup: enable 2-Step Verification on the Google account, create an App
// Password at https://myaccount.google.com/apppasswords, then set
//   EMAIL_USER=<gmail address>
//   EMAIL_PASS=<16-character app password — spaces are stripped automatically>
// ---------------------------------------------------------------------------
const rawEmailUser = (process.env.EMAIL_USER || "").trim();
const rawEmailPass = process.env.EMAIL_PASS || "";
const normalizedEmailPass = rawEmailPass.replace(/\s+/g, "");
const gmailPassWasNormalized = Boolean(
  rawEmailPass && rawEmailPass !== normalizedEmailPass,
);

const hasGmail = Boolean(rawEmailUser && normalizedEmailPass);

const gmailTransporter = hasGmail
  ? nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: rawEmailUser,
        pass: normalizedEmailPass,
      },
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
      rateDelta: 1000,
      rateLimit: 5,
    })
  : null;

const GMAIL_FROM = rawEmailUser
  ? `"Kifayat" <${rawEmailUser}>`
  : `"Kifayat" <no-reply@kifayat.co>`;

function extractEmailAddress(sender) {
  const match = String(sender || "").match(/<([^>]+)>/);
  return match ? match[1].trim() : String(sender || "").trim();
}

function extractDisplayName(sender) {
  const match = String(sender || "").match(/^(.*)<[^>]+>$/);
  return match ? match[1].trim() : "";
}

function resolveFromAddress(requestedFrom) {
  // Gmail always sends as the authenticated account, so only the display name
  // from the caller's `from` is kept; the address is forced to EMAIL_USER.
  const displayName = extractDisplayName(requestedFrom);
  return displayName ? `${displayName} <${rawEmailUser}>` : GMAIL_FROM;
}

function resolveReplyToAddress(sender) {
  return process.env.REPLY_TO_EMAIL || process.env.SUPPORT_EMAIL || extractEmailAddress(sender);
}

function getPreferredProvider() {
  // Gmail SMTP (EMAIL_USER + EMAIL_PASS app password) is the only provider.
  return hasGmail ? "gmail" : null;
}

function getProviderOrder() {
  return hasGmail ? ["gmail"] : [];
}

function getTransactionalHeaders() {
  return {
    "Auto-Submitted": "auto-generated",
    "X-Auto-Response-Suppress": "All",
    "X-Priority": "3",
    "X-Mailer": "Kifayat Transactional Mailer",
    "Precedence": "bulk",
  };
}

function getEmailProviderStatus() {
  return {
    hasGmail,
    gmailPassWasNormalized,
    gmailFrom: GMAIL_FROM,
    preferredProvider: getPreferredProvider(),
    replyTo: resolveReplyToAddress(GMAIL_FROM),
  };
}

function normalizeBaseUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    return url.origin;
  } catch {
    return "";
  }
}

function getConfirmationBaseUrl(requestBaseUrl) {
  // PUBLIC_APP_URL is the portable deployment setting. FRONTEND_URL remains
  // supported for existing installations. normalizeAppUrl maps any stale apex
  // (https://kifayat.co) value to the canonical www host.
  //
  // A placeholder or malformed value (e.g. "https://<your-vercel-url>") must be
  // ignored rather than parsed — `new URL()` used to throw ERR_INVALID_URL and
  // take the whole confirmation email down with it. An unparseable config is
  // treated as "not configured" so the request's own origin is used instead.
  const configuredUrl = normalizeBaseUrl(
    normalizeAppUrl(
      process.env.PUBLIC_APP_URL ||
        process.env.SITE_URL ||
        process.env.FRONTEND_URL,
    ),
  );
  const requestUrl = normalizeBaseUrl(requestBaseUrl);

  // Never send a loopback URL to a remote customer when the request arrived
  // through a public frontend host.
  const configuredIsLoopback = configuredUrl
    ? /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(new URL(configuredUrl).hostname)
    : false;

  if (configuredUrl && !configuredIsLoopback) return configuredUrl;
  if (requestUrl) return requestUrl;
  return configuredUrl || "http://localhost:5000";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Sanitize user input to prevent XSS and spam triggers
function sanitizeText(text) {
  if (!text) return "";
  return String(text)
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .trim();
}

// Rough HTML-to-text conversion — gives every email a plain-text alternative,
// which improves deliverability (spam filters penalise HTML-only mail).
function htmlToText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&mdash;/g, "—")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function sendMail({ from, to, subject, html, text }) {
  const toList = Array.isArray(to) ? to : [to];

  if (!gmailTransporter) {
    throw new Error(
      "No email provider is configured. Set EMAIL_USER and EMAIL_PASS (a Gmail app password).",
    );
  }

  const headers = getTransactionalHeaders(subject);
  const gmailFrom = resolveFromAddress(from);
  const replyTo = resolveReplyToAddress(gmailFrom);

  try {
    await gmailTransporter.sendMail({
      from: gmailFrom,
      to: toList,
      subject,
      html,
      text: text || htmlToText(html),
      replyTo,
      headers,
    });
    console.log(`[email] Sent via Gmail as ${gmailFrom} to ${toList.join(", ")}`);
  } catch (error) {
    console.error("[email] Gmail delivery failed:", error.message);
    throw new Error(`Gmail: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Diagnostics & a real end-to-end test send
// ---------------------------------------------------------------------------

/**
 * Structured, actionable description of the mail configuration.
 * Every `problems` entry names the exact env var to change, because a silently
 * broken sender is indistinguishable from a working one until a customer says
 * they never got their code.
 */
function getEmailDiagnostics() {
  const status = getEmailProviderStatus();
  const problems = [];

  if (!status.hasGmail) {
    problems.push(
      "No email provider is configured — set EMAIL_USER and EMAIL_PASS (a Gmail app password).",
    );
  }

  if (status.hasGmail && status.gmailPassWasNormalized) {
    problems.push(
      "EMAIL_PASS contained whitespace and was normalized. Gmail app passwords are 16 characters with no spaces.",
    );
  }

  if (rawEmailPass && !rawEmailUser) {
    problems.push("EMAIL_PASS is set but EMAIL_USER is missing — Gmail cannot authenticate.");
  }

  return {
    ...status,
    providerOrder: getProviderOrder(),
    problems,
    healthy: problems.length === 0,
  };
}

/**
 * Close the pooled SMTP connection. Long-lived servers keep the pool open for
 * performance, but short scripts (e.g. scripts/check-email.js) must release it
 * or the open socket keeps Node alive after the send completes.
 */
async function closeEmailTransports() {
  if (gmailTransporter) {
    try {
      gmailTransporter.close();
    } catch {
      // Ignore — the socket may already be gone.
    }
  }
}

/**
 * Send a real message through the configured provider order and report exactly
 * what happened. This is the only reliable way to tell a working sender from a
 * misconfigured one — config checks alone cannot catch a rejected app password.
 *
 * @param {string} to recipient (callers should use the admin's own address)
 * @returns {Promise<{ok: boolean, provider: string|null, detail: string}>}
 */
async function sendTestEmail(to) {
  const providerOrder = getProviderOrder();
  if (providerOrder.length === 0) {
    return { ok: false, provider: null, detail: "No email provider is configured." };
  }

  const stamp = new Date().toISOString();
  try {
    await sendMail({
      to,
      subject: "Kifayat — test email",
      html: `
        <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:520px;">
          <h2 style="margin:0 0 12px;">Email delivery is working</h2>
          <p style="color:#4b5563;line-height:1.6;">
            This test message was requested from the Kifayat admin panel at
            <strong>${stamp}</strong>.
          </p>
          <p style="color:#4b5563;line-height:1.6;">
            Provider order for this server: ${providerOrder.join(" → ")}.
          </p>
        </div>
      `,
      text: `Kifayat email delivery is working. Test requested at ${stamp}. Provider order: ${providerOrder.join(" then ")}.`,
    });
    return {
      ok: true,
      provider: getPreferredProvider() || providerOrder[0],
      detail: `Test email accepted by the provider and sent to ${to}.`,
    };
  } catch (error) {
    return {
      ok: false,
      provider: null,
      detail: error.message || "The provider rejected the message.",
    };
  }
}

// ---------------------------------------------------------------------------
// OTP verification
// ---------------------------------------------------------------------------

/**
 * Send an OTP without letting a mail outage break the caller's flow.
 *
 * Signup stores the account and the hashed OTP BEFORE the email is attempted,
 * so a delivery failure used to surface as a 500 that left the user with an
 * existing account they could not re-create (409) and a code they never got.
 * This wrapper reports the failure instead of throwing, so the request stays a
 * success and the customer can use "resend" once mail is fixed.
 *
 * @returns {Promise<{delivered: boolean, error?: string}>}
 */
async function sendOTPEmailSafe(to, name, otp) {
  try {
    await sendOTPEmail(to, name, otp);
    return { delivered: true };
  } catch (error) {
    const detail = error?.message || "unknown error";
    console.error(`[email] OTP delivery FAILED for ${to}: ${detail}`);
    console.error(
      '[email] The account and code were still created. Fix the mail credentials in ' +
        'kifayat-backend/.env — run "npm run email:check" for the exact diagnosis.',
    );
    // Non-production (or explicit opt-in) prints the code so local and staged
    // flows can be completed without a working sender. Never in production by
    // default, because an OTP in the server log is a real credential leak.
    const logFallback =
      process.env.NODE_ENV !== "production" ||
      String(process.env.OTP_LOG_FALLBACK || "").toLowerCase() === "true";
    if (logFallback) {
      console.warn(`[email] OTP for ${to}: ${otp} (dev fallback — not delivered by email)`);
    }
    return { delivered: false, error: detail };
  }
}

const sendOTPEmail = async (to, name, otp) => {
  await sendMail({
    to,
    subject: "Kifayat verification code",
    html: `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:10px;">
        <h2 style="color:#111827;margin-top:0;">Verify your Kifayat account</h2>
        <p style="color:#374151;">Hi <strong>${sanitizeText(name)}</strong>,</p>
        <p style="color:#374151;">Use the code below to complete your sign-up. It expires in <strong>10 minutes</strong>.</p>
        <div style="background:#f3f4f6;border-radius:8px;padding:28px;text-align:center;margin:24px 0;">
          <span style="font-size:42px;font-weight:bold;letter-spacing:14px;color:#111827;">${sanitizeText(otp)}</span>
        </div>
        <p style="color:#6b7280;font-size:14px;">If you didn't request this, you can safely ignore this email.</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>
        <p style="color:#9ca3af;font-size:12px;margin:0;">Kifayat &mdash; Your financial companion</p>
      </div>
    `,
  });
};

// ---------------------------------------------------------------------------
// Admin notification (generic)
// ---------------------------------------------------------------------------

const sendAdminNotification = async (subject, message) => {
  const adminEmails = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (adminEmails.length === 0) {
    console.warn("No admin emails configured — skipping admin notification.");
    return;
  }
  await sendMail({
    from: `"Kifayat System" <${process.env.EMAIL_USER || "no-reply@kifayat.co"}>`,
    to: adminEmails,
    subject,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:10px;">
        <h2 style="color:#111827;margin-top:0;">${subject}</h2>
        <div style="background:#f3f4f6;border-radius:8px;padding:20px;margin:16px 0;">
          <p style="color:#374151;margin:0;line-height:1.6;">${message}</p>
        </div>
        <p style="color:#6b7280;font-size:14px;">This is an automated notification from Kifayat.</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>
        <p style="color:#9ca3af;font-size:12px;margin:0;">Kifayat &mdash; Your financial companion</p>
      </div>
    `,
  });
};

// ---------------------------------------------------------------------------
// Order confirmation
// ---------------------------------------------------------------------------

const sendOrderConfirmationEmail = async (to, name, order, shippingDetails) => {
  const orderItemsHtml = order.items
    .map(
      (item) => `
    <tr style="border-bottom:1px solid #f3f4f6;">
      <td style="padding:12px 0;font-size:14px;color:#111827;">${sanitizeText(item.name)} x ${item.quantity}</td>
      <td style="padding:12px 0;font-size:14px;color:#111827;text-align:right;">PKR ${Number(item.price * item.quantity).toLocaleString("en-PK")}</td>
    </tr>
  `
    )
    .join("");

  await sendMail({
    to,
    subject: `Order Confirmation #${order._id.toString().slice(-8).toUpperCase()}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:10px;">
        <h2 style="color:#111827;margin-top:0;">Order Placed Successfully</h2>
        <p style="color:#374151;">Hi <strong>${sanitizeText(name)}</strong>,</p>
        <p style="color:#374151;">Thank you for your order! Your order details are below:</p>

        <div style="background:#f9fafb;border-radius:8px;padding:20px;margin:24px 0;">
          <p style="margin:0 0 8px;font-size:14px;color:#374151;"><strong>Order ID:</strong> #${order._id.toString().slice(-8).toUpperCase()}</p>
          <p style="margin:0 0 8px;font-size:14px;color:#374151;"><strong>Order Date:</strong> ${new Date(order.createdAt).toLocaleString("en-PK")}</p>
          <p style="margin:0;font-size:14px;color:#374151;"><strong>Total Amount:</strong> <span style="font-weight:bold;color:#111827;">PKR ${Number(order.totalAmount).toLocaleString("en-PK")}</span></p>
        </div>

        <h3 style="color:#111827;margin:0 0 12px;">Order Items</h3>
        <table style="width:100%;margin-bottom:24px;">
          <tbody>
            ${orderItemsHtml}
          </tbody>
        </table>

        <h3 style="color:#111827;margin:0 0 12px;">Shipping Details</h3>
        <div style="background:#f9fafb;border-radius:8px;padding:20px;">
          <p style="margin:0 0 8px;font-size:14px;color:#374151;"><strong>Name:</strong> ${sanitizeText(shippingDetails.name)}</p>
          <p style="margin:0 0 8px;font-size:14px;color:#374151;"><strong>Phone:</strong> ${sanitizeText(shippingDetails.phoneNumber)}${shippingDetails.phoneNumber2 ? ` / ${sanitizeText(shippingDetails.phoneNumber2)}` : ""}</p>
          <p style="margin:0 0 8px;font-size:14px;color:#374151;"><strong>Address:</strong> ${sanitizeText(shippingDetails.address)}, ${sanitizeText(shippingDetails.courierCity)}</p>
          <p style="margin:0 0 8px;font-size:14px;color:#374151;"><strong>Ship Type:</strong> ${sanitizeText(shippingDetails.shpType)} — ${sanitizeText(shippingDetails.courierCompany)}</p>
          <p style="margin:0;font-size:14px;color:#374151;"><strong>Payment:</strong> ${shippingDetails.shipping === "cod" ? "Cash on Delivery" : "Advance Payment"}</p>
        </div>

        <p style="color:#6b7280;font-size:14px;">We'll process your order shortly and keep you updated!</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>
        <p style="color:#9ca3af;font-size:12px;margin:0;">Kifayat &mdash; Your financial companion</p>
      </div>
    `,
  });
};

// ---------------------------------------------------------------------------
// Order confirmation link (10-minute window)
// ---------------------------------------------------------------------------

const sendOrderConfirmationLinkEmail = async (
  to,
  name,
  order,
  confirmationToken,
  requestBaseUrl,
) => {
  const frontendUrl = getConfirmationBaseUrl(requestBaseUrl);
  const confirmLink = `${frontendUrl}/confirm-order?token=${confirmationToken}`;
  const orderIdDisplay = `#${order._id.toString().slice(-8).toUpperCase()}`;

  const orderItemsHtml = order.items
    .map(
      (item) => `
    <tr style="border-bottom:1px solid #f3f4f6;">
      <td style="padding:12px 0;font-size:14px;color:#111827;">${sanitizeText(item.name)} x ${item.quantity}</td>
      <td style="padding:12px 0;font-size:14px;color:#111827;text-align:right;">PKR ${Number(item.price * item.quantity).toLocaleString("en-PK")}</td>
    </tr>
  `
    )
    .join("");

  await sendMail({
    to,
    subject: `Confirm your Kifayat order ${orderIdDisplay}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:10px;">
        <h2 style="color:#111827;margin-top:0;">Confirm Your Order</h2>
        <p style="color:#374151;">Hi <strong>${sanitizeText(name)}</strong>,</p>
        <p style="color:#374151;">Your order has been received. Please confirm it within <strong>24 hours</strong> by clicking the button below. If you do not confirm, the order will be automatically cancelled.</p>

        <div style="text-align:center;margin:28px 0;">
          <a href="${confirmLink}"
             style="display:inline-block;background:#16a34a;color:#fff;padding:14px 36px;border-radius:8px;text-decoration:none;font-size:16px;font-weight:600;">
            Confirm Order
          </a>
        </div>

        <div style="background:#f9fafb;border-radius:8px;padding:20px;margin:24px 0;">
          <p style="margin:0 0 8px;font-size:14px;color:#374151;"><strong>Order ID:</strong> ${orderIdDisplay}</p>
          <p style="margin:0 0 8px;font-size:14px;color:#374151;"><strong>Order Date:</strong> ${new Date(order.createdAt).toLocaleString("en-PK")}</p>
          <p style="margin:0;font-size:14px;color:#374151;"><strong>Total Amount:</strong> <span style="font-weight:bold;color:#111827;">PKR ${Number(order.totalAmount).toLocaleString("en-PK")}</span></p>
        </div>

        <h3 style="color:#111827;margin:0 0 12px;">Order Items</h3>
        <table style="width:100%;margin-bottom:24px;">
          <tbody>${orderItemsHtml}</tbody>
        </table>

        <p style="color:#6b7280;font-size:13px;">If you didn't place this order, you can safely ignore this email.</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>
        <p style="color:#9ca3af;font-size:12px;margin:0;">Kifayat &mdash; Your financial companion</p>
      </div>
    `,
  });
};

// ---------------------------------------------------------------------------
// Late confirmation — stock unavailable
// ---------------------------------------------------------------------------

const sendLateConfirmationEmail = async (to, name, order) => {
  const orderIdDisplay = `#${(order._id || order).toString().slice(-8).toUpperCase()}`;

  await sendMail({
    to,
    subject: `Order ${orderIdDisplay} — Confirmation Failed`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:10px;">
        <h2 style="color:#dc2626;margin-top:0;">Stock Unavailable</h2>
        <p style="color:#374151;">Hi <strong>${name}</strong>,</p>
        <p style="color:#374151;">You confirmed your order <strong>${orderIdDisplay}</strong>, but unfortunately the stock is no longer available. This can happen when items sell out between the time you placed your order and when you confirmed it.</p>
        <div style="background:#fef2f2;border-radius:8px;padding:20px;margin:24px 0;border:1px solid #fecaca;">
          <p style="margin:0;font-size:14px;color:#991b1b;"><strong>What now?</strong></p>
          <p style="margin:8px 0 0;font-size:14px;color:#991b1b;">Please try placing your order again later. We restock items regularly. If you have questions, reach out to our support team.</p>
        </div>
        <p style="color:#6b7280;font-size:14px;">We apologise for the inconvenience.</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>
        <p style="color:#9ca3af;font-size:12px;margin:0;">Kifayat &mdash; Your financial companion</p>
      </div>
    `,
  });
};

// ---------------------------------------------------------------------------
// Order cancelled due to stock exhaustion (after main order entry, before HSC)
// ---------------------------------------------------------------------------

const sendStockExhaustionEmail = async (to, name, order) => {
  const orderIdDisplay = `#${(order._id || order).toString().slice(-8).toUpperCase()}`;

  await sendMail({
    to,
    subject: `Order ${orderIdDisplay} — Cancelled Due to Stock Issue`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:10px;">
        <h2 style="color:#dc2626;margin-top:0;">Order Cancelled</h2>
        <p style="color:#374151;">Hi <strong>${name}</strong>,</p>
        <p style="color:#374151;">We regret to inform you that your order <strong>${orderIdDisplay}</strong> has been cancelled due to warehouse or revenue-related issues.</p>
        <div style="background:#fef2f2;border-radius:8px;padding:20px;margin:24px 0;border:1px solid #fecaca;">
          <p style="margin:0;font-size:14px;color:#991b1b;"><strong>What happens next?</strong></p>
          <p style="margin:8px 0 0;font-size:14px;color:#991b1b;">We will notify you as soon as the stock is available again. You will not be charged for this order.</p>
        </div>
        <p style="color:#6b7280;font-size:14px;">We apologise for the inconvenience and appreciate your patience.</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>
        <p style="color:#9ca3af;font-size:12px;margin:0;">Kifayat &mdash; Your financial companion</p>
      </div>
    `,
  });
};

// ---------------------------------------------------------------------------
// Order cancellation (user-initiated)
// ---------------------------------------------------------------------------

const sendOrderCancelledByUserEmail = async (to, name, order) => {
  const orderIdDisplay = `#${(order._id || order).toString().slice(-8).toUpperCase()}`;

  await sendMail({
    to,
    subject: `Order ${orderIdDisplay} — Cancelled as Requested`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:10px;">
        <h2 style="color:#111827;margin-top:0;">Order Cancelled</h2>
        <p style="color:#374151;">Hi <strong>${name}</strong>,</p>
        <p style="color:#374151;">Your order <strong>${orderIdDisplay}</strong> has been cancelled as requested.</p>
        <div style="background:#f9fafb;border-radius:8px;padding:20px;margin:24px 0;">
          <p style="margin:0;font-size:14px;color:#374151;">If you did not request this cancellation, please contact our support team immediately.</p>
        </div>
        <p style="color:#6b7280;font-size:14px;">We hope to see you again soon!</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>
        <p style="color:#9ca3af;font-size:12px;margin:0;">Kifayat &mdash; Your financial companion</p>
      </div>
    `,
  });
};

// ---------------------------------------------------------------------------
// Insufficient stock cancellation (system-initiated)
// ---------------------------------------------------------------------------

const sendInsufficientStockEmail = async (to, name, order) => {
  const orderIdDisplay = `#${(order._id || order).toString().slice(-8).toUpperCase()}`;

  await sendMail({
    to,
    subject: `Order ${orderIdDisplay} — Cancelled Due to Insufficient Stock`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:10px;">
        <h2 style="color:#dc2626;margin-top:0;">Insufficient Stock</h2>
        <p style="color:#374151;">Hi <strong>${name}</strong>,</p>
        <p style="color:#374151;">We regret to inform you that your order <strong>${orderIdDisplay}</strong> has been cancelled due to insufficient stock.</p>
        <div style="background:#fef2f2;border-radius:8px;padding:20px;margin:24px 0;border:1px solid #fecaca;">
          <p style="margin:0;font-size:14px;color:#991b1b;"><strong>What happens next?</strong></p>
          <p style="margin:8px 0 0;font-size:14px;color:#991b1b;">We will notify you as soon as the items are back in stock. You will not be charged for this order.</p>
        </div>
        <p style="color:#6b7280;font-size:14px;">We apologise for the inconvenience and appreciate your patience.</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>
        <p style="color:#9ca3af;font-size:12px;margin:0;">Kifayat &mdash; Your financial companion</p>
      </div>
    `,
  });
};

// ---------------------------------------------------------------------------
// Warehouse/Revenue cancellation with compensation vouchers
// ---------------------------------------------------------------------------

const sendCompensationEmail = async (to, name, order, vouchers) => {
  const orderIdDisplay = `#${(order._id || order).toString().slice(-8).toUpperCase()}`;

  let voucherRows = vouchers.map((v, i) => {
    if (v.voucher_type === "discount_all") {
      return `<tr>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#374151;">${i + 1}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#374151;">${v.discount_percent}% OFF</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#6b7280;">All products</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#6b7280;">${new Date(v.expires_at).toLocaleDateString("en-PK", { day: "numeric", month: "short", year: "numeric" })}</td>
      </tr>`;
    } else if (v.voucher_type === "discount_specific") {
      return `<tr>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#374151;">${i + 1}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#374151;">${v.discount_percent}% OFF</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#6b7280;">Specific products</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#6b7280;">${new Date(v.expires_at).toLocaleDateString("en-PK", { day: "numeric", month: "short", year: "numeric" })}</td>
      </tr>`;
    } else {
      return `<tr>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#374151;">${i + 1}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#374151;">Free Product</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#6b7280;">${v.products?.length ? v.products.map(p => p.name || "Selected product").join(", ") : "Selected product"}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#6b7280;">${new Date(v.expires_at).toLocaleDateString("en-PK", { day: "numeric", month: "short", year: "numeric" })}</td>
      </tr>`;
    }
  }).join("");

  await sendMail({
    to,
    subject: `Order ${orderIdDisplay} — Cancelled — Compensation Vouchers Inside`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:10px;">
        <h2 style="color:#111827;margin-top:0;">We Apologise</h2>
        <p style="color:#374151;">Hi <strong>${name}</strong>,</p>
        <p style="color:#374151;">We regret to inform you that your order <strong>${orderIdDisplay}</strong> has been cancelled due to a warehouse or revenue-related issue.</p>
        <div style="background:#fef2f2;border-radius:8px;padding:20px;margin:24px 0;border:1px solid #fecaca;">
          <p style="margin:0;font-size:14px;color:#991b1b;">As a token of apology, we have added compensation vouchers to your account. Use them on your next order!</p>
        </div>
        <div style="background:#f9fafb;border-radius:8px;padding:20px;margin:24px 0;border:1px solid #e5e7eb;">
          <p style="margin:0 0 16px;font-size:16px;font-weight:700;color:#111827;">Your Compensation Vouchers</p>
          <table style="width:100%;border-collapse:collapse;">
            <thead>
              <tr style="background:#e5e7eb;">
                <th style="padding:10px 12px;text-align:left;font-size:12px;color:#374151;text-transform:uppercase;">#</th>
                <th style="padding:10px 12px;text-align:left;font-size:12px;color:#374151;text-transform:uppercase;">Discount</th>
                <th style="padding:10px 12px;text-align:left;font-size:12px;color:#374151;text-transform:uppercase;">Applies To</th>
                <th style="padding:10px 12px;text-align:left;font-size:12px;color:#374151;text-transform:uppercase;">Expires</th>
              </tr>
            </thead>
            <tbody>
              ${voucherRows}
            </tbody>
          </table>
        </div>
        <p style="color:#6b7280;font-size:14px;">Log in to your account to view and apply your vouchers.</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>
        <p style="color:#9ca3af;font-size:12px;margin:0;">Kifayat &mdash; Your financial companion</p>
      </div>
    `,
  });
};

// ---------------------------------------------------------------------------
// Admin stock-alert email with "Gift them" action
// Sent when a customer confirms too late (pre-order) or a main-order item
// runs out of stock — lets the admin compensate the customer instantly.
// ---------------------------------------------------------------------------

const sendAdminStockAlertEmail = async ({
  orderId,
  customerName,
  customerEmail,
  orderType,
}) => {
  const orderDisplay = `#${String(orderId || "").slice(-8).toUpperCase()}`;
  const adminEmails = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (adminEmails.length === 0) {
    console.warn("No admin emails configured — skipping admin stock alert email.");
    return;
  }

  await sendMail({
    from: `"Kifayat System" <${process.env.EMAIL_USER || "no-reply@kifayat.co"}>`,
    to: adminEmails,
    subject: `Late Confirmation — Order ${orderDisplay} Not Available`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #e5e7eb;border-radius:10px;">
        <h2 style="color:#dc2626;margin-top:0;">Late Confirmation — Product Not Available</h2>
        <p style="color:#374151;">Customer <strong>${customerName || "—"}</strong> (${customerEmail || "no email on file"}) confirmed their order <strong>${orderDisplay}</strong>, but the product is no longer available on the website.</p>
        <div style="background:#f9fafb;border-radius:8px;padding:20px;margin:24px 0;border:1px solid #e5e7eb;">
          <p style="margin:0 0 8px;font-size:14px;color:#374151;"><strong>Order:</strong> ${orderDisplay}</p>
          <p style="margin:0 0 8px;font-size:14px;color:#374151;"><strong>Stage:</strong> ${orderType}</p>
          <p style="margin:0 0 8px;font-size:14px;color:#374151;"><strong>Customer:</strong> ${customerName || "—"} (${customerEmail || "no email on file"})</p>
          <p style="margin:0;font-size:14px;color:#374151;"><strong>Status:</strong> Late confirmation — stock not available. The order was not moved to main orders and will be managed manually.</p>
        </div>
        <p style="color:#6b7280;font-size:14px;">You can compensate this customer manually — e.g. via the Gift button in User Management.</p>
        <p style="color:#6b7280;font-size:14px;">This is an automated notification from Kifayat.</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;"/>
        <p style="color:#9ca3af;font-size:12px;margin:0;">Kifayat &mdash; Your financial companion</p>
      </div>
    `,
  });
};

module.exports = {
  sendMail,
  sendOTPEmail,
  sendOTPEmailSafe,
  sendOrderConfirmationEmail,
  sendAdminNotification,
  sendOrderConfirmationLinkEmail,
  sendLateConfirmationEmail,
  sendStockExhaustionEmail,
  sendOrderCancelledByUserEmail,
  sendInsufficientStockEmail,
  sendCompensationEmail,
  sendAdminStockAlertEmail,
  getConfirmationBaseUrl,
  getEmailProviderStatus,
  getEmailDiagnostics,
  sendTestEmail,
  closeEmailTransports,
  sanitizeText,
};
