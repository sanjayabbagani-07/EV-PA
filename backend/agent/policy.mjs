// Permission policy. Decisions are made by the engine, never by the model.
//   deny    -> never executed
//   confirm -> executed only after an explicit, single-use user approval
//   allow   -> executed immediately
// Tools that act on pages/apps set scanArgs:true; the fields describing WHAT is being acted on are scanned
// as a backstop in case the model under-labels a consequential action.
const CONSEQUENTIAL = [
  ['follow', /\b(follow|following|subscribe|join|connect with)\b/i],
  ['send_message', /\b(send|reply|dm|direct message|email|e-mail|text|whatsapp|share with)\b/i],
  ['post', /\b(post|publish|tweet|comment|upload|share)\b/i],
  ['delete', /\b(delete|remove|erase|unfollow|unsubscribe|cancel|clear|discard)\b/i],
  ['purchase', /\b(buy|purchase|pay|checkout|check out|place order|order now|donate|add payment|book now|subscribe)\b/i],
  ['submit_form', /\b(submit|confirm|apply|register|sign up|signup|send application|finish|complete order)\b/i],
  ['change_settings', /\b(settings?|password|privacy|permissions?|account|profile|security|two[- ]factor)\b/i],
];
const CAPTCHA = /\b(captcha|recaptcha|hcaptcha|turnstile|are you (?:a )?human|verify you(?:'| a)?re human)\b/i;
const CREDENTIAL_FIELD = /\b(password|passcode|pin|otp|one[- ]time|verification code|2fa|mfa|cvv|cvc|card number|security code|ssn|social security)\b/i;
const INPUT_ACTION = /\b(type|input|fill|enter|set_text|paste)\b/i;
const DEFAULT_SCAN_FIELDS = ['action', 'intent', 'target', 'label', 'name', 'element', 'description', 'url', 'selector'];

export function classifyConsequential(text) {
  const s = String(text ?? '');
  for (const [category, re] of CONSEQUENTIAL) if (re.test(s)) return category;
  return null;
}

function scanText(args, fields) {
  const parts = [];
  for (const f of fields) if (typeof args?.[f] === 'string') parts.push(args[f]);
  return parts.join(' ');
}

const RANK = { allow: 0, confirm: 1, deny: 2 };
const worse = (a, b) => (RANK[b.decision] > RANK[a.decision] ? b : a);

export function evaluate(tool, args, ctx = {}) {
  const summary = safeSummary(tool, args);
  if (tool.permission === 'deny') return { decision: 'deny', category: 'policy', reason: 'This tool is disabled.', summary };
  let verdict = tool.permission === 'confirm'
    ? { decision: 'confirm', category: 'tool_requires_approval', reason: 'This action always needs your approval.', summary }
    : { decision: 'allow', category: null, reason: null, summary };

  if (tool.scanArgs) {
    const text = scanText(args, tool.scanFields || DEFAULT_SCAN_FIELDS);
    if (CAPTCHA.test(text)) {
      return { decision: 'deny', category: 'captcha', reason: 'EV does not attempt to solve or bypass CAPTCHAs. Please complete it yourself.', summary };
    }
    if (INPUT_ACTION.test(String(args?.action ?? '')) && CREDENTIAL_FIELD.test(text)) {
      return { decision: 'deny', category: 'credentials', reason: 'EV never types passwords, one-time codes or card details. Please enter them yourself.', summary };
    }
    const cat = classifyConsequential(text);
    if (cat) verdict = worse(verdict, { decision: 'confirm', category: cat, reason: `This looks like a consequential action (${cat.replace('_', ' ')}).`, summary });
  }

  if (typeof tool.assess === 'function') {
    try {
      const a = tool.assess(args, ctx);
      if (a && RANK[a.decision] !== undefined) verdict = worse(verdict, { decision: a.decision, category: a.category ?? null, reason: a.reason ?? null, summary });
    } catch {
      verdict = worse(verdict, { decision: 'deny', category: 'policy', reason: 'Policy check failed.', summary });
    }
  }
  return verdict;
}

function safeSummary(tool, args) {
  try {
    const s = tool.summarize ? tool.summarize(args) : `Run ${tool.name}`;
    return String(s).slice(0, 300);
  } catch { return `Run ${tool.name}`; }
}
