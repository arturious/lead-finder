const { buildXlsx } = require("./xlsx");

const COLUMNS = [
  { key: "username", header: "Username", width: 22 },
  { key: "profileUrl", header: "Profile", width: 46, link: true },
  { key: "country", header: "Country", width: 22 },
  { key: "source", header: "Source", width: 16 },
  { key: "liveness", header: "Liveness", width: 32 },
  { key: "online", header: "Online", width: 10 },
  { key: "joined", header: "Joined", width: 18 },
  { key: "experience", header: "Experience", width: 22 },
  { key: "gain", header: "Gain", width: 12 },
  { key: "drawdown", header: "Drawdown", width: 12 },
  { key: "trades", header: "Trades", width: 10 },
  { key: "equity", header: "Equity", width: 14 },
  { key: "pips", header: "Pips", width: 12 },
  { key: "trading", header: "Trading", width: 14 },
  { key: "contacts", header: "Contacts", width: 40, wrap: true },
  { key: "foundAt", header: "Found at", width: 18 }
];

function cellValue(lead, key) {
  if (key === "online") return lead.online ? "yes" : "no";
  return lead[key] ?? "";
}

function leadsToCsv(leads) {
  const header = COLUMNS.map((c) => c.header).join(",");
  const lines = leads.map((lead) => COLUMNS.map((c) => csvCell(cellValue(lead, c.key))).join(","));
  return `\uFEFF${header}\n${lines.join("\n")}\n`;
}

function csvCell(value) {
  const s = String(value ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function leadsToXlsx(leads) {
  const rows = leads.map((lead) => COLUMNS.map((c) => cellValue(lead, c.key)));
  return buildXlsx("Leads", COLUMNS, rows);
}

module.exports = { COLUMNS, leadsToCsv, leadsToXlsx };
