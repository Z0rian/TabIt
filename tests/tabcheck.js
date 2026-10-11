// Checks how tablature is laid out, in the page (tests/e2e_tabs.py):
//  - every row of a staff is in every part it's cut into, and nothing runs
//    past the edge;
//  - the parts put back together are the staff as written (columns kept);
//  - no fret number is cut in two.
// Also counts how the staves came out (one row, cut in parts, made smaller).

export function checkTabs(sheet) {
  const problems = [];
  const stats = { staves: 0, oneRow: 0, rows: 0, smaller: 0, notesAbove: 0 };
  for (const [bi, t] of [...sheet.querySelectorAll('.blk.tab')].entries()) {
    const boxes = [...t.children].filter(x => x.classList.contains('tseg'));
    if (boxes.length !== t._segs.length) { problems.push({ block: bi, what: 'parts', got: boxes.length, want: t._segs.length }); continue; }
    t._segs.forEach((seg, si) => {
      const box = boxes[si];
      const where = { block: bi, staff: si };
      for (const row of box.querySelectorAll('.tl, .tt')) {
        if (row.scrollWidth > row.clientWidth + 1) problems.push({ ...where, what: 'runs past the edge', text: row.textContent.slice(0, 60), by: row.scrollWidth - row.clientWidth });
      }
      if (seg.plain) return;
      stats.staves++;
      const systems = [...box.children].filter(x => x.classList.contains('sys'));
      stats.rows += systems.length;
      if (systems.length === 1) stats.oneRow++;
      if (box.style.fontSize) stats.smaller++;
      const head = +box.dataset.head || 0;
      const bare = box.querySelectorAll('.tt').length > seg.titles.length;
      if (bare) stats.notesAbove++;
      const want = (bare ? seg.bare : seg.rows).filter(r => r.staff).map(r => r.text);
      const got = want.map(() => '');
      let last = null;
      systems.forEach((sys, k) => {
        const rows = [...sys.querySelectorAll('.tl.st')].map(r => r.textContent.replace(/ /g, ''));
        if (rows.length !== want.length) { problems.push({ ...where, what: 'rows in a part', part: k, got: rows.length, want: want.length }); return; }
        rows.forEach((text, i) => {
          const body = k && head ? text.slice(head) : text;
          if (k && last && /\d$/.test(last[i]) && /^\d/.test(body)) problems.push({ ...where, what: 'fret number cut in two', part: k, row: i, at: last[i].slice(-4) + '|' + body.slice(0, 4) });
          got[i] += body;
        });
        last = rows.map((text, i) => (k && head ? text.slice(head) : text));
      });
      want.forEach((w, i) => {
        if (got[i] !== w) problems.push({ ...where, what: 'staff changed', row: i, want: w.slice(0, 80), got: got[i].slice(0, 80) });
      });
    });
  }
  return { problems, stats };
}
