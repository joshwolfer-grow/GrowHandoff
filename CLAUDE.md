# Grow operations

This repo is everything that runs Grow's sales reporting and field ops, handed
over from the previous owner (Josh) in October 2026. It is cloned to `~/Grow`.

| Folder | What it is |
|---|---|
| `GrowSales/` | The dashboard (growsales.vercel.app: `index.html` + `api/` on Vercel), every sync and import script (`scripts/`), launchd job templates. **Most work happens here.** Read `GrowSales/CLAUDE.md` before touching it |
| `WolfOffice/` | Optional status layer: Grow "workers" that snapshot the data each morning, an office UI on localhost:8787, the 9 AM manager texts. The syncs run fine without it. See `WolfOffice/README.md` |
| `RepText/` | AppleScript + Python that sends bulk iMessages to reps from this Mac's Messages account |
| `TrainingVideos/` | ffmpeg + whisper pipeline for training videos (`PIPELINE.md`). Footage lives on Drive, not in git |
| `docs/knowledge/` | **How everything works and why.** Start at `docs/knowledge/README.md` |
| `.claude/skills/` | The Grow skills (ISP lead files, Time Track, cancel lists, Terros, Sequifi roster check, training decks, leads dedupe) |
| `bootstrap.sh`, `HANDOFF.md` | Setting up a new Mac |

## First session on a new Mac

If `bash bootstrap.sh verify` has never passed on this machine, setup is not
done. Walk the user through `HANDOFF.md` one step at a time: run each
`bootstrap.sh` step yourself, explain what it found, and stop at anything that
needs their login or a value from the password manager.

## Before any task

1. Read `docs/knowledge/README.md` and the topic files it points to for the task.
   They hold the definitions (PRA, install rate, Sunday-anchored weeks, who
   counts as a sub), the per-ISP quirks and the traps that already cost real
   time. Do not re-derive a definition that is written down there.
2. For anything in `GrowSales/`, follow `GrowSales/CLAUDE.md`.
3. If a skill in `.claude/skills/` covers the task (an ISP file arrived, a
   Time Track export, a cancel list, a schedule to check against Sequifi),
   use the skill.

## House rules

- **Keep knowledge in the repo, not in private memory.** When you learn
  something durable (a new quirk, a changed process, a decision and its
  reason), add it to the right file in `docs/knowledge/` and commit it. Private
  Claude memory dies with the laptop or the account. That is the exact problem
  this repo was built to fix.
- Never commit secrets. Values live in the company password manager and in
  gitignored `.env*` files; `GrowSales/.env.example` lists the names. Run
  `bash handoff/scan-secrets.sh` before a commit that touches config.
- Confirm before deleting or rolling back live data (Supabase rows, SalesRabbit
  leads, imports). "Do whatever you need" is not permission to delete.
- Deploy the dashboard with `cd ~/Grow/GrowSales && vercel --prod`. Commit
  and push first, because the deploy ships whatever is on disk.
- No dashes in UI or digest copy, and keep the UI minimal: no helper text,
  aligned columns. More in `docs/knowledge/user-preferences.md`.
- Weeks are Sunday-anchored everywhere.
