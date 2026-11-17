// Vercel function entry. Plain JS on purpose: the app is precompiled by `tsc`
// (pnpm build) because Nest needs emitDecoratorMetadata, which esbuild-based
// transpilers don't emit. The bootstrapped app is cached across invocations.
const { createApp } = require('../dist/src/bootstrap');

let appPromise;

module.exports = async function handler(req, res) {
  if (!appPromise) {
    appPromise = createApp().catch((err) => {
      appPromise = undefined; // don't cache a failed bootstrap
      throw err;
    });
  }
  const app = await appPromise;
  app.getHttpAdapter().getInstance()(req, res);
};
