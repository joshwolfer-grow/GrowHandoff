-- Send a plain text to one phone number.
--   osascript send-text.applescript <phone> <message>
on run argv
	set targetPhone to item 1 of argv
	set msg to item 2 of argv
	tell application "Messages"
		set targetService to 1st account whose service type = iMessage
		send msg to participant targetPhone of targetService
	end tell
end run
