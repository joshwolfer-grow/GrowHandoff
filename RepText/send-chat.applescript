-- Send text, and optionally a picture, into an EXISTING chat (group or 1:1).
-- Messages can't create a group chat from a script, so the group is made once by
-- hand and found here by its guid.
--   osascript send-chat.applescript <chatGuid> <message> [posix image path]
on run argv
	set chatGuid to item 1 of argv
	set msg to item 2 of argv
	set imgPath to ""
	if (count of argv) > 2 then set imgPath to item 3 of argv
	tell application "Messages"
		set targetChat to a reference to chat id chatGuid
		if msg is not "" then send msg to targetChat
		if imgPath is not "" then send (POSIX file imgPath) to targetChat
	end tell
end run
