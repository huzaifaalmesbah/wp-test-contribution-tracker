/**
 * Collect normalized structural labels from a comment body fragment.
 * Returns the raw label set (lowercase, alphanumeric-only) plus original text
 * so the classifier can apply regex rules in addition to set membership.
 *
 * Runs inside Playwright's page.evaluate, so it must be self-contained.
 */
export type CommentLabels = {
  headings: string[]; // raw heading text (h1-h4)
  paragraphLabels: string[]; // text from <p><strong>X</strong></p> or <p>X:<br></p>
  tableHeaders: string[]; // <th> text
  tableFirstCol: string[]; // first-cell text from 2-col table rows
  normalized: string[]; // every label above, normalized (lowercased, [a-z0-9] only)
};

/**
 * Browser-side function. Pass a root element (the comment body).
 * Stringified and injected into page.evaluate, so it cannot reference outside scope.
 */
export const collectLabelsBrowserFn = `
function collectLabels(root) {
  const headings = [];
  const paragraphLabels = [];
  const tableHeaders = [];
  const tableFirstCol = [];

  if (!root) return { headings, paragraphLabels, tableHeaders, tableFirstCol, normalized: [] };

  root.querySelectorAll('h1, h2, h3, h4').forEach(function (h) {
    var t = (h.textContent || '').trim();
    if (t) headings.push(t);
  });

  // Paragraph-label detection:
  //   <p><strong>X</strong></p> / <p><b>X</b></p>           — bold-only paragraph
  //   <p>Steps:<br></p>                                      — bare label paragraph
  //   <p>Before Patch :<br><a>...</a><br></p>                — label followed by link/content (split by <br>)
  root.querySelectorAll('p').forEach(function (p) {
    var children = Array.from(p.children).filter(function (c) {
      return c.tagName !== 'BR';
    });
    if (children.length === 1 && (children[0].tagName === 'STRONG' || children[0].tagName === 'B')) {
      var inner = (children[0].textContent || '').trim();
      if (inner && inner.length < 80) paragraphLabels.push(inner);
      return;
    }
    // Split the paragraph by <br> boundaries and check each segment for a
    // standalone label-like string. Catches the common "Before Patch :<br>
    // <link>" structure where label and content share one <p>.
    var segments = [];
    var current = '';
    Array.from(p.childNodes).forEach(function (node) {
      if (node.nodeName === 'BR') {
        if (current.trim()) segments.push(current.trim());
        current = '';
      } else {
        current += (node.textContent || '');
      }
    });
    if (current.trim()) segments.push(current.trim());
    segments.forEach(function (seg) {
      // Strip leading GitHub-markdown header markers: "### Before:" -> "Before:".
      // GitHub-mirrored PR comments often retain markdown that Trac doesn't render.
      var cleaned = seg.replace(/^#+\\s*/, '').trim();
      // Label-like: capitalised, letters/spaces/slashes/hyphens in middle, may
      // end in any combination of colon, dash, dot, equals or whitespace.
      // Note: backslashes are doubled because this regex lives inside a JS
      // template literal — single \\s would become 's' (escape dropped).
      if (cleaned.length < 60 && /^[A-Z][A-Za-z /-]*[\\s:.=\\-]*$/.test(cleaned)) {
        paragraphLabels.push(cleaned);
      }
    });
  });

  root.querySelectorAll('th').forEach(function (th) {
    var t = (th.textContent || '').trim();
    if (t && t.length < 60) tableHeaders.push(t);
  });

  // first-cell of 2-col tables (the "Before / After" header-row pattern)
  root.querySelectorAll('table tr').forEach(function (tr) {
    var cells = tr.querySelectorAll('td');
    if (cells.length === 2) {
      var first = (cells[0].textContent || '').trim();
      var second = (cells[1].textContent || '').trim();
      if (first && first.length < 60) tableFirstCol.push(first);
      if (second && second.length < 60) tableFirstCol.push(second);
    }
  });

  var all = [].concat(headings, paragraphLabels, tableHeaders, tableFirstCol);
  var normalized = all.map(function (s) {
    return s.toLowerCase().replace(/[^a-z0-9]/g, '');
  }).filter(Boolean);

  return { headings: headings, paragraphLabels: paragraphLabels, tableHeaders: tableHeaders, tableFirstCol: tableFirstCol, normalized: normalized };
}
`;
