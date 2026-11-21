// csv-reader-speed: a fast drop-in for csv-reader 1.0.0.
//
// run(input) returns exactly what csv-reader 1.0.0's readCsv returns for
// {text, header}: {columns, rows, errors}. Written from the published
// broken-row policy (RULES.txt): BOM dropped, records end at LF/CRLF,
// blank lines are no records, a lone CR outside quotes is dropped
// (stray_cr), a field opening with a quote runs to the next undoubled
// quote ("" is one quote, CRLF/lone CR inside read as LF), junk after the
// closing quote is appended as it stands (quote_junk), a quote that never
// closes is a literal and the rest is re-read unquoted
// (unterminated_quote), a quote inside an unquoted field is literal,
// fields stay strings, rows are padded (short_row) or cut (long_row) to
// the first record's width, errors carry {code, line, row} in the order
// met with line the 1-based line the record starts on.
//
// Speed: three tiers. A record that fits on one line with no stray CR is
// split on commas and walked part by part: a part that does not open
// with a quote is a field as it stands (a quote inside it is literal),
// and a quoted part is closed by scanning for its next undoubled quote.
// Only a record whose quote does not close on its line (a quoted field
// spanning lines, or one that never closes) or that holds a stray CR
// falls through to the general record parser, which scans field by
// field with indexOf instead of one character at a time. No state is
// kept from one run() call to the next.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and its index in rows
  // (null for the header). Errors raised while reading it use these.
  let recordLine = 1;
  let recordRow = null;
  // Line counter inside the quotes being read; committed to `line` only
  // when the quote closes. (readQuoted never nests, so one slot is safe.)
  let ln = 1;

  // --- general (slow-path) field readers ---------------------------------
  // Both return {value, ended, added}: added counts the characters kept,
  // which the quote_junk check needs (junk is an error only when it adds
  // at least one character).

  function readUnquoted(value) {
    let added = 0;
    while (pos < n) {
      // The field ends at the first comma, LF or CR at or after pos.
      // Find the next comma first (the common end), then look for a line
      // break or CR inside the slice up to it, so no scan ever runs past
      // the field's end.
      let ci = text.indexOf(',', pos);
      if (ci === -1) ci = n;
      const seg = text.slice(pos, ci);
      const ni = seg.indexOf('\n');
      const ri = seg.indexOf('\r');
      let d = -1; // offset into seg of the terminator, -1 for end of text
      let kind = END;
      if (ni !== -1 && (ri === -1 || ni < ri)) { d = ni; kind = LINE_BREAK; }
      else if (ri !== -1) { d = ri; kind = 3; } // CR: CRLF or stray
      if (d === -1) {
        // No line break or CR before the next comma (or the text's end).
        if (ci === n) {
          if (value === '' && added === 0) {
            pos = n;
            return { value: seg, ended: END, added: seg.length };
          }
          value += seg; added += seg.length; pos = n;
          return { value, ended: END, added };
        }
        if (value === '' && added === 0) {
          pos = ci + 1;
          return { value: seg, ended: COMMA, added: seg.length };
        }
        value += seg; added += seg.length; pos = ci + 1;
        return { value, ended: COMMA, added };
      }
      if (kind === LINE_BREAK) {
        value += seg.slice(0, d); added += d; pos += d + 1; line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      // A CR at offset d: CRLF ends the field, a lone CR is dropped
      // (stray_cr) and the scan goes on.
      if (seg.charCodeAt(d + 1) === 10) {
        value += seg.slice(0, d); added += d; pos += d + 2; line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      value += seg.slice(0, d); added += d; pos += d + 1;
    }
    return { value, ended: END, added };
  }

  function readQuoted() {
    const open = pos;
    const openLine = line;
    // ln counts lines inside the quotes; it is committed to `line` only
    // when the quote closes, so a quote that never closes leaves the
    // line count as it was at the opening quote.
    ln = line;
    let parts = null; // pieces of the value once a "" or a CR/LF shows up
    let value = '';
    let segStart = pos + 1;
    pos = pos + 1;
    let closed = false;
    let closePos = -1;
    while (true) {
      const q = text.indexOf('"', pos);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote: one literal quote, and the field goes on.
        if (parts === null) { parts = []; if (segStart < q) parts.push(foldSeg(segStart, q)); }
        else if (segStart < q) parts.push(foldSeg(segStart, q));
        parts.push('"');
        pos = q + 2;
        segStart = q + 2;
        continue;
      }
      closePos = q;
      closed = true;
      break;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text
      // after it is read again as an unquoted field.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    // One segment, no doubled quote: the common quoted field.
    if (parts === null) {
      value = foldSeg(segStart, closePos);
    } else {
      if (segStart < closePos) parts.push(foldSeg(segStart, closePos));
      value = parts.join('');
    }
    line = ln;
    pos = closePos + 1;
    if (pos >= n) return { value, ended: END, added: 0 };
    const c = text.charCodeAt(pos);
    if (c === 44) { pos += 1; return { value, ended: COMMA, added: 0 }; }
    if (c === 10) { pos += 1; line += 1; return { value, ended: LINE_BREAK, added: 0 }; }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2; line += 1;
      return { value, ended: LINE_BREAK, added: 0 };
    }
    // What follows the closing quote is appended as it stands, up to
    // the next comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) {
      errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    }
    return junk;
  }

  // A quoted segment [a, b): CRLF and lone CR each read as one LF, and
  // the line count (ln) advanced by one per line break inside it.
  function foldSeg(a, b) {
    if (b <= a) return '';
    const seg = text.slice(a, b);
    if (seg.indexOf('\r') === -1) {
      if (seg.indexOf('\n') === -1) return seg;
      ln += seg.split('\n').length - 1;
      return seg;
    }
    const pieces = seg.split(/\r\n|\r|\n/);
    ln += pieces.length - 1;
    return pieces.join('\n');
  }

  // --- single-line record walker ------------------------------------------
  // lineText is one record's line (a trailing CRLF already stripped, no
  // stray CR inside). Returns {fields, errs} or null when a quoted field
  // does not close on this line: the record then needs the general
  // parser (its quoted field spans lines, or never closes at all).
  // Positions run on the line itself, so no text is ever copied except
  // a quoted value that holds a doubled quote or junk after its close.
  // A '"' can only open a quoted field at a field's start, so any other
  // field is read up to its next comma as it stands.
  function walkLine(lineText) {
    const L = lineText.length;
    const fields = [];
    let errs = null; // created only if a quote_junk shows up
    let i = 0;
    while (true) {
      if (i === L) {
        // The line ended with a comma: one last empty field.
        fields.push('');
        break;
      }
      if (lineText.charCodeAt(i) === 34) {
        // A quoted field: find its closing quote.
        let from = i + 1;
        let doubled = false;
        let close = -1;
        while (true) {
          const q = lineText.indexOf('"', from);
          if (q === -1) return null;
          if (lineText.charCodeAt(q + 1) === 34) {
            doubled = true;
            from = q + 2;
            continue;
          }
          close = q;
          break;
        }
        let value = doubled
          ? lineText.slice(i + 1, close).replaceAll('""', '"')
          : lineText.slice(i + 1, close);
        if (close + 1 === L) {
          fields.push(value);
          break;
        }
        if (lineText.charCodeAt(close + 1) === 44) {
          fields.push(value);
          i = close + 2;
          continue;
        }
        // Junk after the closing quote, up to the next comma or the
        // line's end, appended as it stands.
        const nx = lineText.indexOf(',', close + 1);
        if (nx === -1) {
          value += lineText.slice(close + 1);
          if (errs === null) errs = [];
          errs.push({ code: 'quote_junk', line: recordLine, row: recordRow });
          fields.push(value);
          break;
        }
        value += lineText.slice(close + 1, nx);
        if (errs === null) errs = [];
        errs.push({ code: 'quote_junk', line: recordLine, row: recordRow });
        fields.push(value);
        i = nx + 1;
        continue;
      }
      const nx = lineText.indexOf(',', i);
      if (nx === -1) {
        fields.push(lineText.slice(i));
        break;
      }
      fields.push(lineText.slice(i, nx));
      i = nx + 1;
    }
    return { fields, errs };
  }

  // --- main loop ----------------------------------------------------------
  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const recPos = pos;
    const recLine = line;

    // Single-line tier: this record's line, a trailing CRLF stripped.
    // A lone CR at the very end (no LF after it) is a stray CR, so the
    // line is left for the general parser.
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? n : nl;
    let lineText = text.slice(pos, end);
    if (nl !== -1 && lineText.charCodeAt(lineText.length - 1) === 13) {
      lineText = lineText.slice(0, -1);
    }
    let fields = null;
    let recErrs = null;
    if (lineText.indexOf('\r') === -1) {
      if (lineText.indexOf('"') === -1) {
        fields = lineText.split(',');
      } else {
        const w = walkLine(lineText);
        if (w !== null) {
          fields = w.fields;
          recErrs = w.errs;
        }
      }
    }
    if (fields === null) {
      // General tier: the record parser, from the record's start.
      pos = recPos;
      line = recLine;
      fields = [];
      let field;
      let quoted = false;
      do {
        if (text.charCodeAt(pos) === 34) {
          quoted = true;
          field = readQuoted();
        } else {
          quoted = false;
          field = readUnquoted('');
        }
        fields.push(field.value);
      } while (field.ended === COMMA);

      // A line that held only stray CRs is left with no characters: no
      // record (its stray_cr errors stay).
      if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    } else {
      pos = nl === -1 ? n : nl + 1;
      line += 1;
      if (recErrs !== null) {
        for (let k = 0; k < recErrs.length; k++) errors.push(recErrs[k]);
      }
    }

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
