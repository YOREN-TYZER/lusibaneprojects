'use strict';
const cfg = require('./src/config');
if (cfg.prod && !/^https:\/\/[^/\s]+$/.test(cfg.origin)) {
  console.error('Refusing to start: set ALLOWED_ORIGIN to your https:// address (see .env.example).');
  process.exit(1);
}
const { createServer } = require('./src/app');
const server = createServer();
server.listen(cfg.port, cfg.host, () => console.log(`Lusibane One listening on http://${cfg.host}:${cfg.port}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
