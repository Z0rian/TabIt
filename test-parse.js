const CHROM=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
const ENARH={Db:'C#',Eb:'D#',Gb:'F#',Ab:'G#',Bb:'A#','E#':'F','B#':'C',Cb:'B',Fb:'E'};
const n2s=n=>CHROM.indexOf(ENARH[n]??n);

function isChord(s) {
  if (!s) return false;
  // Support bracketed chords [Am]
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
      const name = m[1].replace(/[\[\]]/g, '');
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

  const hasInline = lines.some(l => /\[[A-G][#b]?/.test(l));
  if (hasInline) return { title, artist, key, capo, content: raw };

  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isChordLine(line)) {
      const next = lines[i + 1];
      if (next && !isChordLine(next)) {
        out.push(mergeChordLyric(line, next));
        i += 2; continue;
      }
      out.push(line.split(/\s+/).filter(Boolean).map(c => `[${c}]`).join(''));
    } else {
      out.push(line);
    }
    i++;
  }
  return { title, artist, key, capo, content: out.join('\n').trim() };
}

function parseUGContent(raw, meta = {}) {
  // Use length-preserving replacement for [ch] tags.
  const converted = raw
    .replace(/\[tab\]([\s\S]*?)\[\/tab\]/g, '$1')
    .replace(/\[ch\](.*?)\[\/ch\]/g, '[$1]       ') 
    .trim();
  return parseTabImport(converted);
}

// TEST CASES
const rawUG = `[tab][ch]G[/ch]          [ch]Cadd9[/ch]
Some lyrics here[/tab]`;
const parsed = parseUGContent(rawUG);
console.log("UG IMPORT TEST:");
console.log(parsed.content);
// Expected: [G]         [Cadd9]Some lyrics here (or merged)

const mixed = "         [G]      [Cadd9]\nSome lyrics here";
const p2 = parseTabImport(mixed);
console.log("\nMORPHED GRID TEST:");
console.log(p2.content);
