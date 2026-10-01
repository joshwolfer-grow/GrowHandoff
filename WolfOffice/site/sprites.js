// site/sprites.js
export const STATE_COLORS = {
  working: { body: '#2E9C6D', shade: '#1F7350' },
  idle:    { body: '#8A8F98', shade: '#5F6570' },
  blocked: { body: '#E9B44C', shade: '#C48A4A' },
  failed:  { body: '#D85A30', shade: '#993C1D' },
  stale:   { body: '#B4B2A9', shade: '#7A7870' },
  offduty: { body: '#9FB3C8', shade: '#6C8299' },
};

const PROPS = {
  net:     `<path d="M112 140 L136 112" stroke-width="9"/><path d="M112 140 L136 112" stroke="#C48A4A" stroke-width="4"/><circle cx="142" cy="104" r="12" fill="none" stroke-width="3"/>`,
  bolt:    `<path d="M128 100 L118 124 L130 122 L122 148 L142 116 L130 118 Z" fill="#E9B44C"/>`,
  scroll:  `<rect x="120" y="106" width="34" height="14" rx="7" fill="#FAF0DC"/><rect x="118" y="104" width="8" height="18" rx="4" fill="#C48A4A"/>`,
  satchel: `<rect x="118" y="112" width="34" height="26" rx="5" fill="#8B5A2B"/><rect x="118" y="112" width="34" height="9" rx="4" fill="#6B4423"/>`,
  crate:   `<rect x="116" y="110" width="36" height="30" rx="3" fill="#C48A4A"/><path d="M116 125 H152 M134 110 V140" stroke-width="2"/>`,
  broom:   `<path d="M120 90 L146 150" stroke="#C48A4A" stroke-width="5"/><path d="M138 134 L162 128 L164 150 L146 156Z" fill="#E9B44C"/>`,
  glass:   `<circle cx="132" cy="108" r="12" fill="#BFE0FF"/><path d="M140 118 L150 130" stroke-width="5"/>`,
  ledger:  `<rect x="118" y="104" width="30" height="36" rx="3" fill="#FAF0DC"/><path d="M124 114 H142 M124 122 H142 M124 130 H136" stroke="#B4A58C" stroke-width="2.5"/>`,
  coin:    `<circle cx="134" cy="118" r="14" fill="#E9B44C"/><circle cx="134" cy="118" r="8" fill="none" stroke="#C48A4A" stroke-width="2.5"/>`,
  dumbbell:`<path d="M114 122 H154" stroke-width="6"/><rect x="108" y="112" width="10" height="20" rx="3" fill="#5F6570"/><rect x="150" y="112" width="10" height="20" rx="3" fill="#5F6570"/>`,
};

// Deterministic look per worker id: hair style, skin tone, accessory.
function hashStr(str) { let h = 2166136261; for (const c of String(str)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
const SKINS = ['#F3C9A8', '#E8B48F', '#C68642', '#8D5524', '#F7D9C4', '#A9713F'];
const HAIRS = ['round', 'spiky', 'side', 'bun', 'buzz', 'curly', 'long'];
const ACCS = ['none', 'glasses', 'beard', 'cap', 'headband', 'none', 'earring'];
export function lookFor(id, sprite = {}) {
  const h = hashStr(id);
  return {
    skin: sprite.skin || SKINS[h % SKINS.length],
    hairStyle: sprite.hairStyle || HAIRS[((h >>> 3) % HAIRS.length)],
    acc: sprite.acc || ACCS[((h >>> 7) % ACCS.length)],
    hair: sprite.hair || '#4A1B0C',
  };
}
function hairSvg(style, hair) {
  switch (style) {
    case 'spiky': return `<path d="M38 60 L44 30 L54 46 L62 18 L72 42 L80 12 L88 42 L98 18 L106 46 L116 30 L122 60 L110 50 Q80 36 50 50Z" fill="${hair}"/>`;
    case 'side':  return `<path d="M38 60 Q36 14 80 16 Q124 14 122 60 L112 52 Q100 30 60 40 Q46 44 38 60Z" fill="${hair}"/><path d="M36 60 Q30 80 40 96 Q44 70 48 58Z" fill="${hair}"/>`;
    case 'bun':   return `<path d="M38 60 Q36 14 80 16 Q124 14 122 60 L110 50 Q80 36 50 50Z" fill="${hair}"/><circle cx="80" cy="14" r="13" fill="${hair}"/>`;
    case 'buzz':  return `<path d="M40 56 Q40 22 80 22 Q120 22 120 56 L112 52 Q80 42 48 52Z" fill="${hair}"/>`;
    case 'curly': return `<path d="M38 60 Q36 14 80 16 Q124 14 122 60 L110 50 Q80 36 50 50Z" fill="${hair}"/>${[42, 56, 70, 84, 98, 112].map(x => `<circle cx="${x}" cy="${x === 42 || x === 112 ? 44 : 24}" r="11" fill="${hair}" stroke="#3A2A20" stroke-width="3"/>`).join('')}`;
    case 'long':  return `<path d="M38 60 Q36 14 80 16 Q124 14 122 60 L110 50 Q80 36 50 50Z" fill="${hair}"/><path d="M36 58 Q28 90 40 116 L52 110 Q44 84 48 58Z" fill="${hair}"/><path d="M124 58 Q132 90 120 116 L108 110 Q116 84 112 58Z" fill="${hair}"/>`;
    default:      return `<path d="M38 60 Q36 14 80 16 Q124 14 122 60 L110 50 Q80 36 50 50Z" fill="${hair}"/>`;
  }
}
function accSvg(acc, hair) {
  switch (acc) {
    case 'glasses':  return `<rect x="50" y="60" width="26" height="20" rx="8" fill="none" stroke-width="3.5"/><rect x="84" y="60" width="26" height="20" rx="8" fill="none" stroke-width="3.5"/><path d="M76 68 H84" stroke-width="3.5"/>`;
    case 'beard':    return `<path d="M46 80 Q50 112 80 114 Q110 112 114 80 Q100 100 80 100 Q60 100 46 80Z" fill="${hair}"/>`;
    case 'cap':      return `<path d="M36 52 Q40 20 80 20 Q120 20 124 52 Z" fill="#2F6FBF"/><path d="M30 52 H130 L134 60 H36Z" fill="#224F8A"/>`;
    case 'headband': return `<rect x="36" y="40" width="88" height="12" rx="6" fill="#E24B4A"/>`;
    case 'earring':  return `<circle cx="121" cy="86" r="4" fill="#E9B44C"/>`;
    default: return '';
  }
}

// A worker drawn in a 160×210 box, feet at y≈198. `frame` drives the animation
// (radians); `pose` is one of stand | walk | type | slump | sleep | hop.
export function character({ id = '', hair = '#4A1B0C', prop = '', state = 'idle', frame = 0, pose = 'stand', skin, hairStyle, acc }) {
  if (!/^#[0-9a-f]{3,8}$/i.test(hair)) hair = '#4A1B0C';
  const look = lookFor(id, { hair, skin, hairStyle, acc });
  const SK = look.skin;
  const c = STATE_COLORS[state] || STATE_COLORS.idle;
  const walk = pose === 'walk' || pose === 'carrywalk';
  const swing = walk ? Math.sin(frame) * 8 : 0;
  const armL = pose === 'type' ? Math.sin(frame * 2) * 6 : walk ? -swing * 1.5 : pose === 'hop' ? -40 : pose === 'water' ? -30 : pose === 'carry' ? -50 : 0;
  const armR = pose === 'type' ? -Math.sin(frame * 2) * 6 : walk ? swing * 1.5 : pose === 'hop' ? -40 : pose === 'water' ? 20 + Math.sin(frame) * 8 : pose === 'carry' ? -50 : 0;
  const bob = walk ? Math.abs(Math.sin(frame)) * 4 : pose === 'type' ? Math.sin(frame * 2) * 1.5 : pose === 'hop' ? Math.abs(Math.sin(frame)) * 26 : 0;
  const slump = pose === 'slump' ? 10 : 0;

  const eyes = pose === 'sleep'
    ? `<path d="M56 72 Q64 78 72 72" stroke-width="3"/><path d="M90 72 Q98 78 106 72" stroke-width="3"/>`
    : `<ellipse cx="64" cy="70" rx="9" ry="13" fill="#FFF"/><ellipse cx="98" cy="70" rx="9" ry="13" fill="#FFF"/>
       <ellipse cx="66" cy="72" rx="5" ry="9" fill="#2A5A48" stroke="none"/><ellipse cx="100" cy="72" rx="5" ry="9" fill="#2A5A48" stroke="none"/>
       <circle cx="67" cy="68" r="2" fill="#FFF" stroke="none"/><circle cx="101" cy="68" r="2" fill="#FFF" stroke="none"/>`;
  const mouth = pose === 'hop' ? `<ellipse cx="80" cy="92" rx="7" ry="6" fill="#993C1D"/>`
              : state === 'blocked' ? `<path d="M72 92 Q80 86 88 92"/>`
              : state === 'failed' || pose === 'slump' ? `<path d="M70 94 Q80 88 90 94"/>`
              : pose === 'sleep' ? `<ellipse cx="80" cy="92" rx="4" ry="5" fill="#993C1D"/>`
              : `<path d="M72 90 Q80 98 88 90"/>`;
  const brows = state === 'blocked' || state === 'failed'
    ? `<path d="M54 56 Q64 62 72 58" stroke-width="4"/><path d="M90 58 Q98 62 108 56" stroke-width="4"/>`
    : `<path d="M54 54 Q64 48 72 54" stroke-width="4"/><path d="M90 54 Q98 48 108 54" stroke-width="4"/>`;

  return `<g stroke="#3A2A20" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round" fill="none">
  <ellipse cx="80" cy="200" rx="${46 - bob * 0.4}" ry="8" fill="#00000018" stroke="none"/>
  <g transform="translate(0,${-bob + slump})">
    <g transform="rotate(${slump * 0.8} 80 150)">
      <path d="M50 130 Q50 104 80 104 Q110 104 110 130 L112 176 Q112 186 100 186 L60 186 Q48 186 48 176Z" fill="${c.body}"/>
      <path d="M58 150 Q80 140 102 150 L104 176 Q80 168 56 176Z" fill="${c.shade}" stroke="none"/>
      ${pose === 'sit'
        ? `<rect x="40" y="176" width="34" height="14" rx="5" fill="#6B4423"/><rect x="86" y="176" width="34" height="14" rx="5" fill="#6B4423"/>`
        : `<rect x="54" y="${184 + swing * 0.6}" width="20" height="14" rx="5" fill="#6B4423"/>
      <rect x="86" y="${184 - swing * 0.6}" width="20" height="14" rx="5" fill="#6B4423"/>`}
      <g transform="rotate(${armL} 48 140)"><path d="M48 140 L26 168" stroke-width="9"/><path d="M48 140 L26 168" stroke="${SK}" stroke-width="4"/></g>
      <g transform="rotate(${-armR} 112 140)"><path d="M112 140 L134 122" stroke-width="9"/><path d="M112 140 L134 122" stroke="${SK}" stroke-width="4"/>${Object.hasOwn(PROPS, prop) ? PROPS[prop] : ''}</g>
    </g>
    <g transform="rotate(${slump * 1.5} 80 100)">
      <circle cx="80" cy="66" r="42" fill="${SK}"/>
      ${look.acc === 'cap' ? '' : hairSvg(look.hairStyle, hair)}
      ${eyes}${brows}${mouth}
      ${accSvg(look.acc, hair)}
      <circle cx="54" cy="86" r="4" fill="#F0997B" stroke="none"/><circle cx="108" cy="86" r="4" fill="#F0997B" stroke="none"/>
    </g>
  </g>
</g>`;
}
