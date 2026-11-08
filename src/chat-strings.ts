/**
 * The widget's own labels, in both languages the dashboard texts come in.
 * What an organization can change (welcome, placeholder, offline texts) comes
 * from the server; these are the fixed controls around them.
 */
export type ChatLocale = 'en' | 'ar';

export interface ChatStrings {
  open: string;
  close: string;
  send: string;
  online: string;
  away: string;
  poweredBy: string;
  name: string;
  email: string;
  phone: string;
  submit: string;
  skip: string;
  sending: string;
  failed: string;
  retry: string;
  you: string;
  team: string;
  /** The scenarios' lines, when the organization gave the bot no name. */
  bot: string;
  typing: string;
  invalidEmail: string;
  invalidPhone: string;
  attach: string;
  fileTooLarge: string;
  fileType: string;
  fileFailed: string;
  uploading: string;
  /** Under the visitor's last line a teammate has read. */
  seen: string;
  /** The five scores' labels, worst first. */
  rateScores: readonly string[];
  ratingComment: string;
  /** `{score}` is the visitor's own score. */
  ratingYours: string;
  dismiss: string;
}

export const CHAT_STRINGS: Readonly<Record<ChatLocale, ChatStrings>> = Object.freeze({
  en: Object.freeze({
    open: 'Open chat',
    close: 'Close chat',
    send: 'Send',
    online: 'Online',
    away: 'Away',
    poweredBy: 'Powered by',
    name: 'Name',
    email: 'Email',
    phone: 'Phone',
    submit: 'Continue',
    skip: 'Skip',
    sending: 'Sending…',
    failed: 'Not sent.',
    retry: 'Retry',
    you: 'You',
    team: 'Team',
    bot: 'Assistant',
    typing: 'Typing…',
    invalidEmail: 'Enter a valid email address.',
    invalidPhone: 'Enter a phone number with the country code, e.g. +966501234567.',
    attach: 'Attach an image or a PDF',
    fileTooLarge: 'Files can be up to 10 MB.',
    fileType: 'Send an image (JPEG, PNG, WebP or GIF) or a PDF.',
    fileFailed: 'The file was not sent.',
    uploading: 'Uploading…',
    seen: 'Seen',
    rateScores: Object.freeze(['Very bad', 'Bad', 'Okay', 'Good', 'Very good']),
    ratingComment: 'Anything to add? (optional)',
    ratingYours: 'You rated it {score} of 5',
    dismiss: 'Dismiss',
  }),
  ar: Object.freeze({
    open: 'افتح المحادثة',
    close: 'أغلق المحادثة',
    send: 'إرسال',
    online: 'متصل',
    away: 'غير متواجد',
    poweredBy: 'مدعوم من',
    name: 'الاسم',
    email: 'البريد الإلكتروني',
    phone: 'رقم الجوال',
    submit: 'متابعة',
    skip: 'تخطي',
    sending: 'جارٍ الإرسال…',
    failed: 'لم تُرسل.',
    retry: 'أعد المحاولة',
    you: 'أنت',
    team: 'الفريق',
    bot: 'المساعد',
    typing: 'يكتب…',
    invalidEmail: 'أدخل بريداً إلكترونياً صحيحاً.',
    invalidPhone: 'أدخل رقم الجوال مع رمز الدولة، مثل +966501234567.',
    attach: 'أرفق صورة أو ملف PDF',
    fileTooLarge: 'حجم الملف حتى 10 ميغابايت.',
    fileType: 'أرسل صورة (JPEG أو PNG أو WebP أو GIF) أو ملف PDF.',
    fileFailed: 'لم يُرسل الملف.',
    uploading: 'جارٍ الرفع…',
    seen: 'تمت القراءة',
    rateScores: Object.freeze(['سيئ جداً', 'سيئ', 'مقبول', 'جيد', 'ممتاز']),
    ratingComment: 'هل تود إضافة شيء؟ (اختياري)',
    ratingYours: 'قيّمتها {score} من 5',
    dismiss: 'إغلاق',
  }),
});
