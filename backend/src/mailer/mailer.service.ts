import { Injectable, Logger } from '@nestjs/common';
import fs from 'node:fs/promises';
import nodemailer from 'nodemailer';
import Handlebars from 'handlebars';

/**
 * Thin wrapper around nodemailer. Configuration is read directly from
 * SMTP_* / MAIL_FROM env vars — keeps things simple in the standalone
 * build (no separate config namespace to register). If SMTP_HOST is
 * unset the service stays inert and logs each send instead of throwing.
 */
@Injectable()
export class MailerService {
  private readonly logger = new Logger(MailerService.name);
  private readonly transporter: nodemailer.Transporter | null;
  private readonly defaultFrom: string;

  constructor() {
    const host = process.env.SMTP_HOST;
    if (host) {
      this.transporter = nodemailer.createTransport({
        host,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: process.env.SMTP_USER
          ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
          : undefined,
      });
    } else {
      this.transporter = null;
      this.logger.warn('SMTP_HOST not set — mailer is disabled (sends will be logged)');
    }
    this.defaultFrom = process.env.MAIL_FROM || 'noreply@example.com';
  }

  async sendMail({
    templatePath,
    context,
    ...mailOptions
  }: nodemailer.SendMailOptions & {
    templatePath?: string;
    context?: Record<string, unknown>;
  }): Promise<void> {
    let html = typeof mailOptions.html === 'string' ? mailOptions.html : undefined;
    if (templatePath) {
      const template = await fs.readFile(templatePath, 'utf-8');
      html = Handlebars.compile(template, { strict: true })(context ?? {});
    }

    const payload: nodemailer.SendMailOptions = {
      ...mailOptions,
      from: mailOptions.from || this.defaultFrom,
      html,
    };

    if (!this.transporter) {
      this.logger.log(`[mailer:dry-run] to=${payload.to} subject=${payload.subject}`);
      return;
    }
    await this.transporter.sendMail(payload);
  }
}
