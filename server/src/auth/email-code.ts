import { eq } from "drizzle-orm";
import { emailOTP } from "better-auth/plugins/email-otp";
import type { Db } from "@paperclipai/db";
import { authUsers } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

// Kaamel fork: passwordless sign-in by a one-time code sent to the account's
// email. Off unless the operator opts in AND a mail sender is configured, so
// an upstream-default instance behaves exactly as before.

const EMAIL_CODE_LENGTH = 8;
const EMAIL_CODE_EXPIRES_IN_SECONDS = 10 * 60;
const EMAIL_CODE_ALLOWED_ATTEMPTS = 3;
const RESEND_EMAILS_ENDPOINT = "https://api.resend.com/emails";

type EmailCodeMailConfig = {
  apiKey: string;
  from: string;
  productName: string;
};

function isTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function resolveEmailCodeMailConfig(env: NodeJS.ProcessEnv = process.env): EmailCodeMailConfig | null {
  if (!isTrue(env.PAPERCLIP_AUTH_EMAIL_CODE_ENABLED)) return null;
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.PAPERCLIP_AUTH_EMAIL_FROM?.trim();
  if (!apiKey || !from) return null;
  return {
    apiKey,
    from,
    productName: env.PAPERCLIP_AUTH_EMAIL_PRODUCT_NAME?.trim() || "Paperclip",
  };
}

export function isEmailCodeSignInEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveEmailCodeMailConfig(env) !== null;
}

// Password sign-in can only be turned off while the emailed code works;
// otherwise a missing mail key would lock every operator out.
export function isPasswordSignInDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTrue(env.PAPERCLIP_AUTH_PASSWORD_SIGN_IN_DISABLED) && isEmailCodeSignInEnabled(env);
}

async function sendSignInCodeEmail(mail: EmailCodeMailConfig, to: string, code: string): Promise<void> {
  const minutes = Math.round(EMAIL_CODE_EXPIRES_IN_SECONDS / 60);
  // The code is digits only and the product name is operator-set, so neither needs HTML escaping.
  const response = await fetch(RESEND_EMAILS_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${mail.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: mail.from,
      to: [to],
      subject: `${code} es tu código de acceso a ${mail.productName}`,
      text:
        `Tu código de acceso a ${mail.productName} es: ${code}\n\n` +
        `Vence en ${minutes} minutos y sirve una sola vez. Si no lo pediste, ignora este correo.`,
      html:
        `<p>Tu código de acceso a <strong>${mail.productName}</strong> es:</p>` +
        `<p style="font-size:28px;font-weight:700;letter-spacing:4px;font-family:monospace">${code}</p>` +
        `<p>Vence en ${minutes} minutos y sirve una sola vez. Si no lo pediste, ignora este correo.</p>`,
    }),
  });
  if (!response.ok) {
    throw new Error(`Resend rejected the sign-in code email (HTTP ${response.status})`);
  }
}

export function createEmailCodePlugin(db: Db, mail: EmailCodeMailConfig) {
  return emailOTP({
    otpLength: EMAIL_CODE_LENGTH,
    expiresIn: EMAIL_CODE_EXPIRES_IN_SECONDS,
    allowedAttempts: EMAIL_CODE_ALLOWED_ATTEMPTS,
    storeOTP: "hashed",
    // Accounts are created only through invites; a code never signs anyone up.
    disableSignUp: true,
    sendVerificationOTP: async ({ email, otp, type }) => {
      if (type !== "sign-in") return;
      const normalizedEmail = email.trim().toLowerCase();
      // Not awaited: the response must look the same whether or not the
      // address has an account, and mail must never go to unknown addresses.
      void (async () => {
        const [user] = await db
          .select({ id: authUsers.id })
          .from(authUsers)
          .where(eq(authUsers.email, normalizedEmail))
          .limit(1);
        if (!user) return;
        await sendSignInCodeEmail(mail, normalizedEmail, otp);
      })().catch((err) => {
        logger.error({ err }, "failed to send sign-in code email");
      });
    },
  });
}
