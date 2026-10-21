# Data sources

Who is the source of truth for what (current as of Oct 21 2026):

| Question | Source |
|---|---|
| Sales (sold, rep counts, PRA numerators on most pages) | **Bria** (new Bria since Sep 11 2026), `bria_deals` / `bria_sales_daily` |
| Installs, cancels, install rates, booking lag, deal type | **Install report** = Rep Sales Google Sheet → `deals` table |
| KPI page sales | install report only, Bria fills past the report's coverage date (see metrics-definitions.md) |
| Teams / who reps report to | **Bria teams** (`__bria_teams__`) since Sep 29 2026 (see teams-roster-subs.md) |
| Rep identity | Sequifi login email (`rep_identity`) |
| Doors / contacts / hours | Knocking feeds: SalesRabbit crawl, Opendoor RTR portal (Ezee/Bluepeak/Omni), TDS Amplify (see knocking.md) |
| Sold on knocking rows | Bria per rep-day, never SalesRabbit pins |
| ISP of a deal | `bria_deals.isp` (= Bria `sales.client_company_name`), or `deals.isp` |
| Onboarding docs / recruiter | Sequifi API |

## Bria (sales app reps log deals in)

- **New Bria** (live sync since 2026-09-11 21:03 UTC): Supabase project `bria` / `oofisagqyhfcpmfmcjwt`, app https://growfiber.vercel.app. Reps moved to it around Sep 7 2026 (old Bria reps/day fell 24 → 3; first sync backfilled Sep 7 to 10 as 112/36/44/35).
- Access is a SELECT-only Postgres role `grow_sales_readonly`, not service_role. Vercel env on GrowSales: `BRIA_SUPABASE_URL`, `BRIA_SUPABASE_PUBLISHABLE_KEY` (apikey header), `BRIA_SUPABASE_READONLY_KEY` (Bearer only, never as apikey). Setting the read-only key flips `api/bria-sync.js` into new mode. Never touch growfiber's `GROW_SALES_SUPABASE_*` vars (opposite direction). Keys for direct probing were kept in `GrowSales/.env.bria`. Verify access: `node scripts/bria-schema-check.mjs`.
- Role can read `users`, `sales`, `teams`, `company_memberships`, `sales_imports`, and (grant landed Sep 30 2026) `learning_groups` + `learning_group_assignments`. NOT the 8 training tables or `companies`, so the sync keeps existing `training_completion` untouched. Grow is the only company; the sync alerts if sales ever show more than one `company_id`.
- New Bria sales start 2026-01-01 (one CSV import), ~730 short of old Bria for Jan to Apr, within 0.5% May to Aug. So the sync only replaces `sale_date >= BRIA_CUTOVER` (default 2026-05-01); older rows are frozen old-Bria history. Full copy at the switch in schema `backup` (`*_20260911`).
- Old Bria (history): `auth.getbria.com` with `BRIA_ANON_KEY`/`BRIA_EMAIL`/`BRIA_PASSWORD` (a backdoor login). The nightly server cron once pulled 0 rows for days (timeout + silent bad-password fallback); `bria-sync.js` now refuses to wipe tables on an empty pull and errors loudly.
- Bria stores legal names in new Bria; aliases in `api/_name-aliases.js` (James→Drex Duffy, Nicklas→Nick Anderson, Benjamin→Ben Lamoreaux, Kaitlyn→Kait Clark, Mikevic→Kevic Hall, Damitrus→Monte Burns, "Pennsylvaniary Ellison"→Glory Ellison from a Glo→Pennsylvania find/replace). Jacob S Taylor (218 pre-May) and John Patrick Holthaus (19) split from new Jacob Taylor / John Holthaus unless frozen rows are renamed. `bria-sync.js` canonicalises rep names (`canonicalRepNames()`, needs `&limit=50000` because PostgREST caps at 1000 silently); the install report's spelling beats the alias table.
- Bria tables in Grow DB: `bria_deals` (incl. `team_id`, `isp`, `product`, `customer`, `phone`), `bria_sales_daily`, `bria_reps` (rep, bria_id, photo_url; upsert never replace so a failed pull can't blank photos), `bria_teams`, `bria_memberships`, `training_completion`. Rep photos: Bria `users.photo_url`, fetched in a separate guarded call; dashboard `_avatarHtml` overlays it on the initials with `onerror="this.remove()"`; name match via `_repPhotoNorm`.
- ISP lives on the Bria deal: `client_company_name` is ~100% populated; `product_label` is always "Fiber Internet" (moved to `teams` in new Bria). Spellings differ from the install report ("i3 Fiber" vs "i3 Broadband", "SLIC Fiber" vs "SLIC", "TDS Fiber" vs "TDS", "GFiber"/"Google Fiber"); always compare via `_ispKey()` / `_ufIspKey()` (strip fiber/broadband/internet/llc/inc, map g→google). BUT Bria's isp label is unreliable for team assignment (Hogue crew showed Glo Fiber while selling Omni MI); never assign teams by Bria isp.
- Bria has no deal-type column and no planned_install for presale. ~1,223 old rows had a raw UUID as rep (4 nameless users); `_isUuidRep()` drops them everywhere.
- **Demo company (Oct 14 to 16 2026):** Bria added a second company `b71a0000-de00-4000-8000-000000000001` (teams Demo Falcons / Harbor / Summit, ISPs "Demo Fiber", "Summit Net (Demo)", "Harbor Broadband (Demo)", reps like Umber Fernwhistle, Finley Thistlecrown, John Doe: 31 users, 3,105 "installed" sales back-dated to May 1). The read-only role sees every company, so the Oct 16 09:22 sync pulled it into `bria_sales_daily`, `bria_deals`, `bria_memberships`, `bria_teams` and `__bria_teams__` (PRA and leaderboards showed fake reps). Grow's company id is `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1` (`BRIA_COMPANY_ID` const in `bria-sync.js`, env override). Fix deployed Oct 16 18:40: sales/teams/memberships filtered by company, users by Grow membership or sale; run with `?force=1`; demo rows in the upsert-only tables deleted by hand. The earlier "alerts if more than one company_id" note no longer applies; the filter is the guard.
- **Cross-rep duplicates (Oct 2026):** the same customer entered under two reps on the same day inflates Bria counts (Will Gabor 30 vs real 25 on Oct 3: five Surf customers also under "Kanyon", Sequifi credits Reuben Dodson; also Conner Gardner/Ryan Ewell, Isaiah Wiggins/Kaden Neff, Trenton Dennis, Jacob/Jacob Stenberg). Tell: Leaderboard Club count (bria_sales_daily) vs its click-in list (Sequifi deals). The owner wants Bria cleaned, with a stopgap `BRIA_EXCLUDE` list + `applyBriaExclude()` in `api/bria-sync.js` (named rep+date+customer entries dropped at sync, subtracting only what is found; no-op once Bria is fixed; needs a sync run). No general dedupe unless asked. When a count looks high, check `bria_deals` for the same customer + sale_date under several reps and report it for Bria cleanup.
- **First-name-only Bria logins** (Oct 2026): "Jacob" (created Sep 30) is Jacob Stenberg (10 customers under both names), "Kanyon" (36 deals, Chicago/Illinois/Indiana) matches Reuben Dodson's Sequifi deals, "mana" = mana boyde. These are Bria account fixes, not aliases. Bria rows carry NO email column (`bria_sales_daily` is rep/sale_date/deals/installs); Bria joins to a person only by name alias in the browser.
- Bria's isp tags are wrong often enough to ignore for teams (Oct 20: Hinshaw/Stenberg/Finny tagged i3, the Michigan crew tagged Omni; Surf reps tagged i3/Ezee).
- Some reps stopped entering deals in Bria after Sep 24 2026 (Isaiah Wiggins, Quay Manuel, Slone Potts, the Hogues) while install reports kept showing their sales, so Bria-sourced weeks read low for Ezee Michigan and Houston; the Oct 2026 decks used the install report where it covered the week.
- Bria's own devs (they use Grok) read our `knock_board_company` view to show the Knocking board inside Bria (see knocking.md).
- Bria sold runs above the install report (e.g. week of Jul 19: 821 vs 527). Old view: "higher is better" for leaderboards.

## Install report (Rep Sales Google Sheet → `deals`)

- The "Rep Sales Data" Google Sheet (id `19tYXTotbLPJ3N3678UcPKZTLCIKfQD30FnZI23sUqgE`) receives ISP install reports; an Apps Script ("GROW DASHBOARD — Supabase Sync Script", source in `GrowSales/scripts/rep-sales-sync.gs`) syncs it hourly to Supabase. `deals` and leaderboard are full-replace (sheet owns them); knocking uses `supabaseReplaceScoped()` (only rep+date pairs in the sheet). Before Jul 20 2026 it did `DELETE /rest/v1/knocking?id=gt.0` hourly and wiped other feeds. That Apps Script embeds the Supabase service-role key (rotate someday).
- Manual "Sync now": More/Admin → Sync sheet → `api/sheet-sync.js` → the Apps Script `doPost` web app → `syncToSupabase()`. Env `SHEET_SYNC_URL`, `SHEET_SYNC_KEY`. The API fires, stops listening after 20s and polls `upfront_optin_sync_meta.last_run` (API ceiling is 60s; polling is the design, don't raise maxDuration). Accepts the SYNC_TRIGGER_KEY / CRON_SECRET / EMAIL_ADMIN_KEY trio.
- `deals.week` is the Sunday anchor. `deals.manager` is dead ('Unassigned' since Aug 16 2026); managers are re-resolved in app.
- `deal_type`: the sheet writes "presale" lowercase; the old sync compared `=== 'Presale'`, so ~2,300 presales were stored Standard. `rep-sales-sync.gs` now lowercases (pasting it into the sheet's script editor and re-running is required; status of that redeploy is unconfirmed). Reliable presale tell: `install_date` is a day-after-sale payment placeholder and does not land within 7 days of `planned_install`. Lyte "ghost presales" = Pending with no install date (see metrics).
- The deals `adders` field IS the internal notes column; Glo, SLIC, Cityside, Bluepeak and Lyte put the cancel reason there (Ezee, TDS, i3, GFiber, Omni do not). The sheet's deals tab never shows in the Drive export and the Apps Script hardcodes `cancel_reason ''`.
- `#Ref!` rep rows exist (e.g. 24 Lyte/GFiber deals in Sep 2026, probably Jace Wagstaff); counted in company totals as `errSales`.
- i3 deals are street-only (100% blank city), SLIC ~49% blank. `scripts/city-overlay.py` joins street+state to the SalesRabbit crawl address book and writes `report_config.__city_overlay__` {STATE|STREETKEY: CITY}; client fills blank `d.city` at load (JS key must mirror the python normaliser incl. suffix map). Re-run after lead imports. Unmatched/address-less i3 deals carry ~85% cancel rates.
- ISPs report at different cadences; cadence is observed from the feed, never hard-coded (weekly reporters seen Sep 2026: Glo, Surf, SLIC, Omni, Cityside, Lyte; daily: Ezee, TDS, Bluepeak, i3).
- 1,583 deals once sat Pending with a real install date; status always wins in UI, with an amber "Installed <date> · update status" chip (`window._needsStatusUpdate(i)`), `window._dealLane(i)` is the single lane rule.

## Sequifi (payroll/onboarding, `grow.sequifi.com`)

- Marketplace API `https://marketplace-api.sequifi.com/v1/...`, `Authorization: Bearer <access token>`. The access token is used as-is even though it looks like `iv_hex:authtag_hex:ciphertext_hex`; no decrypt step. Tokens: access ~24h in the SequifiAPI project's `token.txt` / `refresh_token.txt` (renew `POST /v1/auth/refreshToken`); the long-lived token used by syncs expires ~60 days. Do NOT put the `x-marketplace-auth` envelope (mislabeled `SEQUIFI_API_KEY` in `.env`) into `token.txt`. Marketplace secrets `MARKETPLACE_PRIVATE_KEY`, `CLIENT_ID`, `CLIENT_SECRET` come from env only. Verify: `TOKEN=$(tr -d '[:space:]' < token.txt); curl -s -H "Authorization: Bearer $TOKEN" 'https://marketplace-api.sequifi.com/v1/users?per_page=1'`.
- Routes: `/v1/users` (+`/{id}`, nested `manager` and `recruiter` objects), `/v1/offices`, `/v1/positions`, `/v1/payroll`, `/v1/sales`, `/v1/teams`, `/v1/users/teams`, `/v1/documents` (+`/{id}/download`), `/v1/auth/refreshToken`. Unrouted paths answer API Gateway 403 ("Missing Authentication Token" / "Invalid key=value pair"), real paths answer 401 JSON. `swagger.yaml` is stale; trust the live API. Probe: `scripts/probe-sequifi-teams.mjs`.
- `/v1/teams?per_page=100&effective_date=YYYY-MM-DD`: weekly roster (team_name, type lead, start/end_date Sunday..Saturday, team_manager, team_members[]). History from 2026-08-02, real from 08-09; ~40 to 56 people/week across 6 to 11 teams. Uses LEGAL names (Benjamin/Ben Ogara, Nathan/Nate Boyd, Samantha/Sammi Boyd, Thomas/TJ Becker, Angel/Krispy Rebollar, Richard/Trey Neal, Tabeitha/Tabitha Uberti). team_name can lag start_date ("Sep 13" teams stored under week 2026-09-20).
- `/v1/documents`: filters user_id, user_id_from (users vs onboarding_employees), source, document_type_id, updated_since; `/download` returns a short-lived presigned S3 URL (fetch immediately). Path `/v1/documents/{id}` without `/download` gives a spurious AWS 403. Types: esign (Offer Letter, Full Agreement, W9), manual (Driver's License Front/Back, Headshot), photo (Profile Photo).
- `/v1/payroll` (per_page=100): status/is_mark_paid/finalize_status flags say nothing about disbursement; only pay_period dates are usable. Sequifi pay periods are Sun to Sat.
- Vercel `SEQUIFI_TOKEN` is Sensitive and went stale Sep 8 2026 while the human's copy worked; when the sync 401s, re-set the var. The same token is duplicated in the onboarding Apps Script; update both.
- Sequifi does not model a manager hierarchy beyond the per-user `manager` field and offices ("X Region", "Blitz #n").
- `/v1/users` (~515) is every user ever, not the active roster.
- **Local token (Oct 21 2026): `data/.sequifi-token` does not exist on disk**, so local Sequifi scripts cannot call the API; the Vercel cron (`sequifi-sync`) writes `rep_onboarding` (employee_id + email) and that mirror is the practical source for identity work. `sequifi-sync` does NOT write deals; deals come from the Rep Sales sheet.

### Onboarding automation (Apps Script, outside this repo)

- "Automated Onboarding" `processNewHires`, Apps Script bound to the "Grow Marketing - Onboarding (Responses)" sheet (`1gURmag2y2Cmzqw1nI-hKEaP7-hZPACfU1K5LuAIEhdA`), 15-min trigger, live since 2026-07-16. A source copy `onboarding_sync.gs` was in the SequifiAPI folder, but the live script may differ (no version history).
- Per new Sequifi rep (created after GO_LIVE_DATE, onboarding_complete==1, all 3 docs): downloads headshot + DL front/back into the form's file folders, inserts a row at the bottom of "Form Responses 1", posts to Pronto, emails rep (Bria setup link tinyurl.com/GrowBria, signed URL expires 2027-07-15) and recruiter via GmailApp from the authorising Workspace account (optional `EMAIL_FROM_ALIAS`). Twilio SMS code is dormant (A2P 10DLC kept rejecting; email chosen).
- Traps: dedupe is `PROCESSED_IDS` + "email already in sheet"; the email path marks processed WITHOUT syncing docs, so any manually filled row permanently suppresses that rep's document download (13 reps affected Aug 2026). Never fix by deleting rows: manual rows hold guardian info, legal name, SSN4, shirt size; minors are in this data. Repair blank cells in place.
- All four alert paths posted to Pronto bubble 5635803, which was deleted Aug 2026 after unthrottled spam; `sendPronto_` only checks 401 so 404s vanish. **There is no working alerting on this pipeline.**
- Not automated: SSN, guardian info, Pronto user creation, badge packets, offboarding.

## Pronto (team chat, grow.pronto.io)

- No official API; the integration reuses a browser-session Bearer token (`api_token` cookie value, captured from DevTools) posting as the previous owner's account. `POST https://grow.pronto.io/api/v1/message.create` with `{bubble_id, message, user_id, uuid (fresh UUIDv4, dedup key), created_at, id:null, messagemedia:[]}`. Works server-side with only the Bearer.
- Channel ids (Jul 2026): Onboarding 5635803 (deleted Aug 2026), ezee-experts 5267164, i3-icons 5355884, lyte-legends 5267163, tds-trojans 5533636, glo-gangsters 5267162, chicago-ezee 5480039.
- Pronto sync (`api/pronto-sync.js`, bookmarklet in `api/PRONTO_SETUP.md`, `pronto_messages`, `pronto_sync_meta`) and `api/pronto-post.js` existed; **the Sep 10 2026 deploy shipped deletions of `api/pronto-*.js`** (and `ask.js`, `send-push.js`, `subscribe.js`). Treat Pronto sync as retired unless the files are present.

## SalesRabbit (Grow tenant, door knocking CRM)

- API `https://apis.salesrabbit.com`, Bearer token + `x-profile-id` lifted from the web app's own requests (captured by `node scripts/grow-sync.mjs --seed`, interactive, stored in `data/sr-auth.json`; expires every day or two).
- `GET /loci/es_search?fields=...&limit=100&page=N` door list; `GET /loci/<id>?fields[locus]=activity` full history; `GET /stages`, `/profiles`; `GET /imports?page[limit]=30&page[offset]=N` import batches with `flatfile_file_name`; `/areas` and `/groups` (see isp-pipeline.md). Verify deletions with `GET /loci/{id}` → 404.
- Lead imports go through Flatfile in the browser; no API path. Importer rejects xlsx (CSV only).
- Activity: `stage_updated` is a knock; `locus_created` = import, `locus_updated` usually System Geocoder, `assignee_updated` = reassignment. Counting all events triples numbers. Each stage change carries `distance` (metres rep→address).
- Lead export CSVs (`leads_export-*.csv`) have no lead id; never dedupe against exports.
- Grow tenant_id `ea339b66-e93a-432d-bdfc-f59bacb33ec4`; corporate group `26487a33-1850-4a75-b449-ff597fa37132`.

## SalesRabbit Amplify (SalesScreen reporting layer)

- UUID API keys work on no documented host; `api.amplify.salesrabbit.com` undocumented. Data only via the logged-in web app `app.amplify.salesrabbit.com`: `POST /Reports/Get` with the `__RequestVerificationToken` header, 20 rows/page fixed, ~5 to 8 req/s. Rep names `GET /User360/GetProfileInfo?userId=`. `/Navigation/Index` has disposition and origin maps. Events reference doors only by customerId (no addresses, no GPS).
- Grow account Lead Status report 9441; ids 215337 New Lead, 215361/215389/215386 Not Home 1/2/3, 215334 Not Interested, 215336 Call Back, 215385 Sold, 215695 Current Customer, 215739 Drop In Place. Account TZ Mountain.
- Grow Amplify knocking rows were deleted Jul 28 2026 (Time Track/crawl replaced them). Amplify now matters only for **TDS** (separate company, see knocking.md).
- Amplify event ids are one global sequence across companies.

## Opendoor RTR portal (Realtime Results SSRS reports)

One report host and Chrome profile (`.rtr-profile`) covers three ISPs, pulled by `scripts/rtr-sync.mjs` with config in `data/rtr-sources.json`:
- **Ezee** `/Ezee Fiber/Time_Track` (+ Highlight report for start/end; the plain Time_Track supplies the market tag from `BU_Level_3`, 2 renders per tick since Oct 1 2026). `Activity_Detail` has a hard floor of Aug 17 2026 (earlier dates return "no report loaded"); `Distance` there is FEET from the rep's phone to the address, `DistanceKnock`=1 past 500 ft (see knocking.md). Grow = Houston Contractor Team 5, Chicago Contractor Team 4, Detroit Contractor Team 1 (Ezee teams are "<Market> Internal/Contractor Team N", no company names). Also `/Ezee Fiber/Activity_Detail` (one row per knock for ALL of Ezee: BU_Level_2/3, Agent, Sales_ID, Disposition, Date_Submitted, House, Street, CalcCity/State/Zip, cust_misc1, Segment, Knock/Contact/Sale; params Start/End ctl03/ctl05, Division ctl07, Team ctl09, Agent ctl11, Disposition ctl13) and `/Ezee Fiber/Address_Snapshot` (last disposition per address). Paths only reachable by pasting `?Path=`.
- **Bluepeak** folder `/VastBroadband/Time_Track` (pre-rebrand). Live since 2026-08-18, backfilled 3/9 to 8/15/2026.
- **Omni Fiber** folder `/Omni Fiber/Time_Track` (with the space). Live since 2026-08-21, data floor 5/11/2026. Grow's Omni activity stopped 2026-08-07.
- `hub.realtimeresults.com` (Record Lookup) uses an expiring login; the report host stays signed in. SSO expiry = rtr-sync exit 3; only a human can renew.

## TDS (separate company)

TDS has its own Amplify login and its own SalesRabbit tenant on the OLD platform (`web.salesrabbit.com`, `capi.salesrabbit.com/v1`, account 301657 "TDS Telecommunications LLC", our login profile 886 "Grow Marketing Main User 2"). See knocking.md and isp-pipeline.md.

## MBS (Surf's CDG billing portal)

MBS = CDG Portal behind Surf (`surfinternet.cdgportal.com`, company 0160), Okta SSO; opens as a popup but any Chrome tab in the same profile shares the session, so Claude in Chrome can drive it. Customer Care > Subscribers search takes a street address ("406 KOERNER") or last name; Match Type "Service Address" / "Subscriber Address" are the real hits, "Service ID / Account ID / Guarantor ID" rows are fuzzy junk. A row's `onmouseup` loads the Services grid; Status "Active" + Date = installed, inactive subscriber with 0 services = cancelled order. Gotchas: Match Type text uses a non-breaking space (regex `\s+`); address search catches neighbours (236 vs 234, 155 N vs 155 S), so confirm house number + street + name or a date after the sale; Enter in the search box does nothing (click the form's submit button); a `beforeunload` guard must be nulled before reload. On-command only, no cron (~2s per lookup via `javascript_tool`); port to a Playwright script with a persistent profile like `tds-sr-sync` if it becomes recurring. Oct 16 2026 audit of 128 cancelled Surf deals (Braidwood/Wilmington/Rock Falls/Sterling, Sep 21 onward): only Codi Rawls (10-06) and Nick Gornik (10-12) installed, both had already replied "installed"; 37 addresses had an older Surf customer already active.

## TDS cancel report

"Grow Cancel Report.xlsx" emailed by TDS: the only source of TDS phone, email, order number and cancel reason. Import via `callback-import.mjs --isp TDS`; see isp-pipeline.md.

## Other vendors

- **Terros** (door CRM used for some leads): API key in `~/.terros.env` on the old Mac, header `Authorization: ApiKey <key>`, all endpoints POST. `scripts/geocode-file.mjs --terros --rep "Name"` then `scripts/push-to-terros.mjs`: `/import/add` (entity=Account, disableGeocoding=true, addMissingUsers=false, createCustomLocations=true) → PUT CSV to S3 URL → poll `/import/get` → `/import/errors`; undo with `/import/cleanup`. Rep name→userId via `/user/list` cached in `data/terros-reps.json` (companyId `C.DAOJaKdk`); assignment goes in `owner`; good field set street, city, state, zip, latitude, longitude, owner, stage=Lead. Manual by design (terros-import skill).
- **Geocodio** ($1/1k, 2,500/day free) key in `~/.geocodio.env`. Beat Smarty (88.9% vs 76% rooftop). Bad pins come from bad source addresses; judge by `accuracy_type`, not suffix rewrites. `~/Downloads` was TCC-blocked; copy files into `data/` first.
- **Gmail SMTP** (`GMAIL_USER`, `GMAIL_APP_PASSWORD`) sends the weekly emails and email-login codes, the local crawler failure emails (`alert-email.py`, creds in `.env.prod`), and the same mailbox is read (IMAP) by `mail-leads-pull.py`. All tied to the owner's Workspace account.
- **Google Drive** for ISP workbooks, raw lead archives, audit sheets.
