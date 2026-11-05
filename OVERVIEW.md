Usage Auto Resume asks the same Codex, Claude, Antigravity, or OpenCode agent to continue its unfinished work once a usage limit resets, so you don't have to come back just to send "continue". For Codex and Claude it first checks that your subscription has usage left. Antigravity also checks the model's quota when available, and otherwise follows the limit message. For OpenCode, Go checks its usage windows, and free models wait for the reset OpenCode recorded with the free-usage limit.

The Auto Resume screen in the sidebar lists upcoming resumes by day, with their conversation, provider and workspace. Skip a resume, delay it, pick another time, add instructions for that continue, or turn every shown resume off at once. Recent activity shows how resumes ended over the last 24 hours. A conversation with a resume also gets an Auto Resume button next to its message box, to manage it in place or resume right away when a limit lifts early.

In the plugin's settings you can choose which providers are resumed and change the message sent to the agent.

## Setup

Requires Paseo daemon and app 0.11.0 or later, plugins enabled, the provider CLI signed in on the daemon host, and the host kept awake. OpenCode 2.2.2 or later is required for OpenCode agents. Agents billed through an API key or another billing route are not resumed.

Sending your own message to an agent, or archiving it, cancels its resume, as does the agent waiting for permission when the resume is due.

## Your data

The plugin reads agent state, recent limit messages, provider CLI sign-ins and OpenCode's local database on the daemon host. Usage checks contact the provider's account service without using model turns. Sign-in tokens and OpenCode's Go key are never saved or logged. Reservations, extra instructions and a changed continue message are stored on the daemon host; extra instructions are deleted once sent. The continue message reaches your existing agent through Paseo, like a message you send yourself.
