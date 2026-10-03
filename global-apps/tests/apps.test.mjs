import {test}from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import {apps,languageNames}from'../apps/catalog.mjs';import {translations}from'../shared/translations.mjs';
test('12 unique country identities, packages, complete languages and cultural copy',()=>{
 assert.equal(apps.length,12);
 for(const k of ['id','code','name'])assert.equal(new Set(apps.map(c=>c[k])).size,12);
 for(const c of apps){
  assert.ok(c.languages.includes(c.locale));assert.match(c.color,/^#[a-f0-9]{6}$/i);new Intl.DateTimeFormat('en',{timeZone:c.zone});
  for(const l of c.languages){assert.ok(languageNames[l]);assert.ok(c.culture[l]?.length===4);assert.deepEqual(Object.keys(translations[l]),Object.keys(translations.en));for(const value of Object.values(translations[l]))assert.ok(typeof value==='string'&&value.trim());}
  const config=fs.readFileSync(`dist/web/${c.id}/config.js`,'utf8');assert.ok(config.includes('"preview":true'));assert.ok(!config.includes('AI_API_KEY'));
  const worker=fs.readFileSync(`live/${c.id}/worker.mjs`,'utf8');assert.ok(worker.includes(c.id));assert.ok(worker.includes('APP_CONFIG.languages.includes(data.language)'));
  const deployment=JSON.parse(fs.readFileSync(`live/${c.id}/wrangler.example.json`,'utf8'));assert.equal(deployment.d1_databases[0].database_id,'REPLACE_WITH_NEW_DATABASE_ID');assert.equal(deployment.account_id,undefined);assert.equal(deployment.routes,undefined);
 }
});
test('generated web files and manifests are scoped to their country',()=>{for(const c of apps){const m=JSON.parse(fs.readFileSync(`dist/web/${c.id}/manifest.webmanifest`));assert.equal(m.scope,'./');assert.equal(m.start_url,'./');assert.equal(m.name,c.name);const html=fs.readFileSync(`dist/web/${c.id}/index.html`,'utf8');assert.ok(html.includes('src="./app.js"'));const sw=fs.readFileSync(`dist/web/${c.id}/sw.js`,'utf8');assert.ok(!sw.includes('/api/'));assert.ok(!sw.includes('./admin.html'));}});
