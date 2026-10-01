-- Send a picture (and optional text) to one phone number.
--   osascript send-image.applescript <phone> <posix image path> [message]
-- Messages drops files it can't reach from its sandbox without an error, so the
-- caller stages the image in ~/Pictures first.
on run argv
	set targetPhone to item 1 of argv
	set imgPath to item 2 of argv
	set msg to ""
	if (count of argv) > 2 then set msg to item 3 of argv
	tell application "Messages"
		set targetService to 1st account whose service type = iMessage
		set targetParticipant to participant targetPhone of targetService
		if msg is not "" then send msg to targetParticipant
		send (POSIX file imgPath) to targetParticipant
	end tell
end run
