# Before you leave: the previous owner's checklist

Things only Josh can do, because they need his logins. Most of them stop
working, or become impossible, the day his Google Workspace account is
suspended. Work top to bottom. Do the starred items first.

## 1. Secrets into a shared password manager ★

Most production values **cannot be read back** from Vercel. They are marked
Sensitive, and the local `.env.prod` / `.env.local` copies are blank. If they
are not saved somewhere before you go, the successor has to rotate every one.

Create a shared vault (1Password / Bitwarden, company-owned) and save:

| Where it lives now | Names |
|---|---|
| Vercel project env (copy from wherever you first got each value) | SUPABASE_SERVICE_KEY, CRON_SECRET, SYNC_TRIGGER_KEY, SEQUIFI_TOKEN, BRIA_SUPABASE_PUBLISHABLE_KEY, BRIA_SUPABASE_READONLY_KEY, GMAIL_APP_PASSWORD, EMAIL_ADMIN_KEY, SHEET_SYNC_KEY, SHEET_SYNC_URL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, PUSH_AUTH_KEY, META_APP_SECRET, META_PAGE_TOKEN, META_VERIFY_TOKEN, RECRUIT_INTAKE_KEY |
| `GrowSales/.env.local`, `.env.prod`, `.env.bria`, `.env.install-slots` | SALESRABBIT_API_KEY, SR_ACCOUNT_KEY, SR_SALESRABBIT_KEY, GMAIL_USER, GMAIL_APP_PASSWORD, BRIA_*, SURF_USER_ID, SURF_PIN |
| `GrowSales/data/.sector-map-key` | sector_maps write key |
| `~/.geocodio.env`, `~/.terros.env` | GEOCODIO_API_KEY, TERROS_API_KEY |
| `~/Grow/RepText/.env` | GROW_ACCESS_CODE |
| `~/Grow/TrainingVideos/.env` | PEXELS_API_KEY, GEMINI_API_KEY |
| `~/Grow/WolfOffice/.env` (if WolfOffice is kept) | OFFICE_SUPABASE_URL, OFFICE_SERVICE_KEY |
| Apps Script > Project Settings > Script Properties (each script) | SUPABASE_KEY, WEB_TRIGGER_KEY, the onboarding script's Sequifi token |

Login-session files (`data/sr-auth*.json`, browser profiles) do **not** go in
the vault. They are tied to your login and the successor re-creates them with
their own (`bash bootstrap.sh logins`).

## 2. Account ownership ★

| Account | Today | Do this |
|---|---|---|
| **Supabase** org "josh.wolfer@growmarketing.biz's Org" (Grow Sales `cmkfohwbejcztctrpdnt`, Wolf Office `hydnqquciomyfuntavhr`) | Owned by you | Invite the successor as **Owner**, rename the org to something like "Grow", then remove yourself last |
| **Vercel** team `joshwolfer-8879s-projects`, project serving growsales.vercel.app | Owned by you | Invite successor as **Owner**, rename the team, remove yourself last. (Your personal Vercel account cannot see it; use the work login) |
| **GitHub** `joshwolfer-grow` | Your account | Push the handoff repo there (or to a company org) and **transfer** it to the successor or the org: Settings > Transfer |
| **Google Apps Script** (Rep Sales sync, master-pay-sync, roster-sync, timetrack-backfill, "Automated Onboarding" `processNewHires`) | Run as you; **triggers die when your account is suspended** | Share each bound Sheet with the successor as Editor, have them make a copy or transfer ownership, recreate the time triggers under their account, redeploy the Rep Sales web app as them (its URL changes, so update `SHEET_SYNC_URL` in Vercel). **Export the onboarding script source into `GrowSales/scripts/`**: it exists nowhere else |
| **Google Drive** shared drive "Grow - Corporate" | Member | Make sure the successor is a member (Content manager) |
| **Gmail**: login codes, rep emails, and ISP lead intake all use your mailbox and app password | Yours | Create a shared mailbox (e.g. reports@growmarketing.biz) + app password, put it in Vercel `GMAIL_USER`/`GMAIL_APP_PASSWORD` and `.env.prod`, tell ISPs / Daxton / Nick the new address, then revoke your app password |
| **Sequifi** API token (~60-day expiry) | Your admin seat | Successor needs an admin seat and mints their own token. Update Vercel `SEQUIFI_TOKEN` and the onboarding script property |
| **SalesRabbit** (main + TDS tenant), **Amplify**, **Opendoor/RTR** portals (Ezee, Bluepeak, Omni), **Surf** portal | Your logins | Ask each admin / ISP contact to issue the successor a seat |
| **Bria** (new) read-only key | Company-to-company | Tell the Bria owner who the new contact is |
| **Canva** (training decks, meeting deck, T-Fiber guide) | Your seat | Move designs and folders to a company Canva team, add the successor |
| **Terros**, **Geocodio**, **Pexels**, **Gemini** keys | Issued to you | Successor gets their own (Terros via its admin) |
| **Meta** lead-ads page token (Recruiting board) | Whoever connected the Page | Re-auth under a company Business Manager admin |
| **Claude** connectors (Supabase, Canva, Chrome) and the claude.ai skills `grow-training-deck`, `leads-dedup` | Your Claude account | Skills are already copied into this repo. Successor connects their own connectors |

## 3. Decide two jobs that send as you ★

- **mgrcards** (the 9 AM "Daily Report: <Manager>" texts) sends from **your
  iMessage**, needs hand-made group chats, and has never delivered reliably.
  Pick one: retire it, or have the successor rebuild it on their own Apple ID.
  Either way, **unload it on your Mac on your last day** (step 6) so it stops
  trying to text from your number.
- **mail-leads** reads **your** inbox. It moves to the shared mailbox in step 2.

## 4. Get the code current

    bash ~/Grow/GrowHandoff/handoff/build-from-live.sh     # refresh from live, runs the secret scan
    cd ~/Grow/GrowHandoff && git add -A && git commit -m "Refresh from live"

Also ask Claude to "refresh docs/knowledge from my memory": anything learned
since Oct 1 2026 is only in your Claude memory until then.

## 5. Hand over the data

    bash ~/Grow/GrowHandoff/handoff/pack-data.sh           # ~/Desktop/grow-data-<date>.tar.gz

AirDrop it, or use a **restricted** Drive link (it holds customer addresses).
TrainingVideos footage/assets/work/output (~9 GB): copy the folders to a
shared Drive folder.

## 6. Last day, after the successor's `bootstrap.sh verify` is green

- Rotate the corporate dashboard access code: the current one is in your
  `~/Library/Logs/wolfoffice/mgrcards.log` in plain text. Revoke your own
  access codes in Admin > Access.
- Rotate `CRON_SECRET`, `SYNC_TRIGGER_KEY`, `EMAIL_ADMIN_KEY` once the
  successor holds the vault.
- Stop your Mac's jobs so two machines aren't crawling at once:

      bash ~/Grow/GrowSales/scripts/install-all-agents.sh --remove
      for p in ~/Library/LaunchAgents/com.wolfoffice.*.plist; do launchctl unload "$p"; done

- Revoke your Gmail app password and SalesRabbit tokens; remove yourself from
  Supabase, Vercel, GitHub last.
