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
const MAX_CHARS = 62;
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
    "Nothing here is financial, tax, investment, or legal advice",
    "Grow does not recommend any account, fund, entity, or property",
    "Every number is illustrative and 8% is not a promise",
    "Talk to your own CPA, lender, and licensed advisor first",
  ]);
  d.sectionTitleSlide("Grow Marketing");
}

// ============================================================
// SLIDE CONTENT — EDIT BELOW THIS LINE
// ============================================================

const DECKS = [];

// ---------- 01 COVER YOUR BASES ----------
DECKS.push(["01 Cover Your Bases", (d) => {
  d.sectionTitleSlide("Cover Your Bases");

  d.contentSlide("Overview", [
    "The 30 days after the check",
    "A separate account for tax money",
    "High interest debt to zero",
    "Three to six months saved",
    "The trap specific to this job",
  ]);

  d.contentSlide("After the check", [
    "Two reps sell the same deals for four years",
    "They finish in completely different places",
    "The gap opens in the 30 days after each check lands",
    "Three things, in this order",
    "Skipping ahead is how the money disappears",
  ]);

  d.contentSlide("Tax money", [
    "You are on a 1099 and nobody withholds anything",
    "The day a check lands, a fixed percent moves out",
    "Into a savings account you never touch",
    "25% to 35% is where reps commonly land",
    "Your CPA sets the real number",
    "Setting it high is the safe error",
  ]);

  d.contentSlide("Kill the debt", [
    "Paying off a card at 19% is a guaranteed 19% return",
    "Nothing else in this course is guaranteed",
    "Minimums on everything, every extra dollar at one target",
    "When it clears, that payment rolls to the next one",
    "Not into your lifestyle",
  ]);

  d.contentSlide("Three to six months", [
    "January does not look like July",
    "Reps who can cover a slow stretch make different calls",
    "Those calls are worth real money",
    "Fund it once, then leave it alone",
  ]);

  d.contentSlide("The trap", [
    "A big month covers a payment you could not afford",
    "So you take on the payment",
    "Truck, watch, boat, second truck",
    "Fixed obligations bought with variable money",
    "The obligation stays when the month does not repeat",
  ]);

  d.contentSlide("Summary", [
    "Tax account first, 25% to 35% off every check",
    "High interest debt to zero",
    "Three to six months of expenses saved",
    "In that order, before anything else",
    "Never buy fixed payments with variable money",
  ]);

  closeOut(d);
}]);

// ---------- 02 STRUCTURE IT ----------
DECKS.push(["02 Structure It", (d) => {
  d.sectionTitleSlide("Structure It");

  d.contentSlide("Overview", [
    "You are a business already",
    "Shoot for $60,000 net profit",
    "Why that number",
    "The deadline",
    "How to set it up",
    "Grow already has a tax guy",
    "The lender trap",
  ]);

  d.contentSlide("You are a business", [
    "Whether you filed anything or not",
    "At some income, being an S Corp saves real money",
    "Below that income, it costs more than it saves",
    "This deck tells you where the line is",
  ]);

  d.contentSlide("Shoot for this", [
    "$60,000 net profit",
    "Net profit is what is left after business expenses",
    "Not what you grossed",
    "Around $60K the savings clearly beat the overhead",
    "By $80K it is not a close call",
    "Below $45K it is usually a losing trade",
  ]);

  d.contentSlide("In deals", [
    "8 to 9 deals a week",
    "Every week, for a full year",
    "At a $230 commission and an 80% install rate",
    "That is the bar",
  ]);

  d.contentSlide("Why $60,000", [
    "Sole proprietor: every dollar of net profit gets SE tax",
    "Self employment tax is about 15.3%",
    "S Corp: salary still gets it, distributions do not",
    "You save roughly 15.3% of the distribution half",
    "You pay for a payroll service and a second return",
    "Around $60K, what you save clearly beats what you pay",
  ]);

  d.contentSlide("At each income", [
    "$40,000 net: about $1,800 saved, overhead eats it",
    "$50,000 net: about $2,300 saved, a few hundred ahead",
    "$60,000 net: about $3,100 saved, roughly $1,500 ahead",
    "$80,000 net: about $4,600 saved, roughly $3,000 ahead",
    "$150,000 net: about $9,900 saved, roughly $8,300 ahead",
  ]);

  d.contentSlide("The deadline", [
    "Form 2553 is the actual election",
    "Due about two and a half months into the tax year",
    "March 15 for a calendar year",
    "You cannot go back and fix a big year after it closes",
    "Decide in January, file by March 15",
  ]);

  d.contentSlide("How to set it up", [
    { text: "Form an LLC in your state", subs: [
      "The legal container, not the tax election",
    ]},
    { text: "Get an EIN from the IRS", subs: [
      "Free, online, minutes. Never pay for this",
    ]},
    { text: "File Form 2553", subs: [
      "The step people forget",
    ]},
  ]);

  d.contentSlide("Then keep it clean", [
    { text: "Set your salary with a CPA, then run real payroll", subs: [
      "Write down how you got the number and keep it",
      "An S Corp paying no salary is one of the most audited things",
    ]},
    "Separate bank account, no personal spending from it",
    { text: "The S Corp files its own return every year", subs: [
      "That is the ongoing cost, and why the threshold exists",
    ]},
  ]);

  d.contentSlide("You have a tax guy", [
    "Grow already works with one who handles this for reps",
    "About $600 to set the S Corp up",
    "About $1,000 a year after that",
    "Ask your manager for the intro",
  ]);

  d.contentSlide("The lender trap", [
    "Deductions lower your tax bill",
    "They also lower the income a lender will count",
    "Lenders read your returns, not your commission statements",
    "Optimize hard in years one and two, no house in year three",
    "Talk to your CPA before you file, not after",
  ]);

  d.contentSlide("Summary", [
    "$60,000 net profit is where the S Corp pays",
    "8 to 9 deals a week for a full year",
    "File Form 2553 by March 15",
    "LLC, EIN, election, salary, payroll, separate account",
    "Grow has a tax guy, ask your manager",
    "Deductions and mortgages fight each other",
  ]);

  closeOut(d);
}]);

// ---------- 03 INVEST IT ----------
DECKS.push(["03 Invest It", (d) => {
  d.sectionTitleSlide("Invest It");

  d.contentSlide("Overview", [
    "The boring part",
    "The order",
    "Spread beats picking",
    "Automate it",
    "Where reps lose money early",
  ]);

  d.contentSlide("The boring part", [
    "Usually the biggest number at the end",
    "No tenants, no repairs, no closing costs",
    "You can start this month",
    "With whatever is left after the first two steps",
  ]);

  d.contentSlide("The order", [
    "Tax money moving out automatically",
    "High interest debt cleared",
    "Three to six months saved",
    { text: "Tax advantaged retirement accounts", subs: [
      "Self employed options have high limits, your CPA picks",
    ]},
    { text: "Taxable brokerage, automated", subs: [
      "No contribution limit, fully liquid, runs without you",
    ]},
  ]);

  d.contentSlide("Spread beats picking", [
    "A broad low cost index fund holds thousands of companies",
    "No single company can take you down",
    "Fees compound against you like returns compound for you",
    "Over 40 years the cost of a fund matters more than you think",
  ]);

  d.contentSlide("Automate it", [
    "Set the transfer for the day after commissions hit",
    "A plan on motivation loses to a plan on a calendar",
    "Set the amount where you can hold it through a slow quarter",
    "Raise it after a good one, not before",
  ]);

  d.contentSlide("Where reps lose money", [
    "Individual stocks picked off social media",
    "Leveraged products that promise years in months",
    "Both get marketed hardest to people who just started earning",
    "If you have to watch it during the day, it is a second job",
  ]);

  d.contentSlide("Summary", [
    "Bases first, then retirement accounts, then brokerage",
    "Broad low cost index funds, not stock picks",
    "Automate the transfer, raise it after good quarters",
    "If you have to watch it, it is a second job",
  ]);

  closeOut(d);
}]);

// ---------- 04 GROW IT ----------
DECKS.push(["04 Grow It", (d) => {
  d.sectionTitleSlide("Grow It");

  d.contentSlide("Overview", [
    "Property comes last for a reason",
    "House hacking",
    "BRRRR",
    "Before you buy",
    "Your four year plan",
  ]);

  d.contentSlide("Property comes last", [
    "The thing reps ask about first",
    "The one with the most ways to get hurt",
    "Almost all trace back to skipping the first three steps",
    "Two structures worth knowing by name",
  ]);

  d.contentSlide("House hacking", [
    "Buy a 2 to 4 unit property",
    "Live in one unit, rent the others",
    { text: "You qualify for owner occupied financing", subs: [
      "Far smaller down payment than an investment property",
    ]},
    "The other units cover some or all of your housing",
    "The most forgiving first purchase in your twenties",
  ]);

  d.contentSlide("BRRRR", [
    "Buy, rehab, rent, refinance, repeat",
    "Buy something underpriced because it needs work",
    "Fix it, rent it, refinance on the new value",
    "Pull your cash back out and do it again",
    "Needs accurate renovation numbers and real reserves",
    "And a lender lined up before you start",
  ]);

  d.contentSlide("Before you buy", [
    "Structure set up and books clean",
    "Tax money moving out automatically",
    "High interest debt at zero",
    "Reserves funded, kept separate from the down payment",
    { text: "A property bought before those four exist", subs: [
      "Turns a slow season into a forced sale",
    ]},
  ]);

  d.contentSlide("Your four year plan", [
    "One question decides most of this",
    "Not what you earn",
    "How much leaves your account before you can spend it",
    "$1,500 a month for four years is $72,000 in",
    "Left alone at 8% from age 23, about $1.57M at 65",
    "Every dollar you put in becomes about 22 dollars",
  ]);

  d.contentSlide("Summary", [
    "Property only after the first three steps",
    "House hack first, it is the most forgiving",
    "BRRRR works, and every part is harder than the whiteboard",
    "Four things funded before you buy anything",
    "What matters is what leaves before you can spend it",
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
