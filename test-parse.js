const CHROM=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const ENARH={Db:'C#',Eb:'D#',Gb:'F#',Ab:'G#',Bb:'A#','E#':'F','B#':'C',Cb:'B',Fb:'E'};
const n2s=n=>CHROM.indexOf(ENARH[n]??n);

function isChord(s) {
  if (!s) return false;
  let c = s; if(c.startsWith('[') && c.endsWith(']')) c = c.slice(1,-1);
  const m = c.match(/^([A-G][#b]?)(m|maj|min|sus|add|aug|dim)?(6|7|9|11|13)?(\/[A-G][#b]?)?$/i);
  return !!m;
}

function isChordLine(l) {
  const t = l.trim();
  if (!t) return false;
  const toks = t.split(/\s+/).filter(Boolean);
  return toks.length > 0 && toks.every(tok => isChord(tok) || /^x\d+$/i.test(tok));
}

function parseTabImport(raw) {
  const lines = raw.split('\n');
  let title = 'Imported Song', artist = 'Unknown', key = 'G', capo = 0;
  
  const mergeChordLyric = (cl, ll) => {
    const chords = [];
    const rx = /(\S+)/g;
    let m;
    while ((m = rx.exec(cl)) !== null) {
      const name = m[1];
      if (isChord(name)) chords.push({ chord: name, col: m.index });
    }
    if (!chords.length) return ll.trimEnd();
    let result = ll;
    while (result.length < chords[chords.length - 1].col) result += ' ';
    for (let i = chords.length - 1; i >= 0; i--) {
      const { chord, col } = chords[i];
      const at = Math.min(col, result.length);
      result = result.slice(0, at) + '[' + chord + ']' + result.slice(at);
    }
    return result.trimEnd();
  };

  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isChordLine(line)) {
      const next = lines[i + 1];
      if (next && !isChordLine(next) && !/^\s*e\|/.test(next) && !/^\[.+\]$/.test(next.trim())) {
        out.push(mergeChordLyric(line, next));
        i += 2; continue;
      }
      out.push(line.split(/\s+/).filter(Boolean).map(c => `[${c}]`).join(' '));
    } else {
      out.push(line);
    }
    i++;
  }
  return { title, artist, key, capo, content: out.join('\n').trim() };
}

function parseUGContent(raw, meta = {}) {
  const converted = raw
    .replace(/\[tab\]([\s\S]*?)\[\/tab\]/g, '$1')
    .replace(/\[ch\]/g, '')
    .replace(/\[\/ch\]/g, '')
    .trim();
  return { ...meta, content: converted };
}

// TEST
const sample = `[ch]Am[/ch]      [ch]G[/ch]\nLyrics here`;
const preview = parseUGContent(sample);
console.log("CLEAN PREVIEW:", JSON.stringify(preview.content));
const final = parseTabImport(preview.content);
console.log("FINAL MERGED:", final.content);
