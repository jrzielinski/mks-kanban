/**
 * Strongly-typed configuration tree consumed via `ConfigService<AllConfigType>`.
 *
 * Currently only the mailer reads from it; values come from SMTP_* env vars
 * (see `.env.example`). Other modules read process.env directly.
 */
export interface AllConfigType {
  mail: {
    host?: string;
    port?: number;
    ignoreTLS?: boolean;
    secure?: boolean;
    requireTLS?: boolean;
    user?: string;
    password?: string;
    defaultName?: string;
    defaultEmail?: string;
  };
}
