// The public page is separate from the owner UI: it has no private client,
// storage, login, mutation controls, workspace seed, or credential references.
export function buildPublicDemo({ template, css, app }) {
  if (!template.includes('<link rel="stylesheet" href="style.css">') || !template.includes('<script type="module" src="app.js"></script>')) throw new Error('Public page template is missing its expected asset markers');
  return template
    .replace('<link rel="stylesheet" href="style.css">', () => `<style>${css}</style>`)
    .replace('<script type="module" src="app.js"></script>', () => `<script type="module">${app.replace(/<\/script/gi, '<\\/script')}</script>`);
}
