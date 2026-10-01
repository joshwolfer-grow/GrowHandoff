// Grow LMS training deck template
// EDIT ONLY THE SLIDE CONTENT SECTION AT THE BOTTOM.
// Do not change canvas size, colors, fonts, helper functions, or coordinates.

const pptxgen = require("pptxgenjs");
const fs = require("fs");

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.333" x 7.5" — REQUIRED, do not change
pres.title = "Grow Training";
pres.author = "Grow";

// === STYLE CONSTANTS — DO NOT MODIFY ===
const BG = "06090F";
const WHITE = "FFFFFF";
const TITLE_FONT = "Archivo Black";
const BODY_FONT = "Garet";

const LOGO_PATH = "/home/claude/grow_logo_white_transparent.png";
const logoB64 = "image/png;base64," + fs.readFileSync(LOGO_PATH).toString("base64");

const LOGO_X = 0.81;
const LOGO_Y = 6.57;
const LOGO_W = 1.13;
const LOGO_H = 0.19;

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

// === END STYLE CONSTANTS ===

// ============================================================
// SLIDE CONTENT — EDIT BELOW THIS LINE
// ============================================================

// Cover
sectionTitleSlide("Your Deck Title Here");

// Overview slide listing what the deck covers
contentSlide("Overview", [
  "Topic one",
  "Topic two",
  "Topic three",
]);

// Content slides
contentSlide("First Topic", [
  { text: "Main point with a supporting detail", subs: [
    "Supporting sub-point",
  ]},
  "Plain bullet without sub-points",
  "Another plain bullet",
]);

// Summary
contentSlide("Summary", [
  "Key takeaway one",
  "Key takeaway two",
  "Key takeaway three",
]);

// Closing slide
sectionTitleSlide("Grow Marketing");

// ============================================================
// END SLIDE CONTENT
// ============================================================

const OUTPUT_NAME = "Training_Deck.pptx";
pres.writeFile({ fileName: "/home/claude/" + OUTPUT_NAME }).then((f) => {
  console.log("Wrote:", f);
});
