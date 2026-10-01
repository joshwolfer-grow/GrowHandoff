-- Send an image to one phone number by pasting it into Messages.
--   osascript paste-send.applescript <phone> <posix png path> [message]
--
-- Why not `send (POSIX file ...)`: macOS 26 refuses script-sent attachments
-- (iMessage error 25, SMS error 4) no matter where the file lives. Pasting is
-- what a person does, and it works. The caller checks chat.db afterwards to
-- confirm the attachment actually went, since this path cannot report failure.
on run argv
	set targetPhone to item 1 of argv
	set imgPath to item 2 of argv
	set msg to ""
	if (count of argv) > 2 then set msg to item 3 of argv

	set the clipboard to (read (POSIX file imgPath) as «class PNGf»)

	tell application "Messages" to activate
	-- Keystrokes go to whatever is frontmost, so never type until Messages is.
	tell application "System Events"
		set tries to 0
		repeat until (name of first process whose frontmost is true) is "Messages"
			delay 0.4
			set tries to tries + 1
			if tries > 15 then error "Messages would not come to the front"
		end repeat
	end tell

	open location "imessage://" & targetPhone
	delay 1.5

	tell application "System Events"
		tell process "Messages"
			keystroke "v" using command down
			delay 1.5
			key code 36 -- Return
		end tell
	end tell
	delay 1
	-- Text only after the paste went through, so a failed paste never leaves a
	-- caption with no card.
	if msg is not "" then
		tell application "Messages"
			set targetService to 1st account whose service type = iMessage
			send msg to participant targetPhone of targetService
		end tell
	end if
	return "pasted"
end run
