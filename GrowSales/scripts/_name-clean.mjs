// scripts/_name-clean.mjs
// Shared name normalization for the team-roster parsers (Master sheet + weekly
// paste). Both must clean names identically or the same person would key
// differently between historical and current-week data. Strips the blitz-sheet
// shorthand — (c)/(k)/(s) role tags, (Mon-Sun) day ranges, ($5 per install),
// trailing deal counts, LT/BNB/route markers — fixes known misspellings, then
// runs the canonical alias map (Samantha Boyd -> Sammi Boyd, etc.).

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { canonicalDisplayName } = require('../api/_name-aliases.js');

// One-off misspellings seen in the source sheets -> canonical spelling. Keyed on
// the cleaned lowercase "first last". Extend as the validation report surfaces more.
export const SPELLING = {
  'syndey turner': 'Sydney Turner',
  'chris lagrange': 'Chris Legrange',
  'christopher lagrange': 'Chris Legrange',
  'chris legrange': 'Chris Legrange',
  'macee mofatt': 'Macee Moffat',
  'calvin astil': 'Calvin Astill',
  'samuel hossfi': 'Samuel Hossfield',
  'ethan hendrickson': 'Ethan Hendriksen',
  'gaberiel robbins': 'Gabriel Robbins',
  'raihan steed': 'Raihan Steed',
  'krispy rebollar': 'Krispy Rebollar',
  'spencer schwieger': 'Spencer Schweiger',
  'ali ai ghazzawi': 'Ali Al Ghazzawi',
};

export function cleanName(raw) {
  let s = String(raw || '');
  s = s.replace(/\([^)]*\)/g, ' ');       // (c) (k) (Mon-Sun) ($5 per install) ...
  s = s.replace(/\([^)]*$/g, ' ');        // stray unbalanced "(...."
  s = s.replace(/\$\S*/g, ' ');
  const DOW = '(?:sun|mon|tues?|wed|thur?s?|fri|sat)';
  s = s.replace(new RegExp(`\\b${DOW}\\s*[-–]\\s*${DOW}\\b`, 'gi'), ' ');
  s = s.replace(new RegExp(`\\b${DOW}\\b`, 'gi'), ' ');
  s = s.replace(/[0-9]+/g, ' ');          // trailing deal counts / "1","21","3"
  s = s.replace(/\b(LT|BNB|IN\s*MARKET|INMARKET|remotely|good|car)\b/gi, ' ');
  s = s.replace(/[-–|].*$/, ' ');         // any trailing " - note" / " | team"
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/(?:\s+[A-Z])+$/, '').trim();   // trailing single-letter grade/route markers
  if (!s) return '';
  const key = s.toLowerCase();
  if (SPELLING[key]) s = SPELLING[key];
  // light title-case: fix all-lowercase tokens, leave interior caps (TJ, JaQuan)
  s = s.split(' ').map(w => (w && w === w.toLowerCase()) ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
  return canonicalDisplayName(s);
}
