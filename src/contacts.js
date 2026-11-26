// Contact extraction from a profile bio. Ported from the Myfxbook Lead Finder
// Chrome extension v1.3.1 (contacts.js) so export rules stay the same.

const NETWORK_NAMES = [
  [/^(?:facebook|fb|фейсбук)$/i, "Facebook"],
  [/^(?:youtube|yt|ютуб)$/i, "YouTube"],
  [/^(?:instagram|insta|ig|инстаграм)$/i, "Instagram"],
  [/^(?:telegram|tg|телеграм)$/i, "Telegram"],
  [/^twitter$/i, "X/Twitter"],
  [/^tiktok$/i, "TikTok"],
  [/^line$/i, "LINE"],
  [/^discord$/i, "Discord"]
];
const NETWORK_WORD = "facebook|fb|фейсбук|youtube|yt|ютуб|instagram|insta|ig|инстаграм|telegram|tg|телеграм|twitter|tiktok|line|discord";

const SOCIAL_DOMAINS = /(?:t\.me|telegram\.me|instagram\.com|facebook\.com|fb\.com|youtube\.com|youtu\.be|twitter\.com|x\.com|wa\.me|discord\.gg|discord\.com|tiktok\.com|line\.me|myfxbook\.com)/i;

const CONTACT_PATTERNS = [
  [
    null,
    new RegExp(`(?<![A-Za-zА-Яа-яЁё])((?:${NETWORK_WORD})(?:\\s*(?:/|,|&|\\+|\\||and|и)\\s*(?:${NETWORK_WORD}))+)\\s*[:\\-–]\\s*([^\\n;|]{2,60})`, "gi"),
    (m) => {
      const value = firstWords(m[2], 4);
      return m[1]
        .split(/\s*(?:\/|,|&|\+|\|)\s*|\s+(?:and|и)\s+/i)
        .map((name) => (NETWORK_NAMES.find(([re]) => re.test(name.trim())) || [])[1])
        .filter(Boolean)
        .map((label) => [label, value]);
    }
  ],
  ["Telegram", /(?:t\.me|telegram\.me)\/([A-Za-z0-9_+]{3,})/gi, (m) => "t.me/" + m[1]],
  ["Telegram", /(?:telegram|телеграм|\btg\b)[^\n@]{0,20}(@[A-Za-z0-9_]{4,})/gi, (m) => m[1]],
  ["Telegram", /(?:telegram|телеграм|\btg\b)\s*:\s*([A-Za-z0-9_]{4,})/gi, (m) => "@" + m[1]],
  ["Instagram", /instagram\.com\/([A-Za-z0-9_.]{2,})/gi, (m) => "instagram.com/" + m[1]],
  ["Instagram", /(?:instagram|insta|инстаграм|\big\b)[^\n@]{0,20}(@[A-Za-z0-9_.]{2,})/gi, (m) => m[1]],
  ["Instagram", /(?:instagram|insta|инстаграм)\s*:\s*([A-Za-z0-9_.]{2,})/gi, (m) => "@" + m[1]],
  ["WhatsApp", /wa\.me\/(\+?\d{7,15})/gi, (m) => "+" + m[1].replace(/^\+/, "")],
  ["WhatsApp", /(?:whats?\s?app|watsapp|ватсап|вотсап)[^\n\d+]{0,10}(\+?\d[\d\s\-()]{6,20}\d)/gi, (m) => m[1].trim()],
  ["Facebook", /(?:facebook|fb)\.com\/([A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-?=]+)?)/gi, (m) => "facebook.com/" + m[1]],
  ["Facebook", /\b(?:facebook|fb)\s*(?::|\.(?!com\b))\s*([A-Za-z0-9_.][^\n;,|()/]{1,60})/gi, (m) => firstWords(m[1], 4)],
  ["X/Twitter", /(?:twitter|x)\.com\/([A-Za-z0-9_]{2,15})/gi, (m) => "@" + m[1]],
  ["X/Twitter", /twitter[^\n@]{0,20}(@[A-Za-z0-9_]{2,15})/gi, (m) => m[1]],
  ["YouTube", /((?:youtube\.com|youtu\.be)\/[^\s,;]+)/gi, (m) => m[1]],
  ["Discord", /(discord\.(?:gg|com\/invite)\/[A-Za-z0-9]+)/gi, (m) => m[1]],
  ["TikTok", /tiktok\.com\/(@?[A-Za-z0-9_.]{2,})/gi, (m) => "tiktok.com/" + m[1]],
  ["TikTok", /tiktok[^\n@]{0,20}(@[A-Za-z0-9_.]{2,})/gi, (m) => m[1]],
  ["LINE", /(line\.me\/[^\s,;]+)/gi, (m) => m[1]],
  ["LINE", /\bline\s*id\s*[:\-]?\s*(@?[A-Za-z0-9_.\-]{3,})/gi, (m) => m[1]],
  ["LINE", /\bline\s*[:\-]\s*(@[A-Za-z0-9_.\-]{3,})/gi, (m) => m[1]],
  ["E-mail", /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, (m) => m[1]],
  ["Phone", /(?:phone|tel|mobile|телефон|тел)\.?\s*:?\s*(\+?\d[\d\s\-()]{6,20}\d)/gi, (m) => m[1].trim()],
  ["Website", /(?:web\s?site|website|site|сайт)\s*:\s*((?:https?:\/\/)?[^\s,;]+\.[a-z]{2,}[^\s,;]*)/gi, (m) => m[1]],
  ["Website", /\b((?:https?:\/\/|www\.)[^\s,;<>()]+\.[a-z]{2,}[^\s,;<>()]*)/gi, (m) => (SOCIAL_DOMAINS.test(m[1]) ? "" : m[1])]
];

function firstWords(text, max) {
  return text
    .split(/\s+(?:or|and|или|и)\s+|\s{2,}/i)[0]
    .trim()
    .split(/\s+/)
    .slice(0, max)
    .join(" ");
}

function extractContacts(bio) {
  if (!bio) return "";
  const found = [];
  const seen = new Set();
  const add = (label, raw) => {
    const value = (raw || "").replace(/[.,;:)]+$/, "").trim();
    const key = label + "|" + value.toLowerCase().replace(/^https?:\/\//, "").replace(/^@/, "");
    if (value && !seen.has(key)) {
      seen.add(key);
      found.push(`${label}: ${value}`);
    }
  };
  for (const [label, re, format] of CONTACT_PATTERNS) {
    for (const m of bio.matchAll(re)) {
      const result = format(m);
      if (Array.isArray(result)) result.forEach(([l, v]) => add(l, v));
      else add(label, result);
    }
  }
  return found.join("\n");
}

function decodeCfEmail(hex) {
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

module.exports = { extractContacts, decodeCfEmail };
