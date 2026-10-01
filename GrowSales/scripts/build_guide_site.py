#!/usr/bin/env python3
"""Build the ISP field guide web page from the extracted Canva guide text.

Source of truth is Canva. This regenerates the rep-facing page from the text
files in data/guide-text/, so rerun it whenever the guides change.

    python3 scripts/build_guide_site.py

Writes data/isp-field-guide.html
"""
import html
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "guide-text")
OUT = os.path.join(ROOT, "data", "isp-field-guide.html")

# Display order: biggest rep headcount first, so the common ones are nearest the top.
GUIDES = [
    ("lyte.txt", "Lyte", "Texas", "Baytown, Coastal Bend, Beeville, Sinton, Kingsville, Marshall, Uvalde"),
    ("i3.txt", "i3 Broadband", "Illinois", "Peoria, Huntley, Mundelein, Lake Villa, Vernon Hills, Lake Zurich"),
    ("slic.txt", "SLIC", "Upstate New York", "Massena, Potsdam, Glens Falls, Waterford, Ballston Spa, Hudson Falls, Lake George"),
    ("chicago-ezee.txt", "Ezee (Chicago)", "Illinois", "Streamwood, Downers Grove, Naperville, Roselle, Bartlett"),
    ("bluepeak.txt", "BluePeak", "Oklahoma", "Yukon, Enid, Shawnee, Lawton, Midwest City, Muskogee"),
    ("tds.txt", "TDS", "Wisconsin", "Madison, Middleton, Verona"),
    ("omni.txt", "Omni", "Pennsylvania and Ohio", "Connellsville, Uniontown, Toledo"),
    ("gfiber.txt", "GFiber", "Texas and Missouri", "Austin, Kansas City, Lenexa"),
    ("cityside.txt", "Cityside", "California", "Irvine, Laguna Hills, Lake Forest"),
    ("glo.txt", "Glo", "Pennsylvania", "Hanover, Carlisle"),
]

# Phrases that mean "a rep must not hand this to a customer" or "do not say this".
FLAGS = [
    "never give", "not customers", "only you", "rep only", "reps only",
    "under no circumstance", "do not give", "never be given", "do not use the words",
    "avoid using phrases", "please avoid", "do not text anyone",
]

FAQ_TITLES = {"common questions", "frequently asked questions"}

PHONE = re.compile(r"(?<![\d/-])(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)")
EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")
URL = re.compile(r"https?://[^\s,)\"]+")


def slug(*parts):
    s = "-".join(parts).lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s


def parse(path):
    """Return (title, [(heading, [block, ...]), ...]) where a block is a list of lines."""
    with open(path, encoding="utf-8") as fh:
        raw = fh.read()
    title = ""
    sections = []
    cur_head, cur_lines = None, []
    for line in raw.splitlines():
        if line.startswith("# ") and not line.startswith("## "):
            title = line[2:].strip()
            continue
        if line.startswith("## "):
            if cur_head is not None:
                sections.append((cur_head, cur_lines))
            cur_head, cur_lines = line[3:].strip(), []
            continue
        if cur_head is not None:
            cur_lines.append(line)
    if cur_head is not None:
        sections.append((cur_head, cur_lines))
    # drop sections that ended up with no real content
    sections = [(h, l) for h, l in sections if h]
    return title, sections


def linkify(text):
    """Escape, then turn phone numbers, emails and URLs into tappable links."""
    out = html.escape(text)
    out = URL.sub(lambda m: f'<a href="{m.group(0)}" rel="noopener">{m.group(0)}</a>', out)
    out = EMAIL.sub(lambda m: f'<a href="mailto:{m.group(0)}">{m.group(0)}</a>', out)

    def phone_sub(m):
        raw = m.group(0)
        digits = re.sub(r"\D", "", raw)
        if len(digits) < 10:
            return raw
        return f'<a class="tel" href="tel:+{digits if digits.startswith("1") else "1" + digits}">{raw}</a>'

    return PHONE.sub(phone_sub, out)


def is_flagged(line):
    low = line.lower()
    return any(f in low for f in FLAGS)


def render_blocks(lines, is_faq):
    """Group consecutive lines into paragraphs, lists, Q/A pairs and callouts."""
    parts = []
    buf = []

    def flush():
        if not buf:
            return
        text = " ".join(x.strip() for x in buf if x.strip())
        if text:
            cls = ' class="flag"' if is_flagged(text) else ""
            parts.append(f"<p{cls}>{linkify(text)}</p>")
        buf.clear()

    i = 0
    while i < len(lines):
        line = lines[i].rstrip()
        if not line.strip():
            flush()
            i += 1
            continue
        if line.lstrip().startswith("- "):
            flush()
            items = []
            while i < len(lines) and lines[i].lstrip().startswith("- "):
                items.append(lines[i].lstrip()[2:].strip())
                i += 1
            # In an FAQ section a lone dash line is the answer to the question above it.
            if is_faq and parts and parts[-1].startswith("<p") and len(items) == 1:
                q = parts.pop()
                q = q[q.index(">") + 1: q.rindex("</p>")]
                parts.append(
                    f'<div class="qa"><p class="q">{q}</p>'
                    f'<p class="a">{linkify(items[0])}</p></div>'
                )
            else:
                lis = "".join(f"<li>{linkify(x)}</li>" for x in items)
                parts.append(f"<ul>{lis}</ul>")
            continue
        buf.append(line)
        i += 1
    flush()
    return "\n".join(parts)


def build():
    guides = []
    for fname, name, state, markets in GUIDES:
        path = os.path.join(SRC, fname)
        if not os.path.exists(path):
            continue
        title, sections = parse(path)
        gid = slug(name)
        guides.append({
            "id": gid, "name": name, "state": state, "markets": markets,
            "title": title, "sections": sections,
        })

    # ---------- table of contents ----------
    toc = []
    for g in guides:
        links = "".join(
            f'<li><a href="#{slug(g["id"], h)}">{html.escape(h)}</a></li>'
            for h, _ in g["sections"]
        )
        toc.append(
            f'<section class="toc-group" data-guide="{g["id"]}">'
            f'<h3><a href="#{g["id"]}">{html.escape(g["name"])}</a>'
            f'<span class="count">{len(g["sections"])}</span></h3>'
            f'<ul class="toc-list">{links}</ul></section>'
        )

    # ---------- guide bodies ----------
    bodies = []
    for g in guides:
        secs = []
        for h, lines in g["sections"]:
            sid = slug(g["id"], h)
            is_faq = h.strip().lower() in FAQ_TITLES
            body = render_blocks(lines, is_faq)
            if not body.strip():
                continue
            secs.append(
                f'<section class="sec{" faq" if is_faq else ""}" id="{sid}" '
                f'data-title="{html.escape(h.lower())}">'
                f'<h3><a class="anchor" href="#{sid}" aria-label="Link to this section">#</a>'
                f'{html.escape(h)}</h3>{body}</section>'
            )
        bodies.append(
            f'<article class="guide" id="{g["id"]}" data-name="{html.escape(g["name"].lower())}">'
            f'<header class="guide-head">'
            f'<p class="eyebrow">{html.escape(g["state"])}</p>'
            f'<h2>{html.escape(g["name"])}</h2>'
            f'<p class="markets">{html.escape(g["markets"])}</p>'
            f'</header>{"".join(secs)}</article>'
        )

    switcher = "".join(
        f'<a class="chip" href="#{g["id"]}">{html.escape(g["name"])}</a>' for g in guides
    )

    total_sections = sum(len(g["sections"]) for g in guides)

    page = TEMPLATE
    for token, value in (
        ("__SWITCHER__", switcher),
        ("__TOC__", "".join(toc)),
        ("__BODIES__", "".join(bodies)),
        ("__NGUIDES__", str(len(guides))),
        ("__NSECTIONS__", str(total_sections)),
    ):
        page = page.replace(token, value)
    return page


TEMPLATE = """<title>ISP Field Guide</title>
<style>
:root{
  --bg:#F7F6F3; --surface:#FFFFFF; --ink:#14181B; --ink-2:#5B6269;
  --line:#E4E0D9; --accent:#D9531E; --accent-soft:#FBEDE6;
  --warn:#A8321F; --warn-soft:#FBEAE6;
  --radius:3px;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0F1417; --surface:#161D21; --ink:#E9EAE7; --ink-2:#98A1A7;
    --line:#242D33; --accent:#FF7A45; --accent-soft:#2A1A12;
    --warn:#FF8A73; --warn-soft:#2E1712;
  }
}
:root[data-theme="dark"]{
  --bg:#0F1417; --surface:#161D21; --ink:#E9EAE7; --ink-2:#98A1A7;
  --line:#242D33; --accent:#FF7A45; --accent-soft:#2A1A12;
  --warn:#FF8A73; --warn-soft:#2E1712;
}
:root[data-theme="light"]{
  --bg:#F7F6F3; --surface:#FFFFFF; --ink:#14181B; --ink-2:#5B6269;
  --line:#E4E0D9; --accent:#D9531E; --accent-soft:#FBEDE6;
  --warn:#A8321F; --warn-soft:#FBEAE6;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);
  font-size:17px;line-height:1.62;-webkit-text-size-adjust:100%}
a{color:var(--accent);text-decoration-thickness:1px;text-underline-offset:2px}
a:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}

.bar{position:sticky;top:0;z-index:20;background:var(--bg);
  border-bottom:1px solid var(--line);padding:.7rem 1.1rem .6rem}
.bar-inner{max-width:1180px;margin:0 auto}
.brand{display:flex;align-items:baseline;gap:.6rem;flex-wrap:wrap}
.brand h1{font-size:1.02rem;margin:0;letter-spacing:-.01em}
.brand .meta{font-family:var(--mono);font-size:.7rem;color:var(--ink-2);
  text-transform:uppercase;letter-spacing:.1em}
.tools{display:flex;gap:.5rem;margin-top:.55rem}
#q{flex:1;min-width:0;font:inherit;font-size:.92rem;padding:.5rem .7rem;
  color:var(--ink);background:var(--surface);
  border:1px solid var(--line);border-radius:var(--radius)}
#q::placeholder{color:var(--ink-2)}
.theme{font-family:var(--mono);font-size:.7rem;letter-spacing:.08em;
  text-transform:uppercase;background:var(--surface);color:var(--ink-2);
  border:1px solid var(--line);border-radius:var(--radius);padding:0 .7rem;cursor:pointer}
.chips{display:flex;gap:.4rem;overflow-x:auto;margin-top:.55rem;
  padding-bottom:.15rem;scrollbar-width:none}
.chips::-webkit-scrollbar{display:none}
.chip{flex:0 0 auto;font-family:var(--mono);font-size:.72rem;letter-spacing:.04em;
  padding:.3rem .6rem;border:1px solid var(--line);border-radius:var(--radius);
  background:var(--surface);color:var(--ink-2);text-decoration:none;white-space:nowrap}
.chip:hover{border-color:var(--accent);color:var(--accent)}

.wrap{max-width:1180px;margin:0 auto;padding:1.4rem 1.1rem 5rem;
  display:grid;gap:2.2rem;grid-template-columns:1fr}
@media (min-width:1024px){
  .wrap{grid-template-columns:260px minmax(0,1fr);gap:3rem;align-items:start}
  .toc{position:sticky;top:7.2rem;max-height:calc(100vh - 9rem);overflow-y:auto}
}
.toc h2{font-family:var(--mono);font-size:.7rem;text-transform:uppercase;
  letter-spacing:.12em;color:var(--ink-2);margin:0 0 .8rem}
.toc-group{margin-bottom:1.1rem}
.toc-group h3{margin:0 0 .3rem;font-size:.9rem;display:flex;
  justify-content:space-between;align-items:baseline;gap:.5rem}
.toc-group h3 a{color:var(--ink);text-decoration:none}
.toc-group h3 a:hover{color:var(--accent)}
.count{font-family:var(--mono);font-size:.68rem;color:var(--ink-2);
  font-variant-numeric:tabular-nums}
.toc-list{list-style:none;margin:0;padding:0 0 0 .1rem;
  border-left:1px solid var(--line)}
.toc-list li{margin:0}
.toc-list a{display:block;padding:.16rem 0 .16rem .7rem;font-size:.83rem;
  color:var(--ink-2);text-decoration:none;border-left:2px solid transparent;
  margin-left:-1px}
.toc-list a:hover{color:var(--accent);border-left-color:var(--accent)}

.guide{scroll-margin-top:8.5rem;padding-top:.4rem}
.guide+.guide{margin-top:3.2rem;border-top:1px solid var(--line);padding-top:2.4rem}
.guide-head{margin-bottom:1.4rem}
.eyebrow{font-family:var(--mono);font-size:.7rem;text-transform:uppercase;
  letter-spacing:.12em;color:var(--accent);margin:0 0 .3rem}
.guide-head h2{font-size:clamp(1.6rem,4vw,2.1rem);margin:0;letter-spacing:-.02em;
  text-wrap:balance}
.markets{color:var(--ink-2);font-size:.9rem;margin:.35rem 0 0;max-width:60ch}

.sec{scroll-margin-top:8.5rem;margin:0 0 1.6rem;max-width:68ch}
.sec h3{font-size:1.12rem;margin:0 0 .5rem;letter-spacing:-.01em;text-wrap:balance}
.anchor{float:left;margin-left:-1.1rem;width:1.1rem;color:var(--line);
  text-decoration:none;font-weight:400}
.sec:hover .anchor{color:var(--accent)}
@media (max-width:640px){.anchor{display:none}}
.sec p{margin:0 0 .7rem}
.sec ul{margin:0 0 .8rem;padding-left:1.15rem}
.sec li{margin:0 0 .28rem}
.tel{font-family:var(--mono);font-size:.95em;white-space:nowrap}

p.flag{border-left:3px solid var(--warn);background:var(--warn-soft);
  padding:.6rem .8rem;border-radius:0 var(--radius) var(--radius) 0;color:var(--ink)}

.faq{background:var(--surface);border:1px solid var(--line);
  border-radius:var(--radius);padding:1.1rem 1.2rem;max-width:70ch}
.faq h3{color:var(--accent)}
.qa{border-top:1px solid var(--line);padding-top:.7rem;margin-top:.7rem}
.qa:first-of-type{border-top:0;padding-top:0;margin-top:0}
.qa .q{font-weight:640;margin:0 0 .25rem}
.qa .a{margin:0;color:var(--ink-2)}

.empty{display:none;font-family:var(--mono);font-size:.85rem;color:var(--ink-2);
  padding:2rem 0}
.hide{display:none !important}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
</style>

<div class="bar">
  <div class="bar-inner">
    <div class="brand">
      <h1>ISP Field Guide</h1>
      <span class="meta">__NGUIDES__ providers &middot; __NSECTIONS__ sections</span>
    </div>
    <div class="tools">
      <input id="q" type="search" placeholder="Search all guides, try referral, burial, promo"
             autocomplete="off" spellcheck="false">
      <button class="theme" id="theme" type="button">Theme</button>
    </div>
    <nav class="chips">__SWITCHER__</nav>
  </div>
</div>

<div class="wrap">
  <nav class="toc" id="toc">
    <h2>Contents</h2>
    __TOC__
  </nav>
  <main id="main">
    __BODIES__
    <p class="empty" id="empty">No sections match that search.</p>
  </main>
</div>

<script>
(function(){
  var root=document.documentElement, btn=document.getElementById('theme');
  btn.addEventListener('click',function(){
    var dark=window.matchMedia('(prefers-color-scheme:dark)').matches;
    var cur=root.getAttribute('data-theme')||(dark?'dark':'light');
    root.setAttribute('data-theme',cur==='dark'?'light':'dark');
  });

  var q=document.getElementById('q'),
      secs=[].slice.call(document.querySelectorAll('.sec')),
      guides=[].slice.call(document.querySelectorAll('.guide')),
      groups=[].slice.call(document.querySelectorAll('.toc-group')),
      empty=document.getElementById('empty');

  secs.forEach(function(s){ s._t=(s.dataset.title+' '+s.textContent).toLowerCase(); });

  function run(){
    var term=q.value.trim().toLowerCase();
    if(!term){
      secs.forEach(function(s){s.classList.remove('hide')});
      guides.forEach(function(g){g.classList.remove('hide')});
      groups.forEach(function(g){g.classList.remove('hide')});
      [].forEach.call(document.querySelectorAll('.toc-list a'),function(a){
        a.classList.remove('hide')});
      empty.style.display='none';
      return;
    }
    var shown=0;
    guides.forEach(function(g){
      var any=0;
      [].forEach.call(g.querySelectorAll('.sec'),function(s){
        var hit=s._t.indexOf(term)>-1;
        s.classList.toggle('hide',!hit);
        if(hit){any++;shown++;}
      });
      g.classList.toggle('hide',!any);
    });
    groups.forEach(function(gr){
      var id=gr.dataset.guide, any=0;
      [].forEach.call(gr.querySelectorAll('a[href^="#"]'),function(a){
        var el=document.querySelector(a.getAttribute('href'));
        var hit=el&&!el.classList.contains('hide')&&el.classList.contains('sec');
        if(a.parentElement.tagName==='LI'){a.classList.toggle('hide',!hit); if(hit)any++;}
      });
      gr.classList.toggle('hide',!any);
    });
    empty.style.display=shown?'none':'block';
  }
  q.addEventListener('input',run);
  q.addEventListener('search',run);
})();
</script>
"""


if __name__ == "__main__":
    page = build()
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(page)
    print(f"wrote {OUT} ({len(page):,} bytes)")
