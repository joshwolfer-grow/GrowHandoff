# For Claude: driving this text blast tool

This folder sends one text per CSV row from the user's own phone number through the Messages app on this Mac. It is NOT a texting service. Nothing is signed up for, nothing is paid for, nothing leaves the Mac except the texts themselves.

## Files
- send.py: the driver. Python 3, standard library only. Preview by default.
- send.applescript: called by send.py once per row via osascript. Do not rewrite it; `send msg to participant` is the only form that works reliably.
- list.csv: the recipient list. Required columns `name` and `phone`. Any extra column becomes a `{placeholder}` in the message.
- sent-log.csv: appended after each send. Check it before re-running so nobody gets texted twice.

## How to run
    python3 send.py list.csv "Hey {first}, ..."          # preview, sends nothing
    python3 send.py list.csv "Hey {first}, ..." --send   # actually sends
    python3 send.py list.csv "..." --send --sms          # force SMS (green bubble)
    python3 send.py list.csv "..." --send --delay 15     # seconds between texts (default 12)

## Rules
1. Always run the preview first and show the user the full output. Never add `--send` until the user has read the preview and said to send. Do not infer permission from "do the blast"; show, then ask.
2. Send to the user's own number first as a one-row test before any real list.
3. Phone numbers must be US 10 digit. Rows that fail normalize() are printed as SKIP; tell the user which ones so they can fix the CSV.
4. Do not shorten the delay below 10 seconds. Apple rate limits and silently drops texts when they go faster. 500 texts is about 2 hours; plan for the Mac to stay awake and unlocked that whole time.
5. Deliveries are not confirmed by the script. "OK" means Messages accepted it, not that the phone received it. Reading delivery state needs chat.db and Full Disk Access; do not go there unless asked.
6. The first osascript call triggers a macOS prompt to let Terminal control Messages. If sends fail with error -1743 or "not allowed assistive access", the user must click OK on that prompt or grant it in System Settings > Privacy & Security > Automation. You cannot grant it for them.
7. Runs started from a background process (launchd, cron, an agent runner) get -1743. Run from a real Terminal window.
8. Text Message Forwarding must be on from the iPhone (Settings > Messages > Text Message Forwarding) or Android recipients fail with "participant not found". Suggest `--sms` when the list is mostly non-iPhone.
9. Images: Messages silently drops attachments from outside ~/Pictures. This bundle is text only; if the user wants an image, copy it into ~/Pictures first and say that the applescript needs a separate attachment send.
10. Group chats cannot be created by script. Per-row sends are individual threads, which is what a blast should be.

## Building the list
Accept whatever export the user has (Sequifi, a Google Sheet, Bria). Headers containing "phone" in any case are mapped to `phone`; everything else is lowercased. Produce a clean list.csv, show row count and any skipped rows, then preview.
