import type { ChatLocale } from './chat-strings';

/**
 * The chat widget's model: the widget as the server describes it, the
 * conversation's lines and the state the view draws. `chat.ts` keeps it,
 * `chat-view.ts` draws it.
 */

export type ChatPosition = 'right' | 'left';
export type ChatAskForEmail = 'never' | 'before_human' | 'always';

export interface ChatTexts {
  welcome: string;
  placeholder: string;
  outsideHours: string;
  offlineForm: string;
  leadConsent: string;
}

/** A button under the welcome bubble: tapping it sends its label and starts the scenario its key names. */
export interface ChatWelcomeOption {
  key: string;
  label: Record<ChatLocale, string>;
}

/** What the server says the widget looks and behaves like. */
export interface ChatWidgetConfig {
  name: string;
  primaryColor: string;
  position: ChatPosition;
  language: 'auto' | ChatLocale;
  askForEmail: ChatAskForEmail;
  welcomeDelaySeconds: number;
  collect: { name: boolean; phone: boolean };
  texts: Record<ChatLocale, ChatTexts>;
  /** How the scenarios' lines are labelled; unset shows the widget's own word. */
  botName?: string | null;
  welcomeOptions?: ChatWelcomeOption[];
  poweredBy: boolean;
  online: boolean;
}

export type ChatSenderKind = 'visitor' | 'agent' | 'bot' | 'system';

/** A quick reply under a bot's question. */
export interface ChatChoiceOption {
  key: string;
  label: string;
}

/** A link under a bot's line. */
export interface ChatLinkButton {
  label: string;
  url: string;
}

/** The contact form a scenario asks for; the email always, the rest when switched on. */
export interface ChatFormRequest {
  collectName: boolean;
  collectPhone: boolean;
  /** Beside the consent box; null shows the widget's own text. */
  consentText: string | null;
}

/**
 * What a line carries beyond its text: a bot's quick replies, links or form
 * request; on the visitor's own line, the quick reply they tapped and the
 * line it answers.
 */
export interface ChatMessagePayload {
  options?: ChatChoiceOption[];
  buttons?: ChatLinkButton[];
  form?: ChatFormRequest;
  option?: string;
  replyTo?: string;
}

export interface ChatMessage {
  id: string;
  direction: 'in' | 'out';
  at: string;
  /** `text`, `notice`, `choices` or `form`. */
  kind: string;
  text: string | null;
  sender: { kind: ChatSenderKind; name: string | null };
  payload?: ChatMessagePayload | null;
  /** Set on the visitor's own lines until the server has them. */
  pending?: 'sending' | 'failed';
  clientMessageId?: string;
  /** A bot's line shows as typing until this time (ms since the epoch). */
  revealAt?: number;
}

export interface ChatConversation {
  id: string;
  status: 'open' | 'resolved';
  agent: { name: string | null } | null;
}

export interface ChatState {
  config: ChatWidgetConfig | null;
  conversation: ChatConversation | null;
  messages: ChatMessage[];
  online: boolean;
  /** Lines from the team that arrived while the window was closed. */
  unread: number;
  isOpen: boolean;
  /** The visitor gave an email or phone, here or through `identify()`. */
  identified: boolean;
  /** The organization has no conversation allowance left: the form takes the lead instead. */
  overQuota: boolean;
}

export interface ChatLead {
  name?: string;
  email?: string;
  phone?: string;
  consent: boolean;
}

/** What goes with a line beyond its text. */
export interface SendExtra {
  /** The welcome button or quick reply tapped, by its key. */
  option?: string;
  /** The bot line the quick reply answers. */
  replyTo?: string;
  /** A retry of a failed line, by its id, so the server takes it once. */
  retryOf?: string;
}
