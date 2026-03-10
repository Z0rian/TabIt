const fs = require('fs');

const CHROM=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const ENARH={Db:'C#',Eb:'D#',Gb:'F#',Ab:'G#',Bb:'A#','E#':'F','B#':'C',Cb:'B',Fb:'E'};
const S2FLAT={'C#':'Db','D#':'Eb','G#':'Ab','A#':'Bb'};
const n2s=n=>CHROM.indexOf(ENARH[n]??n);
function isChord(s){
  const t=s.replace(/[\[\]]/g,'').trim();
  if(!t)return false;
  return /^[A-G][#b]?[a-zA-Z0-9#b\+]*(\/[A-G][#b]?)?$/.test(t) && t.length <= 12;
}
const isChordLine=l=>{const t=l.trim();if(!t)return false;const toks=t.split(/\s+/).filter(Boolean);return toks.length>0&&toks.every(tok=>isChord(tok)||/^x\d+$/i.test(tok));};
function isSectionHdr(line){return/^\[[^\[\]]+\]$/.test(line)&&!isChord(line.slice(1,-1));}

function parseTabImport(raw){
  const lines=raw.split('\n');
  let title='Imported Song',artist='Unknown',key='G',capo=0;
  for(const line of lines){const t=line.trim();if(!t)continue;const m=t.match(/^(.+?)\s+(?:chords?\s+)?by\s+(.+?)$/i);if(m){title=m[1].replace(/\s+chords?$/i,'').trim();artist=m[2].trim();}break;}
  for(const line of lines){const t=line.trim();const km=t.match(/^Key:\s*([A-G][#b]?m?)/i);if(km)key=km[1];const cm=t.match(/^Capo[:\s]+(\d+)/i);if(cm)capo=parseInt(cm[1]);}
  const hasInline=lines.some(l=>/\[[A-G][#b]?/.test(l)&&!isSectionHdr(l.trim()));
  if(hasInline){const si=lines.findIndex(l=>isSectionHdr(l.trim())||/\[[A-G][#b]?/.test(l));return{title,artist,key,capo,tempo:100,content:lines.slice(Math.max(0,si)).join('\n').trim()};}
  let startIdx=lines.findIndex(l=>{const t=l.trim();return/^\[.+\]$/.test(t)&&!isChord(t.slice(1,-1));});
  if(startIdx===-1)startIdx=0;
  const isTabLine=l=>/^\s*[eEBGDAd]\|/.test(l);
  const mergeChordLyric=(cl,ll)=>{
    const chords=[];const rx=/\[([^\[\]]+)\]/g;let m;
    while((m=rx.exec(cl))!==null){
      const name=m[1].trim();
      if(isChord(name))chords.push({chord:name,col:m.index});
    }
    if(!chords.length)return ll.trimEnd();
    let result=ll;while(result.length<chords[chords.length-1].col)result+=' ';
    for(let i=chords.length-1;i>=0;i--){
      const{chord,col}=chords[i];
      const at=Math.min(col,result.length);
      result=result.slice(0,at)+'['+chord+']'+result.slice(at);
    }
    return result.trimEnd();
  };
  const cl=lines.slice(startIdx);const out=[];let i=0;
  while(i<cl.length){
    const line=cl[i];const t=line.trim();
    if(/^Page\s+\d+\/\d+/i.test(t)||isTabLine(line)||/^\s*Fill\s+\d+/i.test(line)||/^[\/\\]\s*=/.test(t)||/^(?:Link to|Tuning:|Difficulty:|Strumming|Suggested|Alternative)/i.test(t)||(/^[\d\s&]+$/.test(t)&&t.length<20)){i++;continue;}
    if(/^\[.+\]$/.test(t)&&!isChord(t.slice(1,-1))){out.push(t);i++;continue;}
    if(!t){out.push('');i++;continue;}
    if(isChordLine(line)){
      const nextLine=cl[i+1];
      if(nextLine!==undefined){const nextT=nextLine.trim();const ok=nextT&&!isChordLine(nextLine)&&!isTabLine(nextLine)&&!/^\[.+\]$/.test(nextT);if(ok){out.push(mergeChordLyric(line,nextLine));i+=2;continue;}}
      const chords=t.split(/\s+/).filter(tok=>isChord(tok));if(chords.length)out.push(chords.map(c=>'['+c.replace(/[\[\]]/g,'')+']').join(''));i++;continue;
    }
    out.push(t);i++;
  }
  const cleaned=[];let pb=false;
  for(const l of out){if(l===''){if(!pb)cleaned.push('');pb=true;}else{cleaned.push(l);pb=false;}}
  return{title,artist,key,capo,tempo:100,content:cleaned.join('\n').trim()};
}

function parseUGContent(raw, meta = {}) {
  const converted = raw
    .replace(/\[tab\]([\s\S]*?)\[\/tab\]/g, '$1')
    .replace(/\[ch\](.*?)\[\/ch\]/g, '[$1]       ')
    .trim();
  const header = [
    meta.title && meta.artist ? `${meta.title} Chords by ${meta.artist}` : '',
    meta.key   ? `Key: ${meta.key}`  : '',
    meta.capo  ? `Capo: ${meta.capo}` : '',
  ].filter(Boolean).join('\n');
  return parseTabImport(header ? header + '\n\n' + converted : converted);
}

const raw = `[tab]Em7    0-2-2-0-3-3\r
G      3-x-0-0-3-3[/tab]
[Intro]
[ch]Em7[/ch]   [ch]G[/ch]   [ch]Dsus4[/ch]
[Verse]
[tab][ch]Em7[/ch]      [ch]G[/ch]
Today is gonna be the day[/tab]`;

const meta = { title: 'Wonderwall', artist: 'Oasis' };
try {
  console.log(JSON.stringify(parseUGContent(raw, meta), null, 2));
} catch(e) {
  console.error("ERROR:", e);
}
