'use strict';
const { cfg } = require('./config');
const store = require('./store');
const publicSrv = require('./public');
const adminSrv = require('./admin');

const n = store.load();
console.log(`[${new Date().toISOString()}] vitrina: ${n} artifact(s) indexed from ${cfg.dataDir}`);

const servers = [publicSrv.start(), adminSrv.start()];

// Expiry sweep: expired artifacts already answer 410; this removes the files
// once they are `purgeAfterDays` past expiry. Also runnable on demand via `vitrina gc`.
const sweep = () => {
  try {
    const purged = adminSrv.gc();
    if (purged.length) console.log(`[${new Date().toISOString()}] gc purged ${purged.join(', ')}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] gc error:`, err?.message ?? err);
  }
};
setTimeout(sweep, 60 * 1000).unref();
setInterval(sweep, 24 * 3600 * 1000).unref();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[${new Date().toISOString()}] vitrina: ${sig}, shutting down`);
    servers.forEach((s) => s.close());
    setTimeout(() => process.exit(0), 300).unref();
  });
}
