/**
 * The chat widget's stylesheet, scoped to its shadow root. The colour the
 * organization picked comes in as `--arsel-chat-primary`, set on the host.
 */

const MOBILE_BREAKPOINT_PX = 480;

let sheet: CSSStyleSheet | null = null;

/**
 * A constructed stylesheet rather than a `<style>` element wherever possible:
 * a `<style>` inside a shadow root is governed by the host page's
 * `style-src`, a constructed sheet is not. The fallback stays for browsers
 * without `adoptedStyleSheets`, and is the branch most test DOMs take.
 */
export function applyChatStyles(root: ShadowRoot): void {
  if ('adoptedStyleSheets' in Document.prototype && typeof CSSStyleSheet === 'function') {
    try {
      sheet ??= buildSheet();
      root.adoptedStyleSheets = [sheet];
      return;
    } catch {
      // Constructable stylesheets unavailable despite the feature test.
    }
  }
  const style = document.createElement('style');
  style.textContent = CSS_TEXT;
  root.append(style);
}

function buildSheet(): CSSStyleSheet {
  const constructed = new CSSStyleSheet();
  constructed.replaceSync(CSS_TEXT);
  return constructed;
}

const CSS_TEXT = `
:host {
  all: initial;
  position: fixed;
  inset-block-end: 20px;
  inset-inline-end: 20px;
  display: block;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans Arabic", sans-serif;
  font-size: 15px;
  line-height: 1.45;
  color: #0f172a;
  --arsel-chat-primary: #2563eb;
}
:host([data-position="left"]) { inset-inline-end: auto; inset-inline-start: 20px; }
*, *::before, *::after { box-sizing: border-box; }
button { font: inherit; cursor: pointer; }
.launcher {
  position: relative;
  width: 56px; height: 56px;
  border: 0; border-radius: 50%;
  background: var(--arsel-chat-primary); color: #fff;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.25);
  display: grid; place-items: center;
  transition: transform 120ms ease;
}
.launcher:hover { transform: scale(1.05); }
.launcher:focus-visible { outline: 3px solid #fff; outline-offset: 2px; box-shadow: 0 0 0 5px var(--arsel-chat-primary); }
.badge {
  position: absolute; inset-block-start: -4px; inset-inline-end: -4px;
  min-width: 22px; height: 22px; padding: 0 6px;
  border-radius: 11px; background: #dc2626; color: #fff;
  font-size: 12px; font-weight: 600; line-height: 22px; text-align: center;
}
.teaser {
  position: absolute; inset-block-end: 68px; inset-inline-end: 0;
  max-width: 280px; padding: 12px 14px;
  background: #fff; color: #0f172a; border-radius: 14px;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.18);
  cursor: pointer; font-size: 14px;
}
:host([data-position="left"]) .teaser { inset-inline-end: auto; inset-inline-start: 0; }
.window {
  position: absolute; inset-block-end: 72px; inset-inline-end: 0;
  width: 380px; max-width: calc(100vw - 40px); height: 560px; max-height: calc(100vh - 112px);
  display: none; flex-direction: column;
  background: #fff; border-radius: 16px; overflow: hidden;
  box-shadow: 0 16px 48px rgba(15, 23, 42, 0.25);
}
:host([data-position="left"]) .window { inset-inline-end: auto; inset-inline-start: 0; }
:host(.open) .window { display: flex; }
.header {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 14px 16px; background: var(--arsel-chat-primary); color: #fff;
}
.titles { display: flex; flex-direction: column; min-width: 0; }
.title { font-weight: 600; font-size: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.presence { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; opacity: 0.9; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #94a3b8; }
.dot.online { background: #22c55e; }
.close {
  width: 36px; height: 36px; border: 0; border-radius: 50%;
  background: rgba(255, 255, 255, 0.18); color: #fff; font-size: 22px; line-height: 1;
}
.close:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.log {
  flex: 1; overflow-y: auto; padding: 16px;
  display: flex; flex-direction: column; gap: 10px; background: #f8fafc;
}
.bubble { display: flex; flex-direction: column; gap: 2px; max-width: 85%; }
.bubble.team { align-self: flex-start; }
.bubble.you { align-self: flex-end; }
.who { font-size: 11px; color: #64748b; padding: 0 4px; }
.body {
  margin: 0; padding: 10px 14px; border-radius: 16px;
  white-space: pre-wrap; overflow-wrap: anywhere;
  background: #fff; color: #0f172a; box-shadow: 0 1px 2px rgba(15, 23, 42, 0.08);
}
.body a { color: var(--arsel-chat-primary); text-decoration: underline; }
.bubble.you .body a { color: inherit; }
.bubble.team .body { border-start-start-radius: 4px; }
.bubble.you .body { background: var(--arsel-chat-primary); color: #fff; border-start-end-radius: 4px; }
.bubble.pending .body { opacity: 0.6; }
.bubble.failed .body { background: #fee2e2; color: #991b1b; }
.retry { align-self: flex-end; border: 0; background: none; color: #991b1b; font-size: 12px; text-decoration: underline; padding: 2px 4px; }
.notice { align-self: center; font-size: 13px; color: #475569; text-align: center; padding: 4px 8px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px 0 2px; }
.chip {
  border: 1px solid var(--arsel-chat-primary); border-radius: 999px; padding: 6px 12px;
  background: #fff; color: var(--arsel-chat-primary); font-size: 14px; font-weight: 500;
}
.chip:hover { background: var(--arsel-chat-primary); color: #fff; }
.chip:focus-visible { outline: 2px solid var(--arsel-chat-primary); outline-offset: 2px; }
.links { display: flex; flex-direction: column; gap: 6px; padding: 6px 0 2px; }
.link {
  display: block; padding: 8px 12px; border-radius: 10px; text-align: center;
  background: #fff; color: var(--arsel-chat-primary); font-size: 14px; font-weight: 600;
  text-decoration: none; border: 1px solid #e2e8f0;
}
.link:hover { border-color: var(--arsel-chat-primary); }
.dots { display: inline-flex; gap: 4px; align-items: center; min-height: 40px; }
.dots span { width: 7px; height: 7px; border-radius: 50%; background: #94a3b8; animation: arsel-chat-dot 1.2s infinite ease-in-out; }
.dots span:nth-child(2) { animation-delay: 0.2s; }
.dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes arsel-chat-dot { 0%, 80%, 100% { opacity: 0.3; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-3px); } }
@media (prefers-reduced-motion: reduce) { .dots span { animation: none; opacity: 0.6; } }
.lead { padding: 12px 16px; border-top: 1px solid #e2e8f0; display: flex; flex-direction: column; gap: 8px; background: #fff; }
.lead .intro { margin: 0; font-size: 14px; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: #334155; }
.field input, .input {
  font: inherit; padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 10px; color: #0f172a; background: #fff;
}
.field input:focus, .input:focus { outline: 2px solid var(--arsel-chat-primary); outline-offset: 1px; border-color: transparent; }
.consent { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; color: #334155; }
.consent input { margin-block-start: 3px; }
.error { margin: 0; min-height: 1em; font-size: 12px; color: #b91c1c; }
.actions { display: flex; gap: 8px; }
.submit { border: 0; border-radius: 10px; padding: 8px 14px; background: var(--arsel-chat-primary); color: #fff; font-weight: 600; }
.skip { border: 0; border-radius: 10px; padding: 8px 14px; background: #f1f5f9; color: #334155; }
.composer { display: flex; align-items: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid #e2e8f0; background: #fff; }
.input { flex: 1; resize: none; min-height: 40px; max-height: 120px; }
.send { border: 0; border-radius: 10px; padding: 10px 16px; background: var(--arsel-chat-primary); color: #fff; font-weight: 600; min-height: 40px; }
.send:focus-visible, .submit:focus-visible, .skip:focus-visible, .retry:focus-visible, .link:focus-visible { outline: 2px solid var(--arsel-chat-primary); outline-offset: 2px; }
.powered { padding: 6px 16px 10px; font-size: 11px; color: #94a3b8; text-align: center; background: #fff; }
.powered a { color: inherit; text-decoration: underline; }
[hidden] { display: none !important; }
@media (max-width: ${MOBILE_BREAKPOINT_PX}px) {
  :host(.open) { inset: 0; }
  :host(.open) .launcher, :host(.open) .teaser { display: none; }
  .window { position: fixed; inset: 0; width: auto; max-width: none; height: auto; max-height: none; border-radius: 0; }
}
`;
