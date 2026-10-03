// Owner-edited data only. Ads, real payment activation, credentials and code are
// deliberately outside this schema. A draft never changes the customer app.
function appSettingsFreeze(value){for(const child of Object.values(value))if(child&&typeof child==='object')appSettingsFreeze(child);return Object.freeze(value);}
export const appSettingsDefaults=appSettingsFreeze({
  brand:{name:'Rekha Astrology',astrologerName:'Rekha',tagline:'Your personal conversation',primaryColor:'#075e54',accentColor:'#008069',logoMediaId:null},
  onboarding:{introEnabled:true,introOrder:['welcome','introduction','testimonials']},
  chat:{attachmentsEnabled:true,voiceNotesEnabled:true,voiceCallsEnabled:true,videoCallsEnabled:true,customerMessagingEnabled:true},
  service:{freeReplies:3,unlockPriceRupees:49,retentionDays:30},
  copy:{hi:{},en:{},hinglish:{}}
});
const appSettingsCopyLimits={tagline:120,languageTitle:160,languageSubtitle:1000,detailsTitle:160,detailsSubtitle:1000,kundli:2000,kundliNote:2000,permissionsTitle:160,permissionsSubtitle:1000,messagePlaceholder:200,reflection:1000,offerTitle:160,offerText:2000};
const appSettingsImageMimes=['image/jpeg','image/png','image/webp'];
const appSettingsClock=ctx=>typeof ctx.now==='function'?ctx.now():Date.now();
function appSettingsObject(value){return !!value&&typeof value==='object'&&!Array.isArray(value);}
function appSettingsKeys(ctx,value,keys,required=true){
  if(!appSettingsObject(value)||Object.keys(value).some(key=>!keys.includes(key))||(required&&keys.some(key=>!Object.hasOwn(value,key))))throw ctx.fail(400,'Use the supported app settings fields.');
}
function appSettingsText(ctx,value,limit,label){
  if(typeof value!=='string'||!value.trim()||value.length>limit||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f<>]/.test(value))throw ctx.fail(400,`${label} must be plain text containing 1–${limit} characters.`);
}
function appSettingsInteger(ctx,value,min,max,label){if(!Number.isSafeInteger(value)||value<min||value>max)throw ctx.fail(400,`${label} must be a whole number from ${min} to ${max}.`);}
function appSettingsRevision(ctx,value){appSettingsInteger(ctx,value,0,Number.MAX_SAFE_INTEGER-1,'Revision');}
async function appSettingsValidate(ctx,settings){
  appSettingsKeys(ctx,settings,['brand','onboarding','chat','service','copy']);
  const {brand,onboarding,chat,service,copy}=settings;
  appSettingsKeys(ctx,brand,['name','astrologerName','tagline','primaryColor','accentColor','logoMediaId']);
  appSettingsText(ctx,brand.name,60,'App name');appSettingsText(ctx,brand.astrologerName,60,'Astrologer name');appSettingsText(ctx,brand.tagline,120,'Tagline');
  for(const color of [brand.primaryColor,brand.accentColor])if(typeof color!=='string'||!/^#[0-9a-f]{6}$/i.test(color))throw ctx.fail(400,'Choose colors in #RRGGBB format.');
  if(brand.logoMediaId!==null){
    if(typeof brand.logoMediaId!=='string'||!/^[a-f0-9-]{36}$/.test(brand.logoMediaId))throw ctx.fail(400,'Choose a logo from your private image library.');
    const media=await ctx.one('SELECT * FROM media_items WHERE id=?',brand.logoMediaId);
    if(!media||media.archived||media.type!=='image'||!media.object_key||!appSettingsImageMimes.includes(media.mime))throw ctx.fail(400,'The logo must be an available private JPEG, PNG or WebP library image.');
    if(!ctx.env.MEDIA)throw ctx.fail(503,'Image storage is unavailable.');
    const object=await ctx.env.MEDIA.head(media.object_key);
    if(!object)throw ctx.fail(400,'The selected logo image is unavailable.');
  }
  appSettingsKeys(ctx,onboarding,['introEnabled','introOrder']);
  if(typeof onboarding.introEnabled!=='boolean'||!Array.isArray(onboarding.introOrder)||onboarding.introOrder.length!==3||new Set(onboarding.introOrder).size!==3||onboarding.introOrder.some(key=>!['welcome','introduction','testimonials'].includes(key)))throw ctx.fail(400,'Choose whether to show the introduction and order all three introduction videos.');
  appSettingsKeys(ctx,chat,['attachmentsEnabled','voiceNotesEnabled','voiceCallsEnabled','videoCallsEnabled','customerMessagingEnabled']);
  if(Object.values(chat).some(value=>typeof value!=='boolean'))throw ctx.fail(400,'Chat options must be on or off.');
  appSettingsKeys(ctx,service,['freeReplies','unlockPriceRupees','retentionDays']);
  appSettingsInteger(ctx,service.freeReplies,0,20,'Free replies');appSettingsInteger(ctx,service.unlockPriceRupees,1,9999,'Unlock price');appSettingsInteger(ctx,service.retentionDays,7,90,'Retention days');
  appSettingsKeys(ctx,copy,['hi','en','hinglish']);
  for(const language of ['hi','en','hinglish']){
    appSettingsKeys(ctx,copy[language],[...Object.keys(appSettingsCopyLimits),'topics'],false);
    for(const [key,value]of Object.entries(copy[language])){
      if(key==='topics'){
        if(!Array.isArray(value)||value.length<3||value.length>6)throw ctx.fail(400,'Choose three to six suggested topics.');
        for(const topic of value)appSettingsText(ctx,topic,120,'Suggested topic');
      }else appSettingsText(ctx,value,appSettingsCopyLimits[key],'Reply wording');
    }
  }
  return structuredClone(settings);
}
function appSettingsView(row){
  return row?{published:JSON.parse(row.published),draft:JSON.parse(row.draft),revision:row.revision,updated:row.updated,publishedAt:row.published_at??null}
    :{published:structuredClone(appSettingsDefaults),draft:structuredClone(appSettingsDefaults),revision:0,updated:null,publishedAt:null};
}
export async function appSettingsGet(ctx){return appSettingsView(await ctx.one('SELECT * FROM app_settings WHERE id=1'));}
export async function appSettingsPublic(ctx){const view=await appSettingsGet(ctx);return{settings:view.published,revision:view.revision,publishedAt:view.publishedAt};}
async function appSettingsCommit(ctx,next,expected,checkLogo){
  const logo=checkLogo?next.draft.brand.logoMediaId:null;
  // INSERT handles the first revision without writing defaults during GET.
  // The conflict predicate and media guard execute in the same D1 transaction;
  // concurrent save/publish/archive cannot silently overwrite another change.
  const outcome=await ctx.env.DB.batch([ctx.stmt(
    "INSERT INTO app_settings(id,published,draft,revision,updated,published_at) SELECT 1,?,?,?,?,? WHERE (?=0 OR EXISTS(SELECT 1 FROM app_settings WHERE id=1 AND revision=?)) AND (? IS NULL OR EXISTS(SELECT 1 FROM media_items WHERE id=? AND archived=0 AND type='image' AND object_key IS NOT NULL AND mime IN ('image/jpeg','image/png','image/webp'))) ON CONFLICT(id) DO UPDATE SET published=excluded.published,draft=excluded.draft,revision=excluded.revision,updated=excluded.updated,published_at=excluded.published_at WHERE app_settings.revision=? RETURNING *",
    JSON.stringify(next.published),JSON.stringify(next.draft),expected+1,next.updated,next.publishedAt,expected,expected,logo,logo,expected
  )]);
  const row=outcome[0]?.results?.[0];
  if(!row)throw ctx.fail(409,'The app settings changed. Refresh and review before saving.');
  return appSettingsView(row);
}
export async function appSettingsRoutes(ctx){
  const {route,method,owner,body,result}=ctx;
  if(!['/api/admin/app-settings','/api/admin/app-settings/publish','/api/admin/app-settings/discard'].includes(route))return null;
  await owner();
  if(route==='/api/admin/app-settings'&&method==='GET')return result(await appSettingsGet(ctx));
  if((route==='/api/admin/app-settings'&&method!=='PATCH')||(route!=='/api/admin/app-settings'&&method!=='POST'))throw ctx.fail(405,'Method not allowed.');
  const data=await body();appSettingsKeys(ctx,data,route==='/api/admin/app-settings'?['draft','revision']:['revision']);appSettingsRevision(ctx,data.revision);
  const current=await appSettingsGet(ctx);if(current.revision!==data.revision)throw ctx.fail(409,'The app settings changed. Refresh and review before saving.');
  const next={...current,updated:appSettingsClock(ctx)};
  if(route==='/api/admin/app-settings')next.draft=await appSettingsValidate(ctx,data.draft);
  else if(route==='/api/admin/app-settings/publish'){next.draft=await appSettingsValidate(ctx,current.draft);next.published=structuredClone(next.draft);next.publishedAt=appSettingsClock(ctx);}
  else next.draft=structuredClone(current.published);
  return result(await appSettingsCommit(ctx,next,data.revision,route!=='/api/admin/app-settings/discard'));
}
