import { buildPublicDemo } from './public-demo.mjs';
import { mkdir, copyFile, cp, readFile, writeFile } from 'node:fs/promises';
await mkdir('dist', {recursive:true});
await mkdir('dist/admin/chat', {recursive:true});
await copyFile('task-chat/admin-chat.html','dist/admin/index.html');
await copyFile('task-chat/index.html','dist/index.html');
await copyFile('task-chat/style.css','dist/style.css');
await copyFile('task-chat/app.js','dist/app.js');
await copyFile('task-chat/admin-chat.html','dist/admin/chat/index.html');
await copyFile('task-chat/admin-chat.js','dist/admin/chat/app.js');
await cp('src','dist/src',{recursive:true});
const css=await readFile('src/style.css','utf8');
const model=(await readFile('src/model.js','utf8')).replaceAll('export ','');
const app=(await readFile('src/app.js','utf8')).replace(/^import .*?;\n/,'');
const html=(await readFile('index.html','utf8')).replace('<link rel="stylesheet" href="/src/style.css">',`<style>${css}</style>`).replace('<script type="module" src="/src/app.js"></script>',`<script type="module">${model}\n${app.replace(/<\/script/gi,'<\\/script')}</script>`);
await writeFile('dist/preview.html',html);
await mkdir('dist/demo', {recursive:true});
await writeFile('dist/demo/index.html', buildPublicDemo({
  template: await readFile('public-demo/index.html', 'utf8'),
  css: await readFile('public-demo/style.css', 'utf8'), app: await readFile('public-demo/app.js', 'utf8')
}));
console.log('Built public task-chat root, private /admin, owner inbox /admin/chat, standalone workspace preview, and isolated /demo (not published).');
