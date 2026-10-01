// site/chibi.js — chibi workers for the isometric office. Drawn in a 100×130 box
// with the feet at (50,118); facing right by default, mirrored for left.
// Two heads tall, big eyes, soft outlines. `frame` is radians; `pose` is one of
// stand | walk | sit | type | sleep | slump | hop | carry | carrywalk | water.
export const STATE_BADGE = {
  working: { fill: '#2E9C6D', text: '' },
  idle:    { fill: '', text: '' },
  blocked: { fill: '#E9B44C', text: '?' },
  failed:  { fill: '#D85A30', text: '!' },
  stale:   { fill: '#8A8F98', text: 'z' },
  offduty: { fill: '#9FB3C8', text: '·' },
};
const OUT = '#2B2118';
const SKINS = ['#F3C9A8', '#E8B48F', '#C68642', '#8D5524', '#F7D9C4', '#A9713F'];
const HAIRS = ['round', 'spiky', 'side', 'bun', 'buzz', 'curly', 'long'];
const ACCS = ['none', 'glasses', 'beard', 'cap', 'headband', 'none', 'earring'];
const SHIRTS = ['#3F7CCF', '#D9534F', '#F0A23B', '#6C5CE7', '#20A39E', '#E67AA5', '#8AA33F', '#B07D4F'];
const PROPS = {
  net:     `<path d="M0 0 L16 -18" stroke="${OUT}" stroke-width="5"/><path d="M0 0 L16 -18" stroke="#C48A4A" stroke-width="2.5"/><circle cx="20" cy="-23" r="7" fill="none" stroke="${OUT}" stroke-width="2"/>`,
  bolt:    `<path d="M4 -22 L-2 -8 L5 -9 L0 6 L12 -12 L5 -11Z" fill="#E9B44C" stroke="${OUT}" stroke-width="1.5"/>`,
  scroll:  `<rect x="-2" y="-8" width="20" height="9" rx="4.5" fill="#FAF0DC" stroke="${OUT}" stroke-width="1.5"/>`,
  satchel: `<rect x="-4" y="-6" width="20" height="16" rx="3" fill="#8B5A2B" stroke="${OUT}" stroke-width="1.5"/><rect x="-4" y="-6" width="20" height="6" rx="3" fill="#6B4423"/>`,
  crate:   `<rect x="-6" y="-14" width="22" height="18" rx="2" fill="#C48A4A" stroke="${OUT}" stroke-width="1.5"/><path d="M-6 -5 H16 M5 -14 V4" stroke="${OUT}" stroke-width="1.2"/>`,
  broom:   `<path d="M-2 -24 L12 12" stroke="#C48A4A" stroke-width="3"/><path d="M8 4 L20 0 L22 12 L12 16Z" fill="#E9B44C" stroke="${OUT}" stroke-width="1.5"/>`,
  glass:   `<circle cx="6" cy="-10" r="7" fill="#BFE0FF" stroke="${OUT}" stroke-width="2"/><path d="M11 -5 L18 2" stroke="${OUT}" stroke-width="3"/>`,
  ledger:  `<rect x="-3" y="-14" width="18" height="22" rx="2" fill="#FAF0DC" stroke="${OUT}" stroke-width="1.5"/><path d="M0 -8 H12 M0 -3 H12 M0 2 H8" stroke="#B4A58C" stroke-width="1.5"/>`,
  coin:    `<circle cx="6" cy="-8" r="8" fill="#E9B44C" stroke="${OUT}" stroke-width="1.5"/><circle cx="6" cy="-8" r="4" fill="none" stroke="#C48A4A" stroke-width="1.5"/>`,
  dumbbell:`<path d="M-6 -6 H18" stroke="${OUT}" stroke-width="4"/><rect x="-10" y="-12" width="6" height="12" rx="2" fill="#5F6570" stroke="${OUT}" stroke-width="1.2"/><rect x="16" y="-12" width="6" height="12" rx="2" fill="#5F6570" stroke="${OUT}" stroke-width="1.2"/>`,
  clipboard:`<rect x="-3" y="-16" width="18" height="24" rx="2" fill="#8B5A2B" stroke="${OUT}" stroke-width="1.5"/><rect x="-1" y="-13" width="14" height="19" fill="#FAF0DC"/><rect x="2" y="-18" width="8" height="5" rx="1.5" fill="#5F6570"/><path d="M2 -8 H10 M2 -4 H10 M2 0 H7" stroke="#B4A58C" stroke-width="1.3"/>`,
  mug:     `<rect x="0" y="-12" width="12" height="13" rx="2" fill="#FFF" stroke="${OUT}" stroke-width="1.5"/><path d="M12 -9 Q17 -9 17 -5 Q17 -1 12 -1" fill="none" stroke="${OUT}" stroke-width="1.5"/><path d="M3 -15 Q6 -20 9 -15" stroke="#B4B2A9" stroke-width="1.2" fill="none"/>`,
  can:     `<path d="M-2 -10 H12 L10 2 H0Z" fill="#7FC8C0" stroke="${OUT}" stroke-width="1.5"/><path d="M12 -8 L20 -14" stroke="${OUT}" stroke-width="2.5"/>`,
  paper:   `<rect x="-2" y="-12" width="16" height="20" rx="1.5" fill="#FAF0DC" stroke="${OUT}" stroke-width="1.5"/><path d="M1 -7 H11 M1 -3 H11 M1 1 H8" stroke="#B4A58C" stroke-width="1.3"/>`,
};

function hashStr(str) { let h = 2166136261; for (const c of String(str)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
export function lookFor(id, sprite = {}) {
  const h = hashStr(id);
  return {
    skin: sprite.skin || SKINS[h % SKINS.length],
    hairStyle: sprite.hairStyle || HAIRS[(h >>> 3) % HAIRS.length],
    acc: sprite.acc || ACCS[(h >>> 7) % ACCS.length],
    hair: /^#[0-9a-f]{3,8}$/i.test(sprite.hair || '') ? sprite.hair : '#4A1B0C',
    shirt: /^#[0-9a-f]{3,8}$/i.test(sprite.shirt || '') ? sprite.shirt : SHIRTS[(h >>> 11) % SHIRTS.length],
  };
}
const shade = (hex, k = 0.78) => { const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex); if (!m) return hex; return '#' + m.slice(1).map(c => Math.round(parseInt(c, 16) * k).toString(16).padStart(2, '0')).join(''); };

function hairSvg(style, hair) {
  const cap = `<path d="M22 36 Q24 8 50 8 Q76 8 78 36 Q64 24 50 26 Q36 24 22 36Z" fill="${hair}"/>`;
  switch (style) {
    case 'spiky': return `<path d="M22 38 L26 20 L33 30 L38 12 L45 26 L50 8 L55 26 L62 12 L67 30 L74 20 L78 38 Q50 24 22 38Z" fill="${hair}"/>`;
    case 'side':  return cap + `<path d="M22 34 Q18 50 24 62 Q26 44 30 34Z" fill="${hair}"/>`;
    case 'bun':   return cap + `<circle cx="50" cy="8" r="9" fill="${hair}"/>`;
    case 'buzz':  return `<path d="M24 34 Q26 14 50 14 Q74 14 76 34 Q64 28 50 28 Q36 28 24 34Z" fill="${hair}"/>`;
    case 'curly': return cap + [24, 33, 42, 50, 58, 67, 76].map((x, i) => `<circle cx="${x}" cy="${i === 0 || i === 6 ? 30 : 14}" r="8" fill="${hair}" stroke="${OUT}" stroke-width="2"/>`).join('');
    case 'long':  return cap + `<path d="M22 34 Q14 58 22 78 L30 74 Q26 56 30 34Z" fill="${hair}"/><path d="M78 34 Q86 58 78 78 L70 74 Q74 56 70 34Z" fill="${hair}"/>`;
    default:      return cap;
  }
}
function accSvg(acc, hair) {
  switch (acc) {
    case 'glasses':  return `<rect x="30" y="38" width="16" height="13" rx="6" fill="#FFFFFF33" stroke="${OUT}" stroke-width="2.2"/><rect x="54" y="38" width="16" height="13" rx="6" fill="#FFFFFF33" stroke="${OUT}" stroke-width="2.2"/><path d="M46 44 H54" stroke="${OUT}" stroke-width="2.2"/>`;
    case 'beard':    return `<path d="M30 52 Q32 70 50 72 Q68 70 70 52 Q60 62 50 62 Q40 62 30 52Z" fill="${hair}"/>`;
    case 'cap':      return `<path d="M22 32 Q24 10 50 10 Q76 10 78 32Z" fill="#2F6FBF" stroke="${OUT}" stroke-width="2"/><path d="M18 32 H82 L86 38 H22Z" fill="#224F8A" stroke="${OUT}" stroke-width="2"/>`;
    case 'headband': return `<rect x="22" y="24" width="56" height="8" rx="4" fill="#E24B4A"/>`;
    case 'earring':  return `<circle cx="77" cy="54" r="3" fill="#E9B44C"/>`;
    default: return '';
  }
}

export function character({ id = '', sprite = {}, state = 'idle', frame = 0, pose = 'stand', prop = '' }) {
  const look = lookFor(id, sprite);
  const SK = look.skin, SH = look.shirt, SH2 = shade(SH);
  const walk = pose === 'walk' || pose === 'carrywalk';
  const swing = walk ? Math.sin(frame) * 9 : 0;
  const bob = walk ? Math.abs(Math.sin(frame)) * 3 : pose === 'type' ? Math.sin(frame * 2) * 1.2 : pose === 'hop' ? Math.abs(Math.sin(frame)) * 22 : pose === 'sleep' ? Math.sin(frame * 0.5) * 1.5 : 0;
  const slump = pose === 'slump' ? 8 : 0;
  const sit = pose === 'sit' || pose === 'type';
  const carry = pose === 'carry' || pose === 'carrywalk';
  // Arms: angle in degrees around the shoulder.
  const armL = pose === 'type' ? -70 + Math.sin(frame * 2) * 8 : walk ? -swing * 2 : pose === 'hop' ? -150 : pose === 'water' ? -30 : carry ? -80 : pose === 'sleep' ? 10 : 0;
  const armR = pose === 'type' ? -70 - Math.sin(frame * 2) * 8 : walk ? swing * 2 : pose === 'hop' ? -150 : pose === 'water' ? -95 + Math.sin(frame) * 6 : carry ? -80 : pose === 'sleep' ? 10 : -10;
  const propSvg = PROPS[prop] || '';

  const eyes = pose === 'sleep'
    ? `<path d="M34 46 Q39 50 44 46" stroke="${OUT}" stroke-width="2.5" fill="none"/><path d="M56 46 Q61 50 66 46" stroke="${OUT}" stroke-width="2.5" fill="none"/>`
    : `<ellipse cx="39" cy="46" rx="7" ry="9" fill="#FFF" stroke="${OUT}" stroke-width="2"/><ellipse cx="61" cy="46" rx="7" ry="9" fill="#FFF" stroke="${OUT}" stroke-width="2"/>
       <ellipse cx="41" cy="47" rx="4" ry="6.5" fill="#2A3B48"/><ellipse cx="63" cy="47" rx="4" ry="6.5" fill="#2A3B48"/><circle cx="42.5" cy="44" r="1.6" fill="#FFF"/><circle cx="64.5" cy="44" r="1.6" fill="#FFF"/>`;
  const mouth = pose === 'hop' ? `<ellipse cx="50" cy="61" rx="5" ry="4.5" fill="#993C1D" stroke="${OUT}" stroke-width="1.5"/>`
    : state === 'blocked' ? `<path d="M44 62 Q50 58 56 62" stroke="${OUT}" stroke-width="2.2" fill="none"/>`
    : state === 'failed' || pose === 'slump' ? `<path d="M43 63 Q50 58 57 63" stroke="${OUT}" stroke-width="2.2" fill="none"/>`
    : pose === 'sleep' ? `<ellipse cx="50" cy="61" rx="2.5" ry="3.5" fill="#993C1D"/>`
    : `<path d="M44 60 Q50 66 56 60" stroke="${OUT}" stroke-width="2.2" fill="none"/>`;
  const brows = state === 'blocked' || state === 'failed'
    ? `<path d="M32 36 Q39 40 46 37" stroke="${OUT}" stroke-width="2.6" fill="none"/><path d="M54 37 Q61 40 68 36" stroke="${OUT}" stroke-width="2.6" fill="none"/>`
    : `<path d="M32 35 Q39 31 46 35" stroke="${OUT}" stroke-width="2.6" fill="none"/><path d="M54 35 Q61 31 68 35" stroke="${OUT}" stroke-width="2.6" fill="none"/>`;

  const legs = sit
    ? `<path d="M36 96 L36 106 L28 106" stroke="${OUT}" stroke-width="9" stroke-linecap="round" fill="none"/><path d="M36 96 L36 106 L28 106" stroke="#4A4A55" stroke-width="5" stroke-linecap="round" fill="none"/>
       <path d="M62 96 L62 106 L54 106" stroke="${OUT}" stroke-width="9" stroke-linecap="round" fill="none"/><path d="M62 96 L62 106 L54 106" stroke="#4A4A55" stroke-width="5" stroke-linecap="round" fill="none"/>`
    : `<path d="M40 96 L${40 + swing * 0.6} 114" stroke="${OUT}" stroke-width="10" stroke-linecap="round"/><path d="M40 96 L${40 + swing * 0.6} 114" stroke="#4A4A55" stroke-width="6" stroke-linecap="round"/>
       <path d="M60 96 L${60 - swing * 0.6} 114" stroke="${OUT}" stroke-width="10" stroke-linecap="round"/><path d="M60 96 L${60 - swing * 0.6} 114" stroke="#4A4A55" stroke-width="6" stroke-linecap="round"/>
       <ellipse cx="${40 + swing * 0.6}" cy="116" rx="7" ry="4" fill="#2C2C2A"/><ellipse cx="${60 - swing * 0.6}" cy="116" rx="7" ry="4" fill="#2C2C2A"/>`;
  const arm = (x, ang, withProp) => `<g transform="rotate(${ang} ${x} 78)"><path d="M${x} 78 L${x} 100" stroke="${OUT}" stroke-width="9" stroke-linecap="round"/><path d="M${x} 78 L${x} 100" stroke="${SH}" stroke-width="5" stroke-linecap="round"/><circle cx="${x}" cy="101" r="4.5" fill="${SK}" stroke="${OUT}" stroke-width="1.8"/>${withProp ? `<g transform="translate(${x},101)">${propSvg}</g>` : ''}</g>`;

  return `<g stroke-linejoin="round" stroke-linecap="round">
  <ellipse cx="50" cy="118" rx="${24 - bob * 0.3}" ry="7" fill="#00000024"/>
  <g transform="translate(0,${-bob + slump})">
    ${arm(32, armL, false)}
    <g transform="rotate(${slump * 0.8} 50 90)">
      ${legs}
      <path d="M32 76 Q32 70 50 70 Q68 70 68 76 L70 98 Q50 104 30 98Z" fill="${SH}" stroke="${OUT}" stroke-width="2.5"/>
      <path d="M36 86 Q50 82 64 86 L66 98 Q50 102 34 98Z" fill="${SH2}" opacity="0.7"/>
    </g>
    ${arm(68, -armR, true)}
    <g transform="rotate(${slump * 1.6} 50 70)">
      <circle cx="50" cy="44" r="30" fill="${SK}" stroke="${OUT}" stroke-width="2.5"/>
      ${look.acc === 'cap' ? '' : hairSvg(look.hairStyle, look.hair)}
      ${eyes}${brows}${mouth}
      ${accSvg(look.acc, look.hair)}
      <circle cx="30" cy="56" r="3.5" fill="#F0997B" opacity="0.8"/><circle cx="70" cy="56" r="3.5" fill="#F0997B" opacity="0.8"/>
    </g>
  </g>
</g>`;
}

// Little floating state badge above the head. Empty string for states that need none.
export function badge(state) {
  const b = STATE_BADGE[state]; if (!b || !b.fill) return '';
  return `<g><circle cx="0" cy="0" r="9" fill="${b.fill}" stroke="${OUT}" stroke-width="2"/><text x="0" y="4" text-anchor="middle" font-size="12" font-weight="800" fill="#FFF">${b.text}</text></g>`;
}
