// Fake email screen for recruit signups. Free checks only, no paid lookup:
//
//   1. Format       anything that cannot be an address at all
//   2. Made up      none@, test@, asdf@ style placeholders people type to get past a form
//   3. Typo         gmial.com, yahoo.con: a real person, fixable, so we name the fix
//   4. Throwaway    mailinator and friends
//   5. Mail server  the domain has no MX (and no A to fall back on), so nothing can land there
//
// Returns a short label for the board, or null when nothing looks wrong. It
// FLAGS, never rejects: the applicant still gave us a phone number, and a typo'd
// email is still a real person worth a call.
//
// What this cannot catch: a well formed inbox that simply does not exist at a
// real provider (asdkjh@gmail.com). Only a confirmation send proves that.

import { promises as dns } from 'dns';

const TYPO = {
  'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmal.com': 'gmail.com', 'gamil.com': 'gmail.com',
  'gnail.com': 'gmail.com', 'gmaill.com': 'gmail.com', 'gmail.co': 'gmail.com', 'gmail.con': 'gmail.com',
  'gmail.cm': 'gmail.com', 'gmail.om': 'gmail.com', 'gmail.cmo': 'gmail.com', 'gmail.comm': 'gmail.com',
  'gmail.net': 'gmail.com', 'gmali.com': 'gmail.com', 'gmeil.com': 'gmail.com', 'g.mail.com': 'gmail.com',
  'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'yahoo.co': 'yahoo.com', 'yahoo.con': 'yahoo.com',
  'yhoo.com': 'yahoo.com', 'yahho.com': 'yahoo.com', 'tahoo.com': 'yahoo.com',
  'hotmal.com': 'hotmail.com', 'hotmial.com': 'hotmail.com', 'hotmai.com': 'hotmail.com', 'hotmail.co': 'hotmail.com',
  'hotmail.con': 'hotmail.com', 'hotamil.com': 'hotmail.com', 'homail.com': 'hotmail.com',
  'outlok.com': 'outlook.com', 'outloo.com': 'outlook.com', 'outlook.co': 'outlook.com', 'outlook.con': 'outlook.com',
  'icloud.co': 'icloud.com', 'icloud.con': 'icloud.com', 'iclod.com': 'icloud.com', 'icoud.com': 'icloud.com',
  'iclould.com': 'icloud.com', 'icluod.com': 'icloud.com',
  'aol.co': 'aol.com', 'aol.con': 'aol.com'
};

// The common burner services. Not exhaustive on purpose: the long public lists
// run to 100k+ domains and churn daily, and the MX check already catches the
// dead ones. These are the live ones people actually reach for.
const THROWAWAY = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'sharklasers.com',
  'grr.la', 'guerrillamailblock.com', '10minutemail.com', '10minutemail.net', 'tempmail.com', 'temp-mail.org',
  'temp-mail.io', 'tempmail.net', 'tempmailo.com', 'tempail.com', 'tempr.email', 'throwawaymail.com',
  'yopmail.com', 'yopmail.net', 'yopmail.fr', 'getnada.com', 'nada.email', 'dispostable.com',
  'trashmail.com', 'trashmail.net', 'trashmail.de', 'maildrop.cc', 'mailnesia.com', 'mintemail.com',
  'mohmal.com', 'emailondeck.com', 'fakeinbox.com', 'fakemail.net', 'mailcatch.com', 'spamgourmet.com',
  'spambox.us', 'mytemp.email', 'burnermail.io', 'mail.tm', 'mail.gw', 'emailfake.com', 'email-fake.com',
  'tempinbox.com', 'discard.email', 'discardmail.com', 'moakt.com', 'inboxkitten.com', 'mailpoof.com',
  'getairmail.com', 'harakirimail.com', 'mvrht.net', 'byom.de', 'linshiyouxiang.net', '33mail.com',
  'mailsac.com', 'spam4.me', 'incognitomail.org', 'anonbox.net', 'jetable.org', 'mailexpire.com',
  'tmail.ws', 'tmpmail.org', 'tmpmail.net', 'cuvox.de', 'armyspy.com', 'dayrep.com', 'einrot.com',
  'fleckens.hu', 'gustr.com', 'jourrapide.com', 'rhyta.com', 'superrito.com', 'teleworm.us'
]);

// Placeholder domains nobody actually receives mail at.
const FAKE_DOMAIN = new Set([
  'example.com', 'example.org', 'example.net', 'test.com', 'email.com', 'mail.com.com', 'none.com',
  'noemail.com', 'nomail.com', 'no.com', 'na.com', 'fake.com', 'asdf.com', 'abc.com', 'xyz.com'
]);

// Local parts that are a shrug, not a name.
const FAKE_LOCAL = /^(none|noemail|nomail|no|na|n\/a|null|nil|test|testing|tester|fake|asdf+|qwert[y]?|abc|abc123|123|1234|12345|123456|aaa+|xxx+|x|a|email|myemail|youremail|noreply|no-reply|donotreply|idk|nope|dont|dontknow|nothing)$/;

const FORMAT = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })), ms))]);
}

// true = can receive mail, false = definitely cannot, null = could not tell.
// A DNS hiccup must never flag a real applicant, so anything other than a
// clean "no such domain / no records" answer comes back null.
async function canReceive(domain) {
  const dead = (e) => e && (e.code === 'ENOTFOUND' || e.code === 'ENODATA');
  try {
    const mx = await withTimeout(dns.resolveMx(domain), 3000);
    if (mx && mx.length) return !(mx.length === 1 && (mx[0].exchange === '' || mx[0].exchange === '.')); // null MX, RFC 7505
  } catch (e) {
    if (!dead(e)) return null;
  }
  // No MX: mail falls back to the domain's A record (RFC 5321 §5.1).
  try {
    const a = await withTimeout(dns.resolve4(domain), 3000);
    return a && a.length ? true : false;
  } catch (e) {
    return dead(e) ? false : null;
  }
}

export async function checkEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (!email) return null;
  if (!FORMAT.test(email)) return 'Not a valid address';
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at), domain = email.slice(at + 1);
  if (FAKE_DOMAIN.has(domain) || FAKE_LOCAL.test(local)) return 'Looks made up';
  if (TYPO[domain]) return 'Typo? Probably ' + local + '@' + TYPO[domain];
  if (THROWAWAY.has(domain)) return 'Throwaway address';
  const ok = await canReceive(domain);
  if (ok === false) return 'Domain cannot receive mail';
  return null;
}
