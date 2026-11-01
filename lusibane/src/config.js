'use strict';
const path = require('node:path');
const env = process.env;
const prod = env.NODE_ENV === 'production';

module.exports = {
  prod,
  port: Number(env.PORT) || 3000,
  host: env.HOST || '127.0.0.1',
  dbPath: env.DB_PATH || path.join(__dirname, '..', 'data', 'lusibane.db'),
  trustProxy: env.TRUST_PROXY === '1',
  origin: (env.ALLOWED_ORIGIN || '').replace(/\/$/, ''),
  publicDir: path.join(__dirname, '..', 'public'),
  // The __Host- prefix pins the cookie to this exact host over HTTPS (production only).
  cookieName: prod ? '__Host-sid' : 'sid',
  sessionIdleSec: 7 * 24 * 3600,
  sessionMaxSec: 30 * 24 * 3600,
  whatsapp: env.WA_NUMBER || '27815786526',
  // Photos and videos shown in the "Our Work" gallery: just drop files into this folder.
  mediaDir: path.resolve(env.MEDIA_DIR || path.join(__dirname, '..', 'public', 'media')),
  // Every joining form is also emailed here (set SMTP_* so the email can actually be sent).
  mailTo: env.MAIL_TO || 'info@lusibaneprojects.co.za',
  mailFrom: env.MAIL_FROM || env.SMTP_USER || '',
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT) || 465,
    secure: env.SMTP_SECURE === '1',
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    ehlo: env.SMTP_EHLO || 'lusibaneprojects.co.za',
  },
};
