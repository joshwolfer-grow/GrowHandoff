-- Send an image (and optional text) to one or more people as a group thread.
--   osascript paste-group.applescript "+1555...,+1555..." <posix png> [message]
--
-- Two macOS 26 facts shape this:
--   1. Script-sent attachments are refused (iMessage error 25, SMS error 4), so
--      the card is pasted the way a person pastes it.
--   2. The chat list is SwiftUI and not scriptable, so an existing group cannot
--      be selected by name. Composing to the same set of people lands in the
--      same group thread anyway, which is what we want.
-- The caller confirms the result against chat.db; this script cannot.
on run argv
	set recips to item 1 of argv
	set imgPath to item 2 of argv
	set msg to ""
	if (count of argv) > 2 then set msg to item 3 of argv

	set AppleScript's text item delimiters to ","
	set recipList to text items of recips
	set AppleScript's text item delimiters to ""

	set the clipboard to (read (POSIX file imgPath) as «class PNGf»)

	tell application "Messages" to activate
	tell application "System Events"
		set tries to 0
		repeat until (name of first process whose frontmost is true) is "Messages"
			delay 0.4
			set tries to tries + 1
			if tries > 15 then error "Messages would not come to the front"
		end repeat

		tell process "Messages"
			keystroke "n" using command down
			delay 1.5
			repeat with r in recipList
				keystroke (r as text)
				delay 1.2
				key code 36 -- Return commits the recipient token
				delay 0.8
			end repeat
			if msg is not "" then
				keystroke msg
				delay 0.6
				key code 36
				delay 1.5
			end if
			keystroke "v" using command down
			delay 1.8
			key code 36
		end tell
	end tell
	delay 1
	return "sent"
end run
