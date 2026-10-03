// Shared physical infrastructure with fixed, server-selected app namespaces.
// Customer input is always bound as SQL parameters, never used as an identifier.
export function namespaceSql(sql,prefix,names){
  if(!/^g[0-9]{2}_$/.test(prefix))throw Error('Invalid app namespace');
  const known=new Set(names);
  return sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\/|\b[A-Za-z_][A-Za-z0-9_]*\b/g,token=>known.has(token)?prefix+token:token);
}
export function scopeEnvironment(env,prefix,names){
  const root='global-connected/'+prefix+'/';
  const DB={prepare:sql=>env.DB.prepare(namespaceSql(sql,prefix,names)),batch:statements=>env.DB.batch(statements)};
  const MEDIA=env.MEDIA?{put:(key,...args)=>env.MEDIA.put(root+key,...args),get:(key,...args)=>env.MEDIA.get(root+key,...args),head:key=>env.MEDIA.head(root+key),delete:key=>env.MEDIA.delete(Array.isArray(key)?key.map(k=>root+k):root+key)}:undefined;
  return {...env,DB,MEDIA};
}
