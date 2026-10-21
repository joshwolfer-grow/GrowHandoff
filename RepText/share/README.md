# Text blast from your Mac

Sends one text per row of a spreadsheet from YOUR phone number, through the Messages app on your Mac. No account, no service, nothing to pay for.

## Setup (once)
1. Mac signed into Messages with your Apple ID (same one as your iPhone).
2. On the iPhone: Settings > Messages > Text Message Forwarding > turn on this Mac. That lets Android numbers get a green-bubble text.
3. Keep this folder together: send.py, send.applescript, list.csv.
4. First run will ask to let Terminal control Messages. Click OK.

## Build the list
Open list.csv in Numbers or Excel. Two columns are required: `name` and `phone`. Any extra column you add (say `deals`) can be dropped into the message as `{deals}`.

## Preview, then send
Open Terminal, drag the folder in after `cd`:

    cd /path/to/this/folder
    python3 send.py list.csv "Hey {first}, quick update from Grow..."

That prints every text it WOULD send and stops. When it looks right, add `--send`:

    python3 send.py list.csv "Hey {first}, quick update from Grow..." --send

Texts go out 12 seconds apart. Add `--sms` to force green-bubble texts. Leave the Mac awake and unlocked until it finishes. A sent-log.csv is written next to the script.

## Placeholders
`{first}` first name, `{name}` full name, `{anycolumn}` any column header in your CSV.

## If you have Claude
Open this folder in Claude Code and say what you want to send and to whom. CLAUDE.md in this folder tells it how to run the tool safely. It will always show you a preview and ask before sending.
