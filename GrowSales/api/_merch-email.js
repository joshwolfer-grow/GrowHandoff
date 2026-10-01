// api/_merch-email.js
// The merch/prize email, rendered in ONE place. The dashboard's Merch Pickup
// preview and api/merch-email.js's send both call renderMerchEmail, so what you
// approve on screen is byte for byte what lands in the inbox. That guarantee is
// the entire point of the preview, and it only holds while there is a single
// renderer — do not copy this markup into index.html.
//
// CommonJS with a window fallback, matching _name-aliases.js: Vercel's bundler
// lets the API `require` it, and build.sh copies it to public/merch-email.js so
// the browser can load it with a plain <script src>. Keep it ES5-safe and free
// of imports for that reason.

// Copy that is identical for every rep. A wording change is an edit here, not
// 127 row updates.
var MERCH_MSG = { pickup: 'middle of October', contact: 'Will Bailey', channel: 'Pronto' };

// Email-safe palette, mirroring C in weekly-rep-email.js so the merch email and
// the weekly email read as the same piece of mail.
var MC = {
  page: '#f2f2ec', bg: '#ffffff', ink: '#1d1d1f', sub: '#585d56',
  faint: '#8a8e87', sep: 'rgba(60,60,67,0.12)', green: '#178f3f', chip: '#f4f4ef'
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// items arrive flat as "Event: Item" in sheet order. Group consecutive runs of
// the same event so the email reads as a list of wins, not 24 loose lines.
function merchGroups(rep) {
  var out = [];
  (rep.items || []).forEach(function (it) {
    var i = String(it).indexOf(': ');
    var ev = i > 0 ? String(it).slice(0, i) : 'Earned';
    var thing = i > 0 ? String(it).slice(i + 2) : String(it);
    if (out.length && out[out.length - 1].event === ev) out[out.length - 1].items.push(thing);
    else out.push({ event: ev, items: [thing] });
  });
  return out;
}

function merchSubject(rep) {
  return (rep.first || rep.name || '') + ', your Grow merch and prizes';
}

// The message, exactly as written. greetless drops the "Hey X, " opener for the
// email body, where the greeting is already its own headline; the plain-text
// twin keeps the full sentence.
function merchBody(rep, greetless) {
  var rest = 'here is a list of the merch and prizes you’ve earned so far. '
    + 'Merch pick up is ' + MERCH_MSG.pickup + ' (dates and times will be finalized and sent out soon). '
    + 'If sizing looks off or you have questions about anything, reach out to ' + MERCH_MSG.contact
    + ' on ' + MERCH_MSG.channel + ' with any other questions!';
  return greetless ? (rest.charAt(0).toUpperCase() + rest.slice(1)) : ('Hey ' + (rep.first || '') + ', ' + rest);
}

// Inline styles only, no flex and no grid: Outlook and Gmail both drop them, and
// this has to survive whatever the reps read mail on. opts.origin is the base
// URL the logo is pulled from.
function renderMerchEmail(rep, opts) {
  opts = opts || {};
  var origin = String(opts.origin || 'https://growsales.vercel.app').replace(/\/$/, '');

  var groups = merchGroups(rep).map(function (g) {
    var items = g.items.map(function (it) {
      return '<tr><td style="padding:5px 0 5px 2px;font-size:15px;color:' + MC.ink + ';line-height:1.35;">'
        + '<span style="color:' + MC.green + ';font-weight:700;">&bull;</span>&nbsp;&nbsp;' + esc(it) + '</td></tr>';
    }).join('');
    return '<div style="padding:14px 0;border-top:1px solid ' + MC.sep + ';">'
      + '<div style="font-size:11px;font-weight:800;letter-spacing:0.09em;text-transform:uppercase;color:' + MC.faint + ';margin-bottom:5px;">' + esc(g.event) + '</div>'
      + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">' + items + '</table></div>';
  }).join('');

  function sizeCell(label, val) {
    return '<td width="50%" style="padding:0 4px;vertical-align:top;">'
      + '<div style="background:' + MC.chip + ';border:1px solid ' + MC.sep + ';border-radius:12px;padding:12px 14px;">'
      + '<div style="font-size:10.5px;font-weight:800;letter-spacing:0.09em;text-transform:uppercase;color:' + MC.faint + ';">' + label + '</div>'
      + '<div style="font-size:24px;font-weight:800;color:' + MC.ink + ';letter-spacing:-0.5px;margin-top:1px;">' + esc(val || '') + '</div>'
      + '</div></td>';
  }

  var count = rep.count != null ? rep.count : (rep.items || []).length;

  return '<div style="margin:0;padding:24px 12px;background:' + MC.page + ';font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;">'
    + '<div style="max-width:560px;margin:0 auto;background:' + MC.bg + ';color:' + MC.ink + ';border-radius:16px;border:1px solid ' + MC.sep + ';overflow:hidden;-webkit-text-size-adjust:100%;">'
      + '<div style="background:#0b0c0b;padding:14px 24px;">'
        + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>'
          + '<td style="vertical-align:middle;"><img src="' + origin + '/icon.png" alt="GROW" height="34" style="height:34px;border-radius:8px;vertical-align:middle;"><span style="color:#ffffff;font-weight:800;font-size:14px;letter-spacing:0.08em;margin-left:10px;vertical-align:middle;">GROW</span></td>'
          + '<td style="text-align:right;vertical-align:middle;color:#8b8f88;font-size:12px;">Merch &amp; Prizes</td>'
        + '</tr></table>'
      + '</div>'
      + '<div style="padding:26px 24px 24px;">'
        + '<div style="font-size:23px;font-weight:800;letter-spacing:-0.4px;">Hey ' + esc(rep.first) + ',</div>'
        + '<div style="font-size:15px;color:' + MC.sub + ';margin-top:9px;line-height:1.55;">' + esc(merchBody(rep, 1)) + '</div>'
        + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px -4px 4px;"><tr>'
          + sizeCell('Shirt size', rep.shirt) + sizeCell('Polo size', rep.polo)
        + '</tr></table>'
        + '<div style="margin-top:22px;font-size:11px;font-weight:800;letter-spacing:0.09em;text-transform:uppercase;color:' + MC.faint + ';">'
          + count + ' item' + (count === 1 ? '' : 's') + ' earned</div>'
        + '<div style="margin-top:4px;">' + groups + '</div>'
      + '</div>'
      + '<div style="background:' + MC.chip + ';border-top:1px solid ' + MC.sep + ';padding:16px 24px;font-size:13px;color:' + MC.sub + ';line-height:1.5;">'
        + 'Pick up is <b style="color:' + MC.ink + ';">' + esc(MERCH_MSG.pickup) + '</b>.'
      + '</div>'
    + '</div></div>';
}

// Plain-text twin, for pasting into a mail merge that wants a text column.
function merchText(rep) {
  var lines = [merchBody(rep), '', 'Shirt size: ' + (rep.shirt || ''), 'Polo size: ' + (rep.polo || ''), '', 'Items earned:'];
  (rep.items || []).forEach(function (it) { lines.push('- ' + it); });
  return lines.join('\n');
}

// Exported as an object LITERAL, not a variable: Node's cjs-module-lexer can only
// see named exports it can read statically, and `module.exports = someVar` hides
// them (so `import { merchSubject }` would throw at load).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MERCH_MSG: MERCH_MSG, merchGroups: merchGroups, merchBody: merchBody,
    merchText: merchText, merchSubject: merchSubject, renderMerchEmail: renderMerchEmail
  };
}
if (typeof window !== 'undefined') {
  window.GrowMerchEmail = {
    MERCH_MSG: MERCH_MSG, merchGroups: merchGroups, merchBody: merchBody,
    merchText: merchText, merchSubject: merchSubject, renderMerchEmail: renderMerchEmail
  };
}
