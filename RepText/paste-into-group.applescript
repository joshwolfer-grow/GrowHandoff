-- Paste an image into an EXISTING named group chat. Never composes a new one.
--   osascript paste-into-group.applescript "Daily Report: Will Gabor" <posix png>
--
-- The chat list is SwiftUI and cannot be clicked by script, so the group is
-- opened the way a person would: Cmd+F, type its name, open the match. Before
-- anything is pasted the open conversation's title must equal the group name,
-- otherwise it stops. The caller still confirms the send against chat.db.
on run argv
	set groupName to item 1 of argv
	set imgPath to item 2 of argv

	tell application "Messages" to activate
	tell application "System Events"
		set tries to 0
		repeat until (name of first process whose frontmost is true) is "Messages"
			delay 0.4
			set tries to tries + 1
			if tries > 15 then error "Messages would not come to the front"
		end repeat

		tell process "Messages"
			key code 53 -- Escape clears any open search
			delay 0.3
			keystroke "f" using command down
			delay 0.8
			keystroke "a" using command down
			keystroke groupName
			delay 2
			key code 125 -- Down: first conversation match
			delay 0.5
			key code 36 -- Return opens it
			delay 1.5

			set winTitle to ""
			try
				set winTitle to name of front window
			end try
			if winTitle is not groupName then
				key code 53
				error "Opened \"" & winTitle & "\" instead of \"" & groupName & "\". Nothing sent."
			end if
		end tell
	end tell

	set the clipboard to (read (POSIX file imgPath) as «class PNGf»)
	delay 0.3
	tell application "System Events"
		tell process "Messages"
			if (name of front window) is not groupName then error "Conversation changed before paste. Nothing sent."
			keystroke "v" using command down
			delay 1.8
			key code 36
		end tell
	end tell
	delay 1
	return "pasted"
end run
