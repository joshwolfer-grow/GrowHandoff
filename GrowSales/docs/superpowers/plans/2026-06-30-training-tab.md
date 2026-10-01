# Training Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Training tab with flashcard/guide content for sales reps, editable from Corporate view, plus a standalone `training.html` page with deep-link support.

**Architecture:** Training cards stored in Supabase `training_cards` table with public read access. In-app tab added to existing bottom bar in `index.html`. Standalone `training.html` shares CSS variables and rendering logic. Corporate users get an edit modal for CRUD operations.

**Tech Stack:** Vanilla JS/HTML/CSS (matching existing SPA), Supabase REST API (existing `sbFetch`/`sbWrite` helpers in-app, direct fetch in standalone page).

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `index.html` | Modify | Add training tab to bottom bar, training tab-section HTML, training CSS, all training JS (render, flashcard, edit modal) |
| `training.html` | Create | Standalone training page — no auth, deep links, shared styling |
| `supabase-migration.sql` | Create | SQL to create `training_cards` table with RLS policies (run manually in Supabase dashboard) |

---

### Task 1: Create Supabase migration script

**Files:**
- Create: `supabase-migration.sql`

- [ ] **Step 1: Write the migration SQL**

Create `supabase-migration.sql` in the project root:

```sql
-- Training Cards table
CREATE TABLE training_cards (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  category text NOT NULL CHECK (category IN ('smokescreens', 'objections', 'aces')),
  subcategory text,
  front text NOT NULL,
  back text NOT NULL,
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- Index for fast category lookups
CREATE INDEX idx_training_cards_category ON training_cards(category, sort_order);

-- RLS: public read, authenticated write
ALTER TABLE training_cards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can read training cards"
  ON training_cards FOR SELECT
  USING (true);

CREATE POLICY "Authenticated users can insert training cards"
  ON training_cards FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update training cards"
  ON training_cards FOR UPDATE
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can delete training cards"
  ON training_cards FOR DELETE
  TO authenticated
  USING (true);
```

- [ ] **Step 2: Commit**

```bash
git add supabase-migration.sql
git commit -m "feat: add training_cards table migration"
```

- [ ] **Step 3: Run migration in Supabase**

Go to Supabase Dashboard → SQL Editor → paste and run `supabase-migration.sql`. Verify the table appears under Table Editor.

---

### Task 2: Add training CSS to index.html

**Files:**
- Modify: `index.html` (CSS section, around lines 20-230)

- [ ] **Step 1: Add training-specific CSS**

Find the closing `</style>` tag (around line 230) and insert the training CSS just before it. The exact insertion point is immediately before `</style>`:

```css
/* Training Tab */
.training-cats{display:flex;flex-direction:column;gap:10px;padding-top:16px;}
.training-cat-card{display:flex;align-items:center;padding:16px;background:var(--card);border-radius:var(--r);border:0.5px solid var(--glass-border);box-shadow:0 1px 3px rgba(0,0,0,0.04);cursor:pointer;transition:background 0.15s;}
.training-cat-card:active{background:var(--hover);}
.training-cat-icon{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px;margin-right:14px;flex-shrink:0;background:rgba(0,122,255,0.08);}
.training-cat-name{font-size:17px;font-weight:700;flex:1;}
.training-cat-count{font-size:13px;color:var(--ink4);font-weight:500;margin-right:4px;}
.training-cat-chevron{color:var(--ink5);font-size:18px;}
.training-header{display:flex;align-items:center;gap:12px;padding:16px 0 8px;}
.training-back{border:none;background:none;font-size:16px;color:var(--blue);font-weight:600;cursor:pointer;padding:0;font-family:inherit;}
.training-title{font-size:20px;font-weight:700;flex:1;}
.training-mode-toggle{display:flex;background:rgba(0,0,0,0.06);border-radius:8px;padding:2px;}
.training-mode-btn{padding:6px 14px;border:none;background:transparent;border-radius:6px;font-size:12px;font-weight:600;color:var(--ink4);cursor:pointer;font-family:inherit;transition:all 0.2s;}
.training-mode-btn.active{background:var(--card-solid);color:var(--ink);box-shadow:0 1px 3px rgba(0,0,0,0.06);}
.training-chips{display:flex;gap:6px;padding:8px 0;flex-wrap:wrap;}
.training-chip{padding:6px 14px;border-radius:20px;border:1px solid var(--line);background:transparent;font-size:13px;font-weight:600;color:var(--ink3);cursor:pointer;font-family:inherit;transition:all 0.2s;}
.training-chip.active{background:var(--blue);color:#fff;border-color:var(--blue);}
.training-guide-list{display:flex;flex-direction:column;gap:10px;padding:8px 0 20px;}
.training-guide-item{background:var(--card);border-radius:var(--r);border:0.5px solid var(--glass-border);box-shadow:0 1px 3px rgba(0,0,0,0.04);overflow:hidden;}
.training-guide-front{font-size:15px;font-weight:700;padding:14px 16px 6px;color:var(--ink);}
.training-guide-back{font-size:14px;font-weight:400;padding:0 16px 14px;color:var(--ink3);line-height:1.5;}
.training-flashcard-wrap{display:flex;flex-direction:column;align-items:center;padding:20px 0;gap:16px;}
.training-flashcard{width:100%;max-width:400px;height:260px;perspective:800px;cursor:pointer;}
.training-flashcard-inner{position:relative;width:100%;height:100%;transition:transform 0.5s;transform-style:preserve-3d;}
.training-flashcard.flipped .training-flashcard-inner{transform:rotateY(180deg);}
.training-flashcard-face{position:absolute;inset:0;backface-visibility:hidden;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;border-radius:var(--r);border:0.5px solid var(--glass-border);box-shadow:0 2px 8px rgba(0,0,0,0.08);}
.training-flashcard-front{background:var(--card);font-size:18px;font-weight:700;color:var(--ink);}
.training-flashcard-back{background:linear-gradient(135deg,rgba(0,122,255,0.04),rgba(0,122,255,0.08));transform:rotateY(180deg);font-size:15px;font-weight:500;color:var(--ink2);line-height:1.5;}
.training-flashcard-nav{display:flex;align-items:center;gap:16px;}
.training-flashcard-nav button{padding:10px 20px;border-radius:var(--r-sm);border:none;background:rgba(0,0,0,0.05);font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;color:var(--ink2);}
.training-flashcard-nav button:active{opacity:0.7;transform:scale(0.97);}
.training-flashcard-progress{font-size:14px;font-weight:600;color:var(--ink4);}
.training-flashcard-shuffle{padding:6px 14px;border-radius:var(--r-sm);border:1px solid var(--line);background:transparent;font-size:12px;font-weight:600;color:var(--ink3);cursor:pointer;font-family:inherit;}
.training-edit-list{display:flex;flex-direction:column;gap:8px;padding:8px 0;max-height:60vh;overflow-y:auto;}
.training-edit-row{display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--card);border-radius:var(--r-sm);border:0.5px solid var(--glass-border);}
.training-edit-row .te-front{flex:1;font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.training-edit-row .te-cat{font-size:11px;font-weight:600;color:var(--ink4);text-transform:uppercase;}
.training-edit-row .te-actions{display:flex;gap:6px;}
.training-edit-row .te-actions button{width:30px;height:30px;border-radius:8px;border:none;background:rgba(0,0,0,0.04);cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;}
.training-edit-row .te-actions button:active{background:rgba(0,0,0,0.08);}
.training-empty{text-align:center;padding:40px 20px;color:var(--ink4);font-size:15px;}
```

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "feat: add training tab CSS styles"
```

---

### Task 3: Add training tab HTML to index.html

**Files:**
- Modify: `index.html` (bottom bar and tab sections, lines 291-376)

- [ ] **Step 1: Add the training tab button to the bottom bar**

Find this line in `index.html` (line 296):
```html
  <div class="tab" data-tab="more"><div class="tab-icon">⚙️</div><div class="tab-label">More</div></div>
```

Insert the training tab **before** it (so training appears before More):
```html
  <div class="tab" data-tab="training"><div class="tab-icon">📖</div><div class="tab-label">Training</div></div>
```

- [ ] **Step 2: Add the training tab section**

Find this line (line 357):
```html
<section class="tab-section" data-section="more">
```

Insert the training section **before** it:
```html
<section class="tab-section" data-section="training">
  <div id="trainingContent"></div>
</section>
```

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: add training tab HTML to bottom bar"
```

---

### Task 4: Add training tab JavaScript — data fetch, category picker, guide/flashcard rendering

**Files:**
- Modify: `index.html` (JS section — insert before the `// ========== TAB SWITCHING ==========` comment at line 4448)

- [ ] **Step 1: Add the training data and rendering functions**

Insert the following JavaScript block just before the line `// ========== TAB SWITCHING ==========` (line 4448):

```javascript
// ========== TRAINING TAB ==========
var _trainingCards=null;
var _trainingView='categories'; // 'categories' | 'detail'
var _trainingCategory=null;
var _trainingMode='guide'; // 'guide' | 'practice'
var _trainingSubFilter='all';
var _trainingFlipIndex=0;
var _trainingFlipped=false;
var _trainingShuffled=null;

async function fetchTrainingCards(){
  if(_trainingCards)return _trainingCards;
  try{_trainingCards=await sbFetch('training_cards','&order=sort_order.asc,created_at.asc');}catch(e){console.error('Training fetch error:',e);_trainingCards=[];}
  return _trainingCards;
}

function renderTraining(){
  fetchTrainingCards().then(function(){
    if(_trainingView==='detail')renderTrainingDetail();
    else renderTrainingCategories();
  });
}

function renderTrainingCategories(){
  _trainingView='categories';
  var cards=_trainingCards||[];
  var counts={smokescreens:0,objections:0,aces:0};
  cards.forEach(function(c){if(counts[c.category]!==undefined)counts[c.category]++;});
  var cats=[
    {key:'smokescreens',icon:'🛡️',name:'Smokescreens',desc:'Common deflections & what to say'},
    {key:'objections',icon:'💬',name:'Objections',desc:'Real concerns & how to handle them'},
    {key:'aces',icon:'🃏',name:'ISP Aces',desc:'Selling points by provider'}
  ];
  var h='';
  if(VIEW==='Corporate')h+='<div style="padding:16px 0 0;text-align:right;"><button class="btn-sm btn-primary" onclick="openTrainingEditor()">Edit Training</button></div>';
  h+='<div class="training-cats">';
  cats.forEach(function(cat){
    h+='<div class="training-cat-card" onclick="openTrainingCategory(\''+cat.key+'\')">';
    h+='<div class="training-cat-icon">'+cat.icon+'</div>';
    h+='<div style="flex:1;"><div class="training-cat-name">'+cat.name+'</div><div style="font-size:13px;color:var(--ink4);margin-top:2px;">'+cat.desc+'</div></div>';
    h+='<div class="training-cat-count">'+counts[cat.key]+'</div>';
    h+='<div class="training-cat-chevron">›</div>';
    h+='</div>';
  });
  h+='</div>';
  document.getElementById('trainingContent').innerHTML=h;
}

function openTrainingCategory(cat){
  _trainingCategory=cat;
  _trainingView='detail';
  _trainingMode='guide';
  _trainingSubFilter='all';
  _trainingFlipIndex=0;
  _trainingFlipped=false;
  _trainingShuffled=null;
  renderTrainingDetail();
}

function getFilteredTrainingCards(){
  var cards=(_trainingCards||[]).filter(function(c){return c.category===_trainingCategory;});
  if(_trainingCategory==='aces'&&_trainingSubFilter!=='all'){
    cards=cards.filter(function(c){return(c.subcategory||'').toLowerCase()===_trainingSubFilter.toLowerCase();});
  }
  return cards;
}

function renderTrainingDetail(){
  var catNames={smokescreens:'Smokescreens',objections:'Objections',aces:'ISP Aces'};
  var cards=getFilteredTrainingCards();
  var h='<div class="training-header">';
  h+='<button class="training-back" onclick="renderTrainingCategories()">← Back</button>';
  h+='<div class="training-title">'+catNames[_trainingCategory]+'</div>';
  h+='<div class="training-mode-toggle">';
  h+='<button class="training-mode-btn'+(_trainingMode==='guide'?' active':'')+'" onclick="setTrainingMode(\'guide\')">Guide</button>';
  h+='<button class="training-mode-btn'+(_trainingMode==='practice'?' active':'')+'" onclick="setTrainingMode(\'practice\')">Practice</button>';
  h+='</div></div>';

  if(_trainingCategory==='aces'){
    var subs={};(_trainingCards||[]).forEach(function(c){if(c.category==='aces'&&c.subcategory)subs[c.subcategory]=true;});
    var subList=Object.keys(subs).sort();
    if(subList.length>0){
      h+='<div class="training-chips">';
      h+='<button class="training-chip'+(_trainingSubFilter==='all'?' active':'')+'" onclick="setTrainingSub(\'all\')">All</button>';
      subList.forEach(function(s){
        h+='<button class="training-chip'+(_trainingSubFilter.toLowerCase()===s.toLowerCase()?' active':'')+'" onclick="setTrainingSub(\''+esc(s)+'\')">'+esc(s)+'</button>';
      });
      h+='</div>';
    }
  }

  if(_trainingMode==='guide'){
    if(cards.length===0){
      h+='<div class="training-empty">No cards yet. '+(VIEW==='Corporate'?'Tap "Edit Training" to add some.':'Check back soon!')+'</div>';
    }else{
      h+='<div class="training-guide-list">';
      cards.forEach(function(c){
        h+='<div class="training-guide-item"><div class="training-guide-front">'+esc(c.front)+'</div><div class="training-guide-back">'+esc(c.back)+'</div></div>';
      });
      h+='</div>';
    }
  }else{
    if(cards.length===0){
      h+='<div class="training-empty">No cards to practice.</div>';
    }else{
      var order=_trainingShuffled||cards.map(function(_,i){return i;});
      if(_trainingFlipIndex>=order.length)_trainingFlipIndex=0;
      var card=cards[order[_trainingFlipIndex]];
      h+='<div class="training-flashcard-wrap">';
      h+='<div class="training-flashcard'+(_trainingFlipped?' flipped':'')+'" onclick="flipTrainingCard()">';
      h+='<div class="training-flashcard-inner">';
      h+='<div class="training-flashcard-face training-flashcard-front">'+esc(card.front)+'</div>';
      h+='<div class="training-flashcard-face training-flashcard-back">'+esc(card.back)+'</div>';
      h+='</div></div>';
      h+='<div class="training-flashcard-nav">';
      h+='<button onclick="prevTrainingCard()">← Prev</button>';
      h+='<span class="training-flashcard-progress">'+(_trainingFlipIndex+1)+' / '+cards.length+'</span>';
      h+='<button onclick="nextTrainingCard()">Next →</button>';
      h+='</div>';
      h+='<button class="training-flashcard-shuffle" onclick="shuffleTrainingCards()">🔀 Shuffle</button>';
      h+='</div>';
    }
  }

  document.getElementById('trainingContent').innerHTML=h;
}

function setTrainingMode(mode){_trainingMode=mode;_trainingFlipIndex=0;_trainingFlipped=false;_trainingShuffled=null;renderTrainingDetail();}
function setTrainingSub(sub){_trainingSubFilter=sub;_trainingFlipIndex=0;_trainingFlipped=false;_trainingShuffled=null;renderTrainingDetail();}
function flipTrainingCard(){_trainingFlipped=!_trainingFlipped;renderTrainingDetail();}
function nextTrainingCard(){var cards=getFilteredTrainingCards();var order=_trainingShuffled||cards.map(function(_,i){return i;});_trainingFlipIndex=(_trainingFlipIndex+1)%order.length;_trainingFlipped=false;renderTrainingDetail();}
function prevTrainingCard(){var cards=getFilteredTrainingCards();var order=_trainingShuffled||cards.map(function(_,i){return i;});_trainingFlipIndex=(_trainingFlipIndex-1+order.length)%order.length;_trainingFlipped=false;renderTrainingDetail();}
function shuffleTrainingCards(){var cards=getFilteredTrainingCards();var arr=cards.map(function(_,i){return i;});for(var i=arr.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1));var tmp=arr[i];arr[i]=arr[j];arr[j]=tmp;}_trainingShuffled=arr;_trainingFlipIndex=0;_trainingFlipped=false;renderTrainingDetail();}
```

- [ ] **Step 2: Wire up the training tab in the tab-switching listener**

Find this line (around line 4449 — now shifted down by the training code insertion):
```javascript
document.querySelectorAll('.bottom-bar .tab').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.bottom-bar .tab').forEach(x=>x.classList.toggle('active',x===b));document.querySelectorAll('.tab-section').forEach(s=>s.classList.toggle('active',s.dataset.section===b.dataset.tab));if(b.dataset.tab==='more')backToMore();}));
```

Replace it with:
```javascript
document.querySelectorAll('.bottom-bar .tab').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.bottom-bar .tab').forEach(x=>x.classList.toggle('active',x===b));document.querySelectorAll('.tab-section').forEach(s=>s.classList.toggle('active',s.dataset.section===b.dataset.tab));if(b.dataset.tab==='more')backToMore();if(b.dataset.tab==='training')renderTraining();}));
```

(Only change: added `if(b.dataset.tab==='training')renderTraining();` at the end.)

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: add training tab rendering — categories, guide, flashcards"
```

---

### Task 5: Add training editor (Corporate view) JavaScript

**Files:**
- Modify: `index.html` (JS section — insert right after the training tab code added in Task 4, before the tab-switching line)

- [ ] **Step 1: Add the editor functions**

Insert immediately after the `shuffleTrainingCards` function:

```javascript
// ========== TRAINING EDITOR (Corporate) ==========
function openTrainingEditor(){
  var cards=_trainingCards||[];
  var catLabels={smokescreens:'Smokescreens',objections:'Objections',aces:'ISP Aces'};
  var grouped={smokescreens:[],objections:[],aces:[]};
  cards.forEach(function(c){if(grouped[c.category])grouped[c.category].push(c);});
  var h='<div style="padding:4px 0 12px;"><span style="font-size:20px;font-weight:700;">Edit Training Cards</span></div>';
  h+='<button class="btn-sm btn-primary" onclick="openTrainingCardForm()" style="margin-bottom:12px;">+ Add Card</button>';
  ['smokescreens','objections','aces'].forEach(function(cat){
    var catCards=grouped[cat];
    h+='<div style="font-size:13px;font-weight:700;color:var(--ink4);text-transform:uppercase;letter-spacing:0.03em;padding:12px 0 6px;">'+catLabels[cat]+' ('+catCards.length+')</div>';
    if(catCards.length===0){h+='<div style="font-size:13px;color:var(--ink5);padding:4px 0;">No cards</div>';}
    h+='<div class="training-edit-list">';
    catCards.forEach(function(c){
      h+='<div class="training-edit-row">';
      h+='<div class="te-front">'+esc(c.front)+(c.subcategory?' <span class="te-cat">'+esc(c.subcategory)+'</span>':'')+'</div>';
      h+='<div class="te-actions">';
      h+='<button onclick="openTrainingCardForm(\''+c.id+'\')" title="Edit">✏️</button>';
      h+='<button onclick="deleteTrainingCard(\''+c.id+'\')" title="Delete">🗑️</button>';
      h+='</div></div>';
    });
    h+='</div>';
  });
  openModal(1,h);
}

function openTrainingCardForm(editId){
  var card=editId?(_trainingCards||[]).find(function(c){return c.id===editId;}):null;
  var h='<div style="padding:4px 0 12px;"><span style="font-size:18px;font-weight:700;">'+(card?'Edit Card':'Add Card')+'</span></div>';
  h+='<div style="display:flex;flex-direction:column;gap:12px;">';
  h+='<label style="font-size:13px;font-weight:600;color:var(--ink3);">Category</label>';
  h+='<select id="tcFormCat" class="field-input" onchange="document.getElementById(\'tcFormSubWrap\').style.display=this.value===\'aces\'?\'block\':\'none\'">';
  ['smokescreens','objections','aces'].forEach(function(cat){
    h+='<option value="'+cat+'"'+(card&&card.category===cat?' selected':'')+'>'+{smokescreens:'Smokescreens',objections:'Objections',aces:'ISP Aces'}[cat]+'</option>';
  });
  h+='</select>';
  h+='<div id="tcFormSubWrap" style="display:'+((!card||card.category==='aces')?'block':'none')+'">';
  h+='<label style="font-size:13px;font-weight:600;color:var(--ink3);">ISP (subcategory)</label>';
  h+='<input id="tcFormSub" class="field-input" type="text" placeholder="e.g. AT&T, Brightspeed" value="'+esc(card?card.subcategory||'':'')+'">';
  h+='</div>';
  h+='<label style="font-size:13px;font-weight:600;color:var(--ink3);">Front (question/smokescreen/ace)</label>';
  h+='<textarea id="tcFormFront" class="field-input" rows="3" style="resize:vertical;">'+esc(card?card.front:'')+'</textarea>';
  h+='<label style="font-size:13px;font-weight:600;color:var(--ink3);">Back (response/talking point)</label>';
  h+='<textarea id="tcFormBack" class="field-input" rows="4" style="resize:vertical;">'+esc(card?card.back:'')+'</textarea>';
  h+='<label style="font-size:13px;font-weight:600;color:var(--ink3);">Sort Order</label>';
  h+='<input id="tcFormSort" class="field-input" type="number" value="'+(card?card.sort_order:0)+'">';
  h+='<button class="btn-sm btn-primary" onclick="saveTrainingCard('+(editId?'\''+editId+'\'':'null')+')">Save</button>';
  h+='</div>';
  openModal(2,h);
}

async function saveTrainingCard(editId){
  var cat=document.getElementById('tcFormCat').value;
  var sub=cat==='aces'?document.getElementById('tcFormSub').value.trim():null;
  var front=document.getElementById('tcFormFront').value.trim();
  var back=document.getElementById('tcFormBack').value.trim();
  var sortOrder=parseInt(document.getElementById('tcFormSort').value)||0;
  if(!front||!back){alert('Front and back are required.');return;}
  var body={category:cat,subcategory:sub,front:front,back:back,sort_order:sortOrder};
  if(editId){
    await sbWrite('training_cards','PATCH',body,'id=eq.'+editId);
  }else{
    await sbWrite('training_cards','POST',body);
  }
  closeModal(2);
  _trainingCards=null;
  fetchTrainingCards().then(function(){openTrainingEditor();renderTraining();});
}

async function deleteTrainingCard(id){
  if(!confirm('Delete this training card?'))return;
  await sbWrite('training_cards','DELETE',null,'id=eq.'+id);
  _trainingCards=null;
  fetchTrainingCards().then(function(){openTrainingEditor();renderTraining();});
}
```

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "feat: add training card editor for Corporate view"
```

---

### Task 6: Create standalone training.html

**Files:**
- Create: `training.html`

- [ ] **Step 1: Create the standalone page**

Create `training.html` in the project root. This page reuses the same CSS variables and card styles, fetches training cards from Supabase without auth, and supports hash-based deep links.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#fafaf9">
<title>Grow · Training</title>
<style>
:root{
  --bg:#f0f0f5;--glass:rgba(255,255,255,0.72);--glass-border:rgba(0,0,0,0.06);
  --glass-thick:rgba(255,255,255,0.85);--card:rgba(255,255,255,0.92);--card-solid:#fff;
  --ink:#000;--ink2:#1d1d1f;--ink3:#48484a;--ink4:#86868b;--ink5:#aeaeb2;
  --sep:rgba(60,60,67,0.12);--blue:#007aff;--green:#34c759;--red:#ff3b30;--amber:#ff9500;
  --hover:rgba(0,0,0,0.03);--r:14px;--r-sm:10px;
  --line:rgba(60,60,67,0.12);
}
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','SF Pro Text',system-ui,sans-serif;color:var(--ink2);background:var(--bg);-webkit-font-smoothing:antialiased;padding:0 20px 40px;max-width:600px;margin:0 auto;}
@media(min-width:768px){body{max-width:700px;padding:0 40px 40px;}}
.st-header{padding:24px 0 8px;text-align:center;}
.st-logo{height:36px;margin-bottom:4px;}
.st-title{font-size:24px;font-weight:700;letter-spacing:-0.3px;}
.st-sub{font-size:13px;color:var(--ink4);font-weight:500;margin-top:2px;}
.training-cats{display:flex;flex-direction:column;gap:10px;padding-top:16px;}
.training-cat-card{display:flex;align-items:center;padding:16px;background:var(--card);border-radius:var(--r);border:0.5px solid var(--glass-border);box-shadow:0 1px 3px rgba(0,0,0,0.04);cursor:pointer;transition:background 0.15s;}
.training-cat-card:active{background:var(--hover);}
.training-cat-icon{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px;margin-right:14px;flex-shrink:0;background:rgba(0,122,255,0.08);}
.training-cat-name{font-size:17px;font-weight:700;flex:1;}
.training-cat-count{font-size:13px;color:var(--ink4);font-weight:500;margin-right:4px;}
.training-cat-chevron{color:var(--ink5);font-size:18px;}
.training-header{display:flex;align-items:center;gap:12px;padding:16px 0 8px;}
.training-back{border:none;background:none;font-size:16px;color:var(--blue);font-weight:600;cursor:pointer;padding:0;font-family:inherit;}
.training-title{font-size:20px;font-weight:700;flex:1;}
.training-mode-toggle{display:flex;background:rgba(0,0,0,0.06);border-radius:8px;padding:2px;}
.training-mode-btn{padding:6px 14px;border:none;background:transparent;border-radius:6px;font-size:12px;font-weight:600;color:var(--ink4);cursor:pointer;font-family:inherit;transition:all 0.2s;}
.training-mode-btn.active{background:var(--card-solid);color:var(--ink);box-shadow:0 1px 3px rgba(0,0,0,0.06);}
.training-chips{display:flex;gap:6px;padding:8px 0;flex-wrap:wrap;}
.training-chip{padding:6px 14px;border-radius:20px;border:1px solid var(--line);background:transparent;font-size:13px;font-weight:600;color:var(--ink3);cursor:pointer;font-family:inherit;transition:all 0.2s;}
.training-chip.active{background:var(--blue);color:#fff;border-color:var(--blue);}
.training-guide-list{display:flex;flex-direction:column;gap:10px;padding:8px 0 20px;}
.training-guide-item{background:var(--card);border-radius:var(--r);border:0.5px solid var(--glass-border);box-shadow:0 1px 3px rgba(0,0,0,0.04);overflow:hidden;}
.training-guide-front{font-size:15px;font-weight:700;padding:14px 16px 6px;color:var(--ink);}
.training-guide-back{font-size:14px;font-weight:400;padding:0 16px 14px;color:var(--ink3);line-height:1.5;}
.training-flashcard-wrap{display:flex;flex-direction:column;align-items:center;padding:20px 0;gap:16px;}
.training-flashcard{width:100%;max-width:400px;height:260px;perspective:800px;cursor:pointer;}
.training-flashcard-inner{position:relative;width:100%;height:100%;transition:transform 0.5s;transform-style:preserve-3d;}
.training-flashcard.flipped .training-flashcard-inner{transform:rotateY(180deg);}
.training-flashcard-face{position:absolute;inset:0;backface-visibility:hidden;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;border-radius:var(--r);border:0.5px solid var(--glass-border);box-shadow:0 2px 8px rgba(0,0,0,0.08);}
.training-flashcard-front{background:var(--card);font-size:18px;font-weight:700;color:var(--ink);}
.training-flashcard-back{background:linear-gradient(135deg,rgba(0,122,255,0.04),rgba(0,122,255,0.08));transform:rotateY(180deg);font-size:15px;font-weight:500;color:var(--ink2);line-height:1.5;}
.training-flashcard-nav{display:flex;align-items:center;gap:16px;}
.training-flashcard-nav button{padding:10px 20px;border-radius:var(--r-sm);border:none;background:rgba(0,0,0,0.05);font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;color:var(--ink2);}
.training-flashcard-nav button:active{opacity:0.7;transform:scale(0.97);}
.training-flashcard-progress{font-size:14px;font-weight:600;color:var(--ink4);}
.training-flashcard-shuffle{padding:6px 14px;border-radius:var(--r-sm);border:1px solid var(--line);background:transparent;font-size:12px;font-weight:600;color:var(--ink3);cursor:pointer;font-family:inherit;}
.training-empty{text-align:center;padding:40px 20px;color:var(--ink4);font-size:15px;}
.loading{text-align:center;padding:60px 20px;color:var(--ink4);font-size:15px;}
</style>
</head>
<body>
<div class="st-header">
  <div class="st-title">Grow · Training</div>
  <div class="st-sub">Sales training materials</div>
</div>
<div id="trainingContent"><div class="loading">Loading training materials…</div></div>

<script>
var SUPABASE_URL='https://cmkfohwbejcztctrpdnt.supabase.co';
var SUPABASE_ANON='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNta2ZvaHdiZWpjenRjdHJwZG50Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyNDYyODgsImV4cCI6MjA5NzgyMjI4OH0.waLa5E9a6SMvJ70keY9duAz4VxK39sDNNbmPSSbcebo';
var SB_HEADERS={'apikey':SUPABASE_ANON,'Authorization':'Bearer '+SUPABASE_ANON,'Content-Type':'application/json'};

var _cards=[];
var _view='categories';
var _category=null;
var _mode='guide';
var _subFilter='all';
var _flipIndex=0;
var _flipped=false;
var _shuffled=null;

function esc(s){if(s==null)return'';return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}

async function loadCards(){
  var url=SUPABASE_URL+'/rest/v1/training_cards?select=*&order=sort_order.asc,created_at.asc&limit=50000';
  var r=await fetch(url,{headers:SB_HEADERS});
  if(!r.ok)throw new Error('Supabase '+r.status);
  _cards=await r.json();
}

function getFiltered(){
  var cards=_cards.filter(function(c){return c.category===_category;});
  if(_category==='aces'&&_subFilter!=='all'){
    cards=cards.filter(function(c){return(c.subcategory||'').toLowerCase()===_subFilter.toLowerCase();});
  }
  return cards;
}

function renderCategories(){
  _view='categories';
  location.hash='';
  var counts={smokescreens:0,objections:0,aces:0};
  _cards.forEach(function(c){if(counts[c.category]!==undefined)counts[c.category]++;});
  var cats=[
    {key:'smokescreens',icon:'🛡️',name:'Smokescreens',desc:'Common deflections & what to say'},
    {key:'objections',icon:'💬',name:'Objections',desc:'Real concerns & how to handle them'},
    {key:'aces',icon:'🃏',name:'ISP Aces',desc:'Selling points by provider'}
  ];
  var h='<div class="training-cats">';
  cats.forEach(function(cat){
    h+='<div class="training-cat-card" onclick="openCategory(\''+cat.key+'\')">';
    h+='<div class="training-cat-icon">'+cat.icon+'</div>';
    h+='<div style="flex:1;"><div class="training-cat-name">'+cat.name+'</div><div style="font-size:13px;color:var(--ink4);margin-top:2px;">'+cat.desc+'</div></div>';
    h+='<div class="training-cat-count">'+counts[cat.key]+'</div>';
    h+='<div class="training-cat-chevron">›</div>';
    h+='</div>';
  });
  h+='</div>';
  document.getElementById('trainingContent').innerHTML=h;
}

function openCategory(cat){
  _category=cat;_view='detail';_mode='guide';_subFilter='all';_flipIndex=0;_flipped=false;_shuffled=null;
  location.hash=cat;
  renderDetail();
}

function renderDetail(){
  var catNames={smokescreens:'Smokescreens',objections:'Objections',aces:'ISP Aces'};
  var cards=getFiltered();
  var h='<div class="training-header">';
  h+='<button class="training-back" onclick="renderCategories()">← Back</button>';
  h+='<div class="training-title">'+catNames[_category]+'</div>';
  h+='<div class="training-mode-toggle">';
  h+='<button class="training-mode-btn'+(_mode==='guide'?' active':'')+'" onclick="setMode(\'guide\')">Guide</button>';
  h+='<button class="training-mode-btn'+(_mode==='practice'?' active':'')+'" onclick="setMode(\'practice\')">Practice</button>';
  h+='</div></div>';

  if(_category==='aces'){
    var subs={};_cards.forEach(function(c){if(c.category==='aces'&&c.subcategory)subs[c.subcategory]=true;});
    var subList=Object.keys(subs).sort();
    if(subList.length>0){
      h+='<div class="training-chips">';
      h+='<button class="training-chip'+(_subFilter==='all'?' active':'')+'" onclick="setSub(\'all\')">All</button>';
      subList.forEach(function(s){
        h+='<button class="training-chip'+(_subFilter.toLowerCase()===s.toLowerCase()?' active':'')+'" onclick="setSub(\''+esc(s)+'\')">'+esc(s)+'</button>';
      });
      h+='</div>';
    }
  }

  if(_mode==='guide'){
    if(cards.length===0){
      h+='<div class="training-empty">No cards yet. Check back soon!</div>';
    }else{
      h+='<div class="training-guide-list">';
      cards.forEach(function(c){
        h+='<div class="training-guide-item"><div class="training-guide-front">'+esc(c.front)+'</div><div class="training-guide-back">'+esc(c.back)+'</div></div>';
      });
      h+='</div>';
    }
  }else{
    if(cards.length===0){
      h+='<div class="training-empty">No cards to practice.</div>';
    }else{
      var order=_shuffled||cards.map(function(_,i){return i;});
      if(_flipIndex>=order.length)_flipIndex=0;
      var card=cards[order[_flipIndex]];
      h+='<div class="training-flashcard-wrap">';
      h+='<div class="training-flashcard'+(_flipped?' flipped':'')+'" onclick="flipCard()">';
      h+='<div class="training-flashcard-inner">';
      h+='<div class="training-flashcard-face training-flashcard-front">'+esc(card.front)+'</div>';
      h+='<div class="training-flashcard-face training-flashcard-back">'+esc(card.back)+'</div>';
      h+='</div></div>';
      h+='<div class="training-flashcard-nav">';
      h+='<button onclick="prevCard()">← Prev</button>';
      h+='<span class="training-flashcard-progress">'+(_flipIndex+1)+' / '+cards.length+'</span>';
      h+='<button onclick="nextCard()">Next →</button>';
      h+='</div>';
      h+='<button class="training-flashcard-shuffle" onclick="shuffleCards()">🔀 Shuffle</button>';
      h+='</div>';
    }
  }
  document.getElementById('trainingContent').innerHTML=h;
}

function setMode(m){_mode=m;_flipIndex=0;_flipped=false;_shuffled=null;renderDetail();}
function setSub(s){_subFilter=s;_flipIndex=0;_flipped=false;_shuffled=null;renderDetail();}
function flipCard(){_flipped=!_flipped;renderDetail();}
function nextCard(){var cards=getFiltered();var order=_shuffled||cards.map(function(_,i){return i;});_flipIndex=(_flipIndex+1)%order.length;_flipped=false;renderDetail();}
function prevCard(){var cards=getFiltered();var order=_shuffled||cards.map(function(_,i){return i;});_flipIndex=(_flipIndex-1+order.length)%order.length;_flipped=false;renderDetail();}
function shuffleCards(){var cards=getFiltered();var arr=cards.map(function(_,i){return i;});for(var i=arr.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1));var tmp=arr[i];arr[i]=arr[j];arr[j]=tmp;}_shuffled=arr;_flipIndex=0;_flipped=false;renderDetail();}

(async function(){
  try{
    await loadCards();
    var hash=location.hash.replace('#','').toLowerCase();
    if(hash){
      var parts=hash.split('/');
      var cat=parts[0];
      if(['smokescreens','objections','aces'].indexOf(cat)>=0){
        _category=cat;_view='detail';
        if(cat==='aces'&&parts[1]){
          var matchSub=null;
          _cards.forEach(function(c){if(c.category==='aces'&&c.subcategory&&c.subcategory.toLowerCase()===parts[1].toLowerCase())matchSub=c.subcategory;});
          if(matchSub)_subFilter=matchSub;
        }
        renderDetail();
      }else{
        renderCategories();
      }
    }else{
      renderCategories();
    }
  }catch(e){
    document.getElementById('trainingContent').innerHTML='<div class="training-empty">Failed to load training materials. Please try again later.</div>';
    console.error(e);
  }
})();
</script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add training.html
git commit -m "feat: add standalone training page with deep links"
```

---

### Task 7: Verify and test

- [ ] **Step 1: Run the Supabase migration**

Execute the SQL from `supabase-migration.sql` in the Supabase dashboard SQL editor.

- [ ] **Step 2: Deploy to Vercel**

```bash
vercel --prod
```

- [ ] **Step 3: Verify in-app training tab**

1. Open the app in a browser.
2. Tap the "Training" tab in the bottom bar — should show three category cards with 0 counts.
3. Switch to Corporate view and tap "Edit Training" — should open the editor modal.
4. Add a test card (category: Smokescreens, front: "I'm not interested", back: "I totally understand...").
5. Verify the card appears in the guide view.
6. Switch to Practice mode — verify flip and navigation work.

- [ ] **Step 4: Verify standalone page**

1. Open `https://your-domain.vercel.app/training.html` — should show categories.
2. Open `training.html#smokescreens` — should jump directly to Smokescreens detail.
3. Open `training.html#aces/att` — should jump to ISP Aces filtered by AT&T (once aces cards exist).

- [ ] **Step 5: Commit any fixes and final deploy**

```bash
git add -A
git commit -m "fix: training tab adjustments from testing"
vercel --prod
```
