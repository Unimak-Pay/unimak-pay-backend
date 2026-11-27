/** Small, self-contained HTML pages: public checks (/r receipts, /c exam passes) and the sponsor page (/p). */

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const page = (title: string, body: string, head = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:28rem;margin:2rem auto;padding:0 1rem;color:#111;background:#fff}
h1{font-size:1.25rem}.ok{color:#0a7a2f}.bad{color:#b00020}dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem 1rem}dt{color:#555}dd{margin:0}</style>${head}
</head><body>${body}</body></html>`;
