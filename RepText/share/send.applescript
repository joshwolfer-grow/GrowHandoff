-- Sends one text through the Messages app.
-- usage: osascript send.applescript <phone> <message> <iMessage|SMS>
on run {targetPhone, msg, svc}
	tell application "Messages"
		if svc is "SMS" then
			set targetAccount to 1st account whose service type = SMS
		else
			set targetAccount to 1st account whose service type = iMessage
		end if
		set targetParticipant to participant targetPhone of targetAccount
		send msg to targetParticipant
	end tell
end run
