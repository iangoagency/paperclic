import { eq } from "drizzle-orm";
import { magicLink } from "better-auth/plugins/magic-link";
import type { Db } from "@paperclipai/db";
import { authUsers } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

// Kaamel fork: passwordless sign-in by emailed link. Off unless the operator
// opts in AND a mail sender is configured, so an upstream-default instance
// behaves exactly as before.

const MAGIC_LINK_EXPIRES_IN_SECONDS = 10 * 60;
const RESEND_EMAILS_ENDPOINT = "https://api.resend.com/emails";

type MagicLinkMailConfig = {
  apiKey: string;
  from: string;
  productName: string;
};

function isTrue(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function resolveMagicLinkMailConfig(env: NodeJS.ProcessEnv = process.env): MagicLinkMailConfig | null {
  if (!isTrue(env.PAPERCLIP_AUTH_MAGIC_LINK_ENABLED)) return null;
  const apiKey = env.RESEND_API_KEY?.trim();
  const from = env.PAPERCLIP_AUTH_EMAIL_FROM?.trim();
  if (!apiKey || !from) return null;
  return {
    apiKey,
    from,
    productName: env.PAPERCLIP_AUTH_EMAIL_PRODUCT_NAME?.trim() || "Paperclip",
  };
}

export function isMagicLinkSignInEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveMagicLinkMailConfig(env) !== null;
}

// Password sign-in can only be turned off while the emailed link works;
// otherwise a missing mail key would lock every operator out.
export function isPasswordSignInDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTrue(env.PAPERCLIP_AUTH_PASSWORD_SIGN_IN_DISABLED) && isMagicLinkSignInEnabled(env);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sendMagicLinkEmail(mail: MagicLinkMailConfig, to: string, url: string): Promise<void> {
  const minutes = Math.round(MAGIC_LINK_EXPIRES_IN_SECONDS / 60);
  const product = escapeHtml(mail.productName);
  const safeUrl = escapeHtml(url);
  const response = await fetch(RESEND_EMAILS_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${mail.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: mail.from,
      to: [to],
      subject: `Tu enlace de acceso a ${mail.productName}`,
      text:
        `Entra a ${mail.productName} con este enlace (vence en ${minutes} minutos y sirve una sola vez):\n\n` +
        `${url}\n\nSi no lo pediste, ignora este correo.`,
      html:
        `<p>Entra a <strong>${product}</strong> con este enlace. Vence en ${minutes} minutos y sirve una sola vez.</p>` +
        `<p><a href="${safeUrl}">Entrar a ${product}</a></p>` +
        `<p>Si no lo pediste, ignora este correo.</p>`,
    }),
  });
  if (!response.ok) {
    throw new Error(`Resend rejected the sign-in email (HTTP ${response.status})`);
  }
}

export function createMagicLinkPlugin(db: Db, mail: MagicLinkMailConfig) {
  return magicLink({
    expiresIn: MAGIC_LINK_EXPIRES_IN_SECONDS,
    // Accounts are created only through invites; a link never signs anyone up.
    disableSignUp: true,
    sendMagicLink: async ({ email, url }) => {
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
        await sendMagicLinkEmail(mail, normalizedEmail, url);
      })().catch((err) => {
        logger.error({ err }, "failed to send magic-link sign-in email");
      });
    },
  });
}
