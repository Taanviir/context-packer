// Draws the findings charts from data/summary.json (written by bench/report.ts).
const NS = "http://www.w3.org/2000/svg";
const SERIES = {
  keywords: { label: "Keywords", color: "var(--color-series-keywords)" },
  jev: { label: "Jev", color: "var(--color-series-jev)" },
  laya: { label: "Laya", color: "var(--color-series-laya)" },
};
const tooltip = document.querySelector(".tooltip");

/** Charts draw at their real width, so 12px text stays 12px. Below COMPACT, row labels move above their row. */
const COMPACT = 560;
const widthOf = (fig) => Math.max(280, Math.round(fig.clientWidth));
function canvas(fig, attrs) {
  const scroll = document.createElement("div");
  scroll.className = "chart-scroll";
  fig.append(scroll);
  const [, , w, h] = attrs.viewBox.split(" ");
  return el("svg", { width: w, height: h, ...attrs }, scroll);
}

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.append(node);
  return node;
}

function hover(target, text) {
  const show = (e) => {
    tooltip.textContent = text;
    tooltip.classList.add("is-on");
    const x = e.clientX ?? target.getBoundingClientRect().left;
    const y = e.clientY ?? target.getBoundingClientRect().top;
    tooltip.style.left = `${Math.min(x + 12, innerWidth - tooltip.offsetWidth - 8)}px`;
    tooltip.style.top = `${y + 14}px`;
  };
  target.setAttribute("tabindex", "0");
  target.setAttribute("aria-label", text);
  target.addEventListener("pointermove", show);
  target.addEventListener("focus", show);
  target.addEventListener("pointerleave", () => tooltip.classList.remove("is-on"));
  target.addEventListener("blur", () => tooltip.classList.remove("is-on"));
}

function caption(figure, title, sub, series) {
  const cap = document.createElement("figcaption");
  cap.innerHTML = "<strong></strong><span></span>";
  cap.children[0].textContent = title;
  cap.children[1].textContent = sub;
  figure.append(cap);
  if (series?.length > 1) {
    const legend = document.createElement("ul");
    legend.className = "legend";
    for (const s of series) {
      const li = document.createElement("li");
      li.innerHTML = `<i style="background:${SERIES[s].color}"></i>`;
      li.append(SERIES[s].label);
      legend.append(li);
    }
    figure.append(legend);
  }
}

function tableView(figure, head, rows) {
  const details = document.createElement("details");
  details.className = "table-view";
  details.innerHTML = "<summary>Show as a table</summary>";
  details.append(table(head, rows));
  figure.append(details);
}

function table(head, rows) {
  const t = document.createElement("table");
  t.className = "data-table";
  const tr = t.createTHead().insertRow();
  head.forEach((h) => { const th = document.createElement("th"); th.textContent = h; tr.append(th); });
  const body = t.createTBody();
  rows.forEach((r) => { const row = body.insertRow(); r.forEach((c) => { row.insertCell().textContent = c; }); });
  return t;
}

const f2 = (x) => x.toFixed(2);
const pct = (x) => `${Math.round(x * 100)}%`;
const signed = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(0)}`;

/** Dot plot: one row per repo, a dot per provider on a shared 0–1 recall axis. */
function repoChart(summary) {
  const fig = document.getElementById("chart-repos");
  fig.replaceChildren();
  const repos = Object.entries(summary.repos);
  const used = ["keywords", "jev", "laya"].filter((v) => repos.some(([, r]) => r.test.variants[v]));
  caption(fig, "Needed files found in the top 10", "Each row is one project; further right is better.", used);
  const W = widthOf(fig), compact = W < COMPACT;
  const left = compact ? 16 : 190, right = 110, row = compact ? 52 : 40, top = compact ? 18 : 8, H = top + repos.length * row + 28;
  const svg = canvas(fig, { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Share of needed files each tool found in its top 10, per project. The same numbers are in the table below." });
  const x = (v) => left + v * (W - left - right);
  const grid = el("g", { class: "grid axis" }, svg);
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    el("line", { x1: x(t), x2: x(t), y1: top, y2: H - 24 }, grid);
    el("text", { x: x(t), y: H - 6, "text-anchor": "middle" }, grid).textContent = pct(t);
  }
  const rows = [];
  repos.forEach(([name, r], i) => {
    const y = top + i * row + row / 2 + (compact ? 6 : 0);
    const v = r.test.variants;
    el("text", compact ? { x: 0, y: y - 16, class: "label" } : { x: 0, y: y + 4, class: "label" }, svg).textContent = `${name} · ${r.language}`;
    const vals = used.filter((s) => v[s]).map((s) => [s, v[s].recall["10"]]);
    const xs = vals.map(([, val]) => x(val));
    el("line", { x1: Math.min(...xs), x2: Math.max(...xs), y1: y, y2: y, stroke: "var(--color-rule-strong)", "stroke-width": 2 }, svg);
    for (const [s, val] of vals) {
      el("circle", { cx: x(val), cy: y, r: 6, fill: SERIES[s].color, stroke: "var(--color-paper)", "stroke-width": 2 }, svg);
      const hit = el("circle", { cx: x(val), cy: y, r: 12, class: "hit" }, svg);
      hover(hit, `${name} · ${SERIES[s].label}: found ${pct(val)} of needed files in its top 10 (${v[s].tasks} tasks)`);
    }
    const best = vals.reduce((a, b) => (b[1] > a[1] ? b : a));
    el("text", { x: Math.max(...xs) + 12, y: y + 4, class: "value" }, svg).textContent = `${SERIES[best[0]].label} ${pct(best[1])}`;
    rows.push([name, ...used.map((s) => (v[s] ? pct(v[s].recall["10"]) : "—"))]);
  });
  tableView(fig, ["Project", ...used.map((s) => SERIES[s].label)], rows);
}

/** Forest plot: paired difference with its 95% interval, per repo and pooled. */
function diffChart(summary) {
  const fig = document.getElementById("chart-diffs");
  fig.replaceChildren();
  caption(fig, "Extra needed files found, per 100", "The dot is the measured difference. The line is the range it could plausibly be, given 30 tests per project; a line that crosses zero could be chance.", null);
  const lines = [];
  for (const [name, r] of Object.entries(summary.repos)) {
    for (const [cmp, c] of Object.entries(r.test.comparisons)) lines.push({ name, cmp, ...c["10"] });
  }
  for (const [cmp, c] of Object.entries(summary.pooled.test.comparisons)) lines.push({ name: "pooled", cmp, ...c["10"] });
  const order = ["jev vs keywords", "jev-lang vs jev", "laya vs keywords"];
  lines.sort((a, b) => order.indexOf(a.cmp) - order.indexOf(b.cmp) || (a.name === "pooled") - (b.name === "pooled"));
  const labelOf = { "jev vs keywords": "Jev vs keywords", "jev-lang vs jev": "Per-language summaries vs shipped Jev", "laya vs keywords": "Laya vs keywords" };
  const W = widthOf(fig), compact = W < COMPACT;
  const left = compact ? 18 : 320, right = 24, row = compact ? 44 : 30, top = compact ? 18 : 8, H = top + lines.length * row + 28;
  const lo = Math.min(-0.2, ...lines.map((l) => l.lo)), hi = Math.max(0.3, ...lines.map((l) => l.hi));
  const x = (v) => left + ((v - lo) / (hi - lo)) * (W - left - right);
  const svg = canvas(fig, { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Extra needed files found per 100, with the plausible range, for each comparison. The same numbers are in the table below." });
  const grid = el("g", { class: "grid axis" }, svg);
  for (let t = Math.ceil(lo * 10) / 10; t <= hi + 1e-9; t += 0.1) {
    el("line", { x1: x(t), x2: x(t), y1: top, y2: H - 24 }, grid);
    el("text", { x: x(t), y: H - 6, "text-anchor": "middle" }, grid).textContent = signed(t).replace(".0", "");
  }
  el("line", { x1: x(0), x2: x(0), y1: top, y2: H - 24, class: "zero" }, svg);
  lines.forEach((l, i) => {
    const y = top + i * row + row / 2 + (compact ? 6 : 0);
    const color = l.cmp.startsWith("laya") ? SERIES.laya.color : l.cmp === "jev vs keywords" ? SERIES.jev.color : "var(--color-muted)";
    el("text", { x: 0, y: compact ? y - 12 : y + 4, class: l.name === "pooled" ? "value" : "label" }, svg).textContent = `${labelOf[l.cmp]} · ${l.name === "pooled" ? "all projects" : l.name}`;
    el("line", { x1: x(l.lo), x2: x(l.hi), y1: y, y2: y, stroke: color, "stroke-width": 2, "stroke-linecap": "round" }, svg);
    el("circle", { cx: x(l.diff), cy: y, r: l.name === "pooled" ? 6 : 4.5, fill: color, stroke: "var(--color-paper)", "stroke-width": 2 }, svg);
    const hit = el("rect", { x: x(l.lo) - 6, y: y - 10, width: Math.max(12, x(l.hi) - x(l.lo) + 12), height: 20, class: "hit" }, svg);
    hover(hit, `${labelOf[l.cmp]}, ${l.name === "pooled" ? "all projects" : l.name}: ${signed(l.diff)} per 100 needed files (plausible range ${signed(l.lo)} to ${signed(l.hi)}), ${l.tasks} tasks`);
  });
  tableView(fig, ["Comparison", "Project", "Extra files per 100", "Plausible range (95%)", "Tasks"], lines.map((l) => [labelOf[l.cmp], l.name === "pooled" ? "all projects" : l.name, signed(l.diff), `${signed(l.lo)} to ${signed(l.hi)}`, String(l.tasks)]));
}

/** Two lines over k = 5, 10, 20, pooled test split. */
function kChart(summary) {
  const fig = document.getElementById("chart-k");
  fig.replaceChildren();
  const v = summary.pooled.test.variants;
  const used = ["keywords", "jev"].filter((s) => v[s]);
  caption(fig, "Needed files found in the top 5, 10 and 20", `All ${v.jev.tasks} tasks on the four projects Jev ran on.`, used);
  const ks = ["5", "10", "20"];
  const W = Math.min(widthOf(fig), 720), H = 260, left = 44, right = 110, top = 12, bottom = 30;
  const x = (i) => left + (i / (ks.length - 1)) * (W - left - right);
  const y = (val) => top + (1 - (val - 0.4) / 0.6) * (H - top - bottom);
  const svg = canvas(fig, { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Share of needed files found in the top 5, 10 and 20, keywords against Jev. The same numbers are in the table below." });
  const grid = el("g", { class: "grid axis" }, svg);
  for (const t of [0.4, 0.6, 0.8, 1]) {
    el("line", { x1: left, x2: W - right, y1: y(t), y2: y(t) }, grid);
    el("text", { x: left - 8, y: y(t) + 4, "text-anchor": "end" }, grid).textContent = pct(t);
  }
  ks.forEach((k, i) => { el("text", { x: x(i), y: H - 8, "text-anchor": "middle" }, grid).textContent = `top ${k}`; });
  for (const s of used) {
    const pts = ks.map((k, i) => [x(i), y(v[s].recall[k])]);
    el("polyline", { points: pts.map((p) => p.join(",")).join(" "), fill: "none", stroke: SERIES[s].color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
    pts.forEach(([px, py], i) => {
      el("circle", { cx: px, cy: py, r: 5, fill: SERIES[s].color, stroke: "var(--color-paper)", "stroke-width": 2 }, svg);
      hover(el("circle", { cx: px, cy: py, r: 12, class: "hit" }, svg), `${SERIES[s].label}: found ${pct(v[s].recall[ks[i]])} of needed files in its top ${ks[i]}`);
    });
    const [ex, ey] = pts.at(-1);
    el("text", { x: ex + 12, y: ey + 4, class: "value" }, svg).textContent = `${SERIES[s].label} ${pct(v[s].recall["20"])}`;
  }
  tableView(fig, ["Tool", "Top 5", "Top 10", "Top 20"], used.map((s) => [SERIES[s].label, ...ks.map((k) => pct(v[s].recall[k]))]));
}

function costTable(summary) {
  const rows = [];
  for (const [name, r] of Object.entries(summary.repos)) {
    for (const s of ["keywords", "jev", "laya"]) {
      const v = r.test.variants[s];
      if (!v) continue;
      rows.push([name, SERIES[s].label, String(v.candidates), pct(v.recall["5"]), pct(v.recall["10"]), pct(v.recall["20"]),
        v.ms >= 1000 ? `${(v.ms / 1000).toFixed(1)} s` : `${v.ms} ms`, s === "jev" ? `$${v.costUsd.toFixed(4)}` : "$0", s === "keywords" ? "—" : String(v.failedBatches)]);
    }
  }
  document.getElementById("table-cost").append(table(["Project", "Tool", "Files in project", "Top 5", "Top 10", "Top 20", "Time", "Cost", "Failed requests"], rows));
}

const summary = await fetch("data/summary.json").then((r) => r.json());
document.querySelector("[data-generated]").textContent = `Benchmark · generated ${summary.generated}`;
const draw = () => { repoChart(summary); diffChart(summary); kChart(summary); };
draw();
costTable(summary);
let drawnAt = innerWidth;
addEventListener("resize", () => {
  if (innerWidth === drawnAt) return;
  drawnAt = innerWidth;
  requestAnimationFrame(draw);
});
