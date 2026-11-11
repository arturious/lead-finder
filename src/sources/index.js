// One module per site. To add a site: implement { id, label, entryUrl, run(ctx) }
// and append it here. The window lists whatever this registry returns.
const myfxbook = require("./myfxbook");

const SOURCES = [myfxbook];

function listSources() {
  return SOURCES.map((source) => ({ id: source.id, label: source.label }));
}

function getSource(id) {
  return SOURCES.find((source) => source.id === id) || null;
}

module.exports = { listSources, getSource };
