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

Everything renders in a closed shadow root on a host element the SDK appends to `<body>`: your
CSS cannot reach it and its CSS cannot reach your page. Text is set as text, never as markup.

## Identity

The visitor is this browser. The first message registers the browser with the organization (the
same registration in-app messaging uses: no permission prompt, nothing shown) and from then on the
thread follows it: a returning visitor sees their conversation and the team's replies land in it.

A visitor who gives an email or phone in the form, or whom your site identifies with
[`identify()`](identity.md), becomes that contact: the conversation and its history move to the
contact, and show on their page in the dashboard. `reset()` closes the thread for the next person
on the browser.

## Opening the chat from your own button

```js
document.querySelector('#contact-us').addEventListener('click', () => Arsel.openChat());
```

`openChat()` and `closeChat()` do nothing on a page without a widget.

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

Replies arrive over a server-sent events stream. Where `EventSource` is unavailable, or the stream
keeps failing, the widget polls for new lines every ten seconds instead. CSP:
`connect-src https://api.arsel.sa;` covers both.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| No launcher | The widget is off in the dashboard, the page's origin is not on the allowed list, or `chat: false` was passed. `diagnostics()` shows the last response code and path. |
| Launcher, but sending fails | The origin was removed from the list after the page loaded, or the organization is over its monthly conversation allowance (the server answers `409 quota_exceeded`; the widget shows the offline form). |
| Replies arrive late | The stream could not open and the widget is polling. Check that your proxy does not buffer `text/event-stream` responses. |
