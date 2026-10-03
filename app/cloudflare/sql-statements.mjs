// SQLite trigger bodies contain semicolons; keep each complete CREATE TRIGGER
// statement together for D1's prepared-statement API and migration retries.
export function splitSqlStatements(source){
  const statements=[];let part='',word='',quote='',comment='',trigger=false,depth=0;
  const finishWord=()=>{if(!word)return;const upper=word.toUpperCase();if(!trigger&&/\bCREATE\s+TRIGGER\b/i.test(part))trigger=true;if(trigger){if(upper==='BEGIN'||upper==='CASE')depth++;else if(upper==='END')depth--;}word='';};
  for(let i=0;i<source.length;i++){
    const char=source[i],next=source[i+1];
    if(comment){part+=char;if(comment==='line'&&char==='\n')comment='';else if(comment==='block'&&char==='*'&&next==='/'){part+=source[++i];comment='';}continue;}
    if(quote){part+=char;if(char===quote){if(next===quote)part+=source[++i];else quote='';}continue;}
    if(char==='-'&&next==='-'){finishWord();part+=char+source[++i];comment='line';continue;}
    if(char==='/'&&next==='*'){finishWord();part+=char+source[++i];comment='block';continue;}
    if(char==="'"||char==='"'||char==='`'){finishWord();quote=char;part+=char;continue;}
    if(/[A-Za-z_]/.test(char)){word+=char;part+=char;continue;}
    finishWord();part+=char;
    if(char===';'&&(!trigger||depth===0)){if(part.trim())statements.push(part.trim());part='';trigger=false;depth=0;}
  }
  finishWord();if(part.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g,'').trim())statements.push(part.trim());return statements;
}
