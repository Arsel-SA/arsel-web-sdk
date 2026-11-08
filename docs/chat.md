# Website chat

The chat widget your organization switches on in the Arsel dashboard, under **Chat → Widget**.
Once it is on, every page that runs the SDK shows the launcher; the dashboard's **Chat → Inbox**
is where your team answers.

## Install

Nothing beyond [the usual init](quickstart.md). The widget is part of the SDK and is on by default:

```js
import Arsel from '@arsel.sa/web-sdk';

await Arsel.init({ clientKey: 'pub_…', baseUrl: 'https://api.arsel.sa' });
```

Two things decide whether a page shows the widget:

1. **The dashboard switch.** Chat → Widget → *Show the widget on my website*. Off, the SDK makes
   one small config request per page view (cached for five minutes) and draws nothing.
2. **The allowed websites.** The origin the page is served from must be on the organization's
   list (Chat → Widget → Install, the same list web push uses). A page from another origin gets
   `403` and no widget.

To keep the widget off one page, or to move it above or below your own overlays:

```js
await Arsel.init({
  clientKey: 'pub_…',
  baseUrl: 'https://api.arsel.sa',
  chat: false,                  // or { zIndex: 1000 }
});
```

## What the visitor sees

- A launcher bubble at the bottom corner (left or right, as set in the dashboard), in the
  organization's colour, with an unread count while the window is closed.
- After the welcome delay, a small teaser with the welcome message next to the launcher.
- The window: the organization's name and whether the team is online or away, the thread, a
  composer. Enter sends, Shift+Enter breaks a line, Escape closes.
- When the team is away (outside the office hours set in Chat → Settings) the visitor's first
  message is answered at once with the outside-hours text, and a short form asks for an email so
  the team can reply later. The dashboard can also ask for an email before a human takes the
  conversation, or before the first message.
- Arabic or English, right to left or left to right, following the page's `lang` unless the
  dashboard pins a language.
- "Powered by Arsel" unless the organization's plan carries custom branding.
- **Typing and "Seen".** While a teammate writes, dots show under their first name. Once a
  teammate opens the conversation, the visitor's last line they read shows "Seen". The team sees
  the visitor typing in turn, and how far the visitor read.
- **Files.** Where Chat → Widget lets visitors send files, a paperclip beside the composer sends
  an image (JPEG, PNG, WebP, GIF) or a PDF, up to 10 MB. Images show in the thread; a PDF shows as
  a link that saves it. Teammates can send files the same way. Links to files last an hour; an
  image whose link ran out asks for a fresh one.
- **Rating.** When a teammate resolves a conversation they answered, the thread asks the visitor
  to rate it, from 1 to 5, with an optional comment. Switched off under Chat → Widget.
- **Proactive messages.** Messages set under Chat → Widget that show before the visitor writes:
  after some seconds on the page, or as the pointer leaves the page on a computer (exit intent),
  on every page or those whose address contains a given text, whatever the team's availability or
  only while it is in or away. Each shows as a teaser above the launcher, which the visitor can
  dismiss, or opens the window on it. One shows per page view at most, never while the visitor is
  chatting, and the same one no more than once a day, a week or a month on a browser, as set.
  When the visitor answers, the message is the conversation's first line in the team's inbox.
  All of this is decided in the browser from the cached config: proactive messages cost no
  request.

## Scenarios

The scenarios your organization builds under **Chat → Scenarios** answer in the widget before, or
instead of, a teammate:

- **Welcome buttons.** Up to five buttons under the welcome line, set under Chat → Widget. A tap
  sends the button's label and starts the scenario its key names. They go once the visitor has
  written.
- **Questions.** A scenario's question shows its answers as quick replies under the line. A tap
  sends the answer; typing it, or its number, works too. The replies go with the visitor's next
  line.
- **Links.** A line may carry up to three link buttons, and any `http(s)` URL in a line is a link.
  Both open in a new tab with `rel="noopener noreferrer"`.
- **Forms.** "Collect contact details" asks for the widget's form inline: the email, and the name or
  phone the step asks for. *Continue* submits it, and the visitor becomes a contact as with the
  offline form; *Skip* tells the scenario to move on. An email or phone typed instead of the form
  answers it too.
- **The bot's name.** Lines a scenario writes are labelled with the bot name set under Chat →
  Widget, or "Assistant" ("المساعد"). Each appears after a short typing pause.
- **Handing over.** When a scenario hands the visitor to the team, the thread goes on with the
  teammates. Outside office hours the widget shows the outside-hours text and, when the step asks
  for it, the form.

Everything renders in a closed shadow root on a host element the SDK appends to `<body>`: your
CSS cannot reach it and its CSS cannot reach your page. Text is set as text, never as markup.

## Identity

The visitor is this browser. The browser is registered with the organization on the visitor's
first message, unless in-app messaging already registered it on page load (it is the same
registration: no permission prompt, nothing shown). From then on the thread follows it: a
returning visitor sees their conversation and the team's replies land in it.

A visitor who gives an email or phone in the form, or whom your site identifies with
[`identify()`](identity.md), becomes that contact: the conversation and its history move to the
contact, and show on their page in the dashboard. `reset()` closes the thread for the next person
on the browser.

## Opening the chat from your own button

```js
document.querySelector('#contact-us').addEventListener('click', () => Arsel.openChat());
```

`openChat()` waits for the widget to load, so a button pressed right after `init()` opens it. Both
do nothing on a page without a widget.

## Network calls

All under your `baseUrl`, beside the push and events calls in the
[API reference](api-reference.md#network-calls):

| Call | Auth |
| --- | --- |
| `GET /api/v1/orgs/{clientKey}/chat/config` | none (public config) |
| `POST /api/v1/orgs/{clientKey}/chat/sessions` | `X-Arsel-Device-Auth` |
| `POST /api/v1/orgs/{clientKey}/chat/messages` | `X-Arsel-Device-Auth` |
| `GET /api/v1/orgs/{clientKey}/chat/messages` | `X-Arsel-Device-Auth` (catch-up and polling fallback) |
| `POST /api/v1/orgs/{clientKey}/chat/stream-ticket` | `X-Arsel-Device-Auth` |
| `GET /api/v1/orgs/{clientKey}/chat/stream?ticket=…` | single-use ticket (server-sent events) |
| `POST /api/v1/orgs/{clientKey}/chat/leads` | `X-Arsel-Device-Auth` |
| `POST /api/v1/orgs/{clientKey}/chat/typing` | `X-Arsel-Device-Auth` (at most every three seconds while typing) |
| `POST /api/v1/orgs/{clientKey}/chat/read` | `X-Arsel-Device-Auth` |
| `POST /api/v1/orgs/{clientKey}/chat/attachments?installationId=…` | `X-Arsel-Device-Auth` (multipart upload) |
| `GET /api/v1/orgs/{clientKey}/chat/attachment?installationId=…&id=…` | `X-Arsel-Device-Auth` (a fresh file link) |
| `POST /api/v1/orgs/{clientKey}/chat/ratings` | `X-Arsel-Device-Auth` |

Replies arrive over a server-sent events stream. Where `EventSource` is unavailable, or the stream
keeps failing, the widget polls for new lines every ten seconds instead, and every second and a
half for the fifteen seconds after each line the visitor sends, so a scenario's answer still lands
at once. CSP: `connect-src https://api.arsel.sa;` covers both. Files load from the organization's
storage through signed links, so a page with a strict CSP also needs that storage host in
`img-src` for images to show in the thread.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| No launcher | The widget is off in the dashboard, the page's origin is not on the allowed list, or `chat: false` was passed. `diagnostics()` shows the last response code and path. |
| Launcher, but sending fails | The origin was removed from the list after the page loaded, or the organization is over its monthly conversation allowance: the server answers `409 quota_exceeded`, the widget drops the line, shows the outside-hours text and asks for an address the team can answer later. |
| Replies arrive late | The stream could not open and the widget is polling. Check that your proxy does not buffer `text/event-stream` responses. |
| No paperclip | Files are off under Chat → Widget. A file the widget refuses says why under the composer: too big, not an image or a PDF, or too many this hour (20). |
| A proactive message never shows | It shows once per its days on a browser: a test browser that saw it already will not see it again until then. The address condition is a plain "contains", and exit intent needs a mouse or trackpad. |
