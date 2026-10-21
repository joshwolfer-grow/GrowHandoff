// Grow LMS training deck build, adapted from the grow-training-deck skill template.
// Style constants and helpers are unchanged from the template. Only paths and
// the slide content section differ. Builds four decks, one per step.

const pptxgen = require("pptxgenjs");
const fs = require("fs");
const path = require("path");

const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, "out");
fs.mkdirSync(OUT_DIR, { recursive: true });

// === STYLE CONSTANTS — DO NOT MODIFY ===
const BG = "06090F";
const WHITE = "FFFFFF";
const TITLE_FONT = "Archivo Black";
const BODY_FONT = "Garet";

const LOGO_PATH = path.join(__dirname, "grow_logo_white_transparent.png");
const logoB64 = "image/png;base64," + fs.readFileSync(LOGO_PATH).toString("base64");

const LOGO_X = 0.81;
const LOGO_Y = 6.57;
const LOGO_W = 1.13;
const LOGO_H = 0.19;

// Lint budget so nothing overflows the fixed boxes. Measured against the
// template: 26pt body in a 4.2in box holds about seven lines, and about 62
// characters fit on one line at 26pt across 11.8in.
const MAX_LINES = 7;
const MAX_CHARS = 52;
const MAX_TITLE = 22;
const problems = [];

function makeDeck(deckTitle) {
  const pres = new pptxgen();
  pres.layout = "LAYOUT_WIDE"; // 13.333" x 7.5" — REQUIRED, do not change
  pres.title = deckTitle;
  pres.author = "Grow";

  function addLogo(s) {
    s.addImage({ data: logoB64, x: LOGO_X, y: LOGO_Y, w: LOGO_W, h: LOGO_H });
  }

  // Big centered title slide (cover, section dividers, closing slide)
  function sectionTitleSlide(text) {
    const s = pres.addSlide();
    s.background = { color: BG };
    s.addText(text.toUpperCase(), {
      x: 0.5, y: 2.0, w: 12.333, h: 3.5,
      fontFace: TITLE_FONT,
      fontSize: 96,
      color: WHITE,
      bold: true,
      align: "center",
      valign: "middle",
      charSpacing: 1,
    });
    addLogo(s);
  }

  // Standard content slide with title + bulleted list
  // bullets: array of strings OR { text: string, subs: [string, ...] }
  function contentSlide(title, bullets) {
    // lint
    let lines = 0;
    const check = (t) => {
      lines += Math.ceil(t.length / MAX_CHARS);
      if (t.length > MAX_CHARS) problems.push(`${deckTitle} / ${title}: long line (${t.length}) "${t}"`);
      if (/[—–]|\s-\s/.test(t)) problems.push(`${deckTitle} / ${title}: dash in "${t}"`);
    };
    bullets.forEach((b) => {
      if (typeof b === "string") check(b);
      else { check(b.text); (b.subs || []).forEach(check); }
    });
    if (lines > MAX_LINES) problems.push(`${deckTitle} / ${title}: ${lines} lines, budget ${MAX_LINES}`);
    if (title.length > MAX_TITLE) problems.push(`${deckTitle}: title may wrap (${title.length}) "${title}"`);

    const s = pres.addSlide();
    s.background = { color: BG };

    s.addText(title.toUpperCase(), {
      x: 0.78, y: 0.6, w: 11.8, h: 1.3,
      fontFace: TITLE_FONT,
      fontSize: 44,
      color: WHITE,
      bold: true,
      align: "left",
      valign: "top",
      charSpacing: 8,
      margin: 0,
    });

    const items = [];
    bullets.forEach((b) => {
      if (typeof b === "string") {
        items.push({
          text: b,
          options: { bullet: { code: "25CF" }, indentLevel: 0, breakLine: true },
        });
      } else {
        items.push({
          text: b.text,
          options: { bullet: { code: "25CF" }, indentLevel: 0, breakLine: true },
        });
        (b.subs || []).forEach((sub) => {
          items.push({
            text: sub,
            options: { bullet: { code: "25CB" }, indentLevel: 1, breakLine: true },
          });
        });
      }
    });
    if (items.length) items[items.length - 1].options.breakLine = false;

    s.addText(items, {
      x: 0.78, y: 2.1, w: 11.8, h: 4.2,
      fontFace: BODY_FONT,
      fontSize: 26,
      color: WHITE,
      align: "left",
      valign: "top",
      paraSpaceAfter: 10,
    });

    addLogo(s);
  }

  return { pres, sectionTitleSlide, contentSlide };
}

// === END STYLE CONSTANTS ===

// Shared closing slides, same on every deck in the series.
function closeOut(d) {
  d.contentSlide("Education only", [
    "Not financial, tax, investment, or legal advice",
    "No account, fund, or property is recommended",
    "Every number is illustrative and 8% is not a promise",
    "Talk to your own CPA, lender, and advisor first",
  ]);
  d.sectionTitleSlide("Grow Marketing");
}

// ============================================================
// SLIDE CONTENT — EDIT BELOW THIS LINE
// One deck covering the whole money guide (money.html, Oct 15 2026 version).
// ============================================================

const DECKS = [];

DECKS.push(["Money After Commission", (d) => {
  d.sectionTitleSlide("Money After Commission");

  d.contentSlide("Overview", [
    "Setting aside tax",
    "S Corp, when and how",
    "Tracking expenses",
    "Emergency fund",
    "Investing",
    "Real estate",
    "What comes next",
  ]);

  d.contentSlide("Setting aside tax", [
    "Nothing is withheld from a 1099 check",
    "Income tax plus 15.3% self employment tax",
    "The bill comes once a year, in April",
    "Move 25% to 35% of every check the day it lands",
    "Separate savings account, different bank",
    "Pay April out of it, your CPA sets the percentage",
  ]);

  d.contentSlide("S Corp: when", [
    "Profit splits into salary and distributions",
    "Salary pays the 15.3%, distributions do not",
    "The saving grows with your profit",
    "Flat fee, $600 once then about $1,000 a year",
    "Past a certain profit the saving beats the fee",
    "File Form 2553 by March 15, not after",
  ]);

  d.contentSlide("The line", [
    "$40,000 net: behind",
    "$50,000 net: a few hundred ahead",
    "$60,000 net: about $1,500 ahead",
    "$80,000 net: about $3,000 ahead",
    "$150,000 net: about $8,300 ahead",
    "The line: about $60,000 net profit, after expenses",
    "About 8 to 9 deals a week for a full year",
  ]);

  d.contentSlide("S Corp: how it works", [
    "A tax election on an LLC, not a new company",
    "You become an employee of your own business",
    "Set a reasonable salary with your CPA",
    "Run real payroll, a low salary gets audited",
    "Deductions also lower what a lender counts",
    "Buying a house soon, tell your CPA before filing",
  ]);

  d.contentSlide("S Corp: setting it up", [
    "Form an LLC in your state",
    "Get an EIN from the IRS, free",
    "File Form 2553",
    "Set the salary with your CPA",
    "Run payroll through a payroll service",
    "Separate business bank account, nothing personal",
    "The S Corp files its own return each year",
  ]);

  d.contentSlide("Tracking expenses", [
    "A deduction only counts if you can show it",
    "One business bank account and one business card",
    "Nothing personal goes through them",
    "Log mileage with an app, photo every receipt",
    "Fifteen minutes a month to match the statement",
    "Mileage, phone, gear, software, travel, meals",
  ]);

  d.contentSlide("Emergency fund", [
    "Commission is uneven, the bills are not",
    "Three to six months of expenses, its own account",
    "Not the tax account, not checking",
    "A card at 18% or more gets paid off first",
    "Fund it once and leave it alone",
    "Refill it first after you use it",
  ]);

  d.contentSlide("Investing", [
    "After tax, the fund, and any card debt",
    "Retirement accounts first, Solo 401(k) or SEP IRA",
    "Then a regular brokerage account",
    "Broad, low cost index funds, automatic transfer",
    "Hold through slow quarters, raise after strong ones",
    "Stock picks off social media lose reps money",
  ]);

  d.contentSlide("Real estate", [
    "Property comes after the base exists",
    "Cash flow, appreciation, paydown, tax, leverage",
    "House hacking: live in one unit, rent the rest",
    "BRRRR: buy, rehab, rent, refinance, repeat",
    "Lenders read two years of filed returns",
    "Base first, reserves separate from the down payment",
  ]);

  d.contentSlide("What comes next", [
    "Once the base runs itself, the rest is yours",
    "A business, a bigger property, a partnership",
    "Fund it from surplus only",
    "Decide the share in advance",
    "Write down why",
    "The quiz shows how you handle money",
    "growsales.vercel.app/quiz.html",
  ]);

  d.contentSlide("Summary", [
    "25% to 35% of every check to a tax account",
    "S Corp past $60,000 net, Form 2553 by March 15",
    "Business account and card, mileage log, receipts",
    "Three to six months saved before anything else",
    "Index funds on an automatic transfer",
    "growsales.vercel.app for the calculator and quiz",
  ]);

  closeOut(d);
}]);

// ============================================================
// END SLIDE CONTENT
// ============================================================

(async () => {
  for (const [name, fill] of DECKS) {
    const d = makeDeck(name);
    fill(d);
    const f = await d.pres.writeFile({ fileName: path.join(OUT_DIR, name + ".pptx") });
    console.log("Wrote:", f);
  }
  if (problems.length) {
    console.log("\nLINT:");
    problems.forEach((p) => console.log("  " + p));
    process.exitCode = 2;
  } else {
    console.log("\nLint clean.");
  }
})();
