import fs from 'node:fs';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

// Exercise actual bundled routes without customer data, downloads or outbound calls.
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:fs.readFileSync('cloudflare/worker-bundle.mjs','utf8'),compatibilityDate:'2026-09-24',outboundService:()=>{throw Error('Unexpected origin fallback');}}));
try{
  const root='https://rekhaastrology.in',app='https://astrorani.rekhaastrology.in';
  const homepage=await mf.dispatchFetch(root+'/');assert.equal(homepage.status,200);assert.equal(homepage.headers.get('X-Robots-Tag'),null);
  const html=await homepage.text();assert.match(html,/<title>Rekha Astrology \|/);assert.ok(!html.includes('WhatsApp Now'));
  assert.match(html,/<link rel="canonical" href="https:\/\/rekhaastrology.in\/">/);
  const schema=JSON.parse(html.match(/<script type="application\/ld\+json">\s*([\s\S]*?)<\/script>/)[1]);assert.equal(schema['@graph'].length,3);
  assert.equal(schema['@graph'].find(item=>item['@type']==='WebSite').url,root+'/');
  for(const host of [root,app]){
    const robots=await mf.dispatchFetch(host+'/robots.txt');assert.equal(robots.status,200);assert.match(robots.headers.get('Content-Type'),/text\/plain/);
    const rules=await robots.text();assert.match(rules,/User-agent: OAI-SearchBot\nAllow: \//);assert.match(rules,/Disallow: \/admin/);assert.match(rules,/Disallow: \/api\//);
    const sitemap=await mf.dispatchFetch(host+'/sitemap.xml');assert.equal(sitemap.status,200);assert.match(sitemap.headers.get('Content-Type'),/application\/xml/);
    const xml=await sitemap.text();const urls=[...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(match=>match[1]);assert.equal(urls.length,10);assert.equal(new Set(urls).size,10);
    assert.ok(!urls.some(url=>/admin|\/api\/|\.apk/.test(url)));
    for(const url of urls){const page=await mf.dispatchFetch(url);assert.equal(page.status,200,url);assert.equal(page.headers.get('X-Robots-Tag'),null,url);assert.ok((await page.text()).includes('href="'+url+'"'),url+' must match its canonical');}
    for(const path of ['/robots.txt','/sitemap.xml']){
      const head=await mf.dispatchFetch(host+path,{method:'HEAD'});assert.equal(head.status,200);assert.equal((await head.text()).length,0);
      assert.equal((await mf.dispatchFetch(host+path,{method:'POST'})).status,405);
    }
  }
  for(const path of ['/','/index.html','/admin','/admin/','/admin.html']){
    const page=await mf.dispatchFetch(app+path);assert.equal(page.status,200);assert.equal(page.headers.get('X-Robots-Tag'),'noindex, nofollow',path);
  }
  assert.deepEqual(fs.readFileSync('../index.html'),fs.readFileSync('public/download.html'),'Static origin fallback must match the Worker homepage');
  for(const file of ['robots.txt','sitemap.xml'])assert.deepEqual(fs.readFileSync('../'+file),fs.readFileSync('public/'+file));
  console.log('Public search metadata, canonical sitemap, crawler rules, private page exclusions and GET/HEAD/POST routes passed.');
}finally{await mf.dispose();}
