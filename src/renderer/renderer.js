const $ = (id) => document.getElementById(id);

const ui = {
  site: $("site"),
  countryInput: $("country-input"),
  countryList: $("country-list"),
  start: $("start"),
  rows: $("rows"),
  empty: $("empty"),
  statusLine: $("status-line"),
  proxyInput: $("proxy-input"),
  proxyNote: $("proxy-note"),
  experience: $("experience")
};

const state = {
  countries: [],
  country: "",
  running: false,
  leads: new Map()
};

function setStatus(status) {
  const activePhase = ["starting", "download", "running", "challenge", "blocked", "cooldown", "stopping"].includes(status.phase);
  const finished = status.running === false || status.phase === "idle";
  state.running = finished ? false : Boolean(status.running) || activePhase;
  $("m-requests").textContent = String(status.requests || 0);
  $("m-profiles").textContent = String(status.profiles || 0);
  $("m-leads").textContent = String(state.running ? (status.leads || 0) : state.leads.size);
  $("m-source").textContent = status.source || "—";
  ui.statusLine.textContent = status.message || "";
  ui.statusLine.className = status.phase || "";
  ui.start.textContent = state.running ? "Стоп" : "Начать поиск";
  ui.start.classList.toggle("stop", state.running);
  ui.start.disabled = !state.running && !state.country;
  ui.site.disabled = state.running;
  ui.countryInput.disabled = state.running;
  ui.experience.disabled = state.running;
  syncActionButtons();
}

function syncActionButtons() {
  const empty = state.leads.size === 0;
  $("export-xlsx").disabled = empty;
  $("clear-leads").disabled = state.running || empty;
  $("reset-memory").disabled = state.running;
}

function renderLeadRow(lead) {
  const tr = document.createElement("tr");
  tr.dataset.user = lead.username.toLowerCase();
  const cells = [
    linkCell(lead),
    text(lead.country),
    text(lead.joined),
    text(lead.experience),
    text(lead.gain),
    text(lead.drawdown),
    text(lead.trades),
    text(lead.foundAt)
  ];
  cells.forEach((cell) => tr.appendChild(cell));
  return tr;
}

function text(value) {
  const td = document.createElement("td");
  td.textContent = value || "";
  return td;
}

function linkCell(lead) {
  const td = document.createElement("td");
  const a = document.createElement("a");
  a.href = lead.profileUrl;
  a.textContent = lead.username;
  a.addEventListener("click", (event) => {
    event.preventDefault();
    window.leadfinder.openUrl(lead.profileUrl);
  });
  td.appendChild(a);
  return td;
}

function upsertRow(lead) {
  const key = lead.username.toLowerCase();
  state.leads.set(key, lead);
  const next = renderLeadRow(lead);
  const prev = ui.rows.querySelector(`tr[data-user="${CSS.escape(key)}"]`);
  if (prev) prev.replaceWith(next);
  else ui.rows.prepend(next);
  ui.empty.hidden = state.leads.size > 0;
  syncActionButtons();
}

function replaceLeads(leads) {
  state.leads = new Map();
  ui.rows.replaceChildren();
  for (const lead of leads || []) upsertRow(lead);
  ui.empty.hidden = state.leads.size > 0;
  if (!state.running) $("m-leads").textContent = String(state.leads.size);
  syncActionButtons();
}

function filteredCountries() {
  const q = ui.countryInput.value.trim().toLowerCase();
  if (!q || q === state.country.toLowerCase()) return state.countries;
  return state.countries.filter((name) => name.toLowerCase().includes(q));
}

function renderCountryList() {
  const names = filteredCountries();
  ui.countryList.replaceChildren();
  names.forEach((name) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = name;
    if (name === state.country) button.classList.add("active");
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      chooseCountry(name);
    });
    li.appendChild(button);
    ui.countryList.appendChild(li);
  });
  if (!names.length) {
    const li = document.createElement("li");
    li.textContent = "Нет такой страны";
    li.style.padding = "8px";
    ui.countryList.appendChild(li);
  }
}

function openCountryList() {
  if (ui.countryInput.disabled) return;
  renderCountryList();
  ui.countryList.hidden = false;
}

function chooseCountry(name) {
  state.country = name;
  ui.countryInput.value = name;
  ui.countryList.hidden = true;
  ui.start.disabled = state.running || !name;
  window.leadfinder.leadsFor(name).then(replaceLeads).catch(() => {});
}

ui.site.addEventListener("change", () => {
  ui.countryList.hidden = true;
});

ui.countryInput.addEventListener("blur", () => {
  const typed = ui.countryInput.value.trim().toLowerCase();
  const exact = state.countries.find((name) => name.toLowerCase() === typed);
  if (exact) {
    if (exact !== state.country) chooseCountry(exact);
  } else {
    ui.countryInput.value = state.country;
  }
});

ui.countryInput.addEventListener("focus", openCountryList);
ui.countryInput.addEventListener("input", openCountryList);
ui.countryInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    const first = filteredCountries()[0];
    if (first) chooseCountry(first);
  } else if (event.key === "Escape") {
    ui.countryList.hidden = true;
    ui.countryInput.value = state.country;
  }
});

const settingsPanel = $("settings-panel");
const settingsToggle = $("settings-toggle");

function setSettingsOpen(open) {
  settingsPanel.hidden = !open;
  settingsToggle.setAttribute("aria-expanded", open ? "true" : "false");
}

settingsToggle.addEventListener("click", () => {
  setSettingsOpen(settingsPanel.hidden);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setSettingsOpen(false);
});

document.addEventListener("click", (event) => {
  if (!event.target.closest("#country-combo")) ui.countryList.hidden = true;
  if (!event.target.closest("#settings")) setSettingsOpen(false);
});

ui.start.addEventListener("click", async () => {
  ui.start.disabled = true;
  try {
    if (state.running) setStatus(await window.leadfinder.stop());
    else {
      await window.leadfinder.start({
        siteId: ui.site.value,
        country: state.country,
        proxy: ui.proxyInput.value,
        minExperience: ui.experience.value
      });
    }
  } catch (error) {
    ui.statusLine.textContent = error && error.message ? error.message : "Не удалось запустить поиск";
    ui.statusLine.className = "error";
  } finally {
    ui.start.disabled = !state.running && !state.country;
  }
});

async function exportFile(kind) {
  const result = await window.leadfinder.exportFile({ kind, country: state.country });
  if (result && result.ok === false && result.error) {
    ui.statusLine.textContent = result.error;
    ui.statusLine.className = "error";
  }
}

ui.proxyInput.addEventListener("change", () => {
  window.leadfinder.saveProxy(ui.proxyInput.value);
  ui.proxyNote.textContent = "Браузер перезапускается с новым прокси.";
});

$("proxy-check").addEventListener("click", async () => {
  ui.proxyNote.textContent = "Проверяю…";
  ui.proxyNote.className = "note";
  try {
    const result = await window.leadfinder.checkProxy(ui.proxyInput.value);
    ui.proxyNote.textContent = result && result.message ? result.message : "";
    ui.proxyNote.className = result && result.ok ? "note ok" : "note error";
  } catch (error) {
    ui.proxyNote.textContent = error && error.message ? error.message : "Прокси недоступен";
    ui.proxyNote.className = "note error";
  }
});

ui.experience.addEventListener("change", () => {
  window.leadfinder.saveExperience(ui.experience.value);
});

$("export-xlsx").addEventListener("click", () => exportFile("xlsx"));

$("reset-memory").addEventListener("click", async () => {
  if (state.running) return;
  $("reset-memory").disabled = true;
  try {
    await window.leadfinder.resetMemory();
  } finally {
    syncActionButtons();
  }
});

$("clear-leads").addEventListener("click", async () => {
  if (state.running) return;
  $("clear-leads").disabled = true;
  try {
    const result = await window.leadfinder.clearLeads();
    if (result && result.ok) replaceLeads([]);
  } finally {
    syncActionButtons();
  }
});

window.leadfinder.onStatus(setStatus);
window.leadfinder.onLead((payload) => {
  if (payload && payload.lead) upsertRow(payload.lead);
});
window.leadfinder.onLeads(replaceLeads);

window.leadfinder.bootstrap().then((data) => {
  for (const source of data.sources) {
    const option = document.createElement("option");
    option.value = source.id;
    option.textContent = source.label;
    if (source.id === data.lastSite) option.selected = true;
    ui.site.appendChild(option);
  }
  state.countries = data.countries;
  if (data.lastCountry) {
    state.country = data.lastCountry;
    ui.countryInput.value = data.lastCountry;
  }
  replaceLeads(data.leads || []);
  if (data.minExperience) ui.experience.value = data.minExperience;
  if (data.proxy) ui.proxyInput.value = data.proxy;
  setStatus(data.status || {});
}).catch((error) => {
  ui.statusLine.textContent = error && error.message ? error.message : "Окно не связалось с приложением";
  ui.statusLine.className = "error";
});
