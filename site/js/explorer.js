// Run explorer: every benchmark test, and where each tool ranked the files the change needed.
(() => {
  const LABEL = { keywords: "Keywords", jev: "Jev", "jev-lang": "Jev, per-language summaries", laya: "Laya" };
  const ORDER = ["keywords", "jev", "laya", "jev-lang"];
  const PAGE = 60;
  const SPLIT = { test: "reported", dev: "tuning" };
  const $ = (id) => document.getElementById(id);
  const state = { repo: "all", split: "test", a: "keywords", b: "jev", sort: "gain", q: "", open: location.hash.slice(1) || null, showAll: false };
  let data;

  const fmt = (x) => x.toFixed(2);
  const inTop = (run, k = 10) => run.gold.filter((g) => run.ranked.slice(0, k).includes(g)).length;
  const short = (v) => LABEL[v].split(",")[0];
  /** "found it", "missed it", "found both", "found 1 of 3", "missed all 3" */
  function found(run) {
    const n = inTop(run), total = run.gold.length;
    if (total === 1) return n ? "found it" : "missed it";
    if (n === total) return total === 2 ? "found both" : `found all ${total}`;
    if (n === 0) return total === 2 ? "missed both" : `missed all ${total}`;
    return `found ${n} of ${total}`;
  }
  const time = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
  const color = (v) => `var(--color-series-${v})`;

  function variantsFor(split) {
    const found = new Set();
    for (const r of Object.values(data.repos)) for (const v of Object.keys(r.splits[split] ?? {})) found.add(v);
    return ORDER.filter((v) => found.has(v));
  }

  /** Tasks with both runs, joined by id. */
  function pairs() {
    const out = [];
    for (const [name, r] of Object.entries(data.repos)) {
      if (state.repo !== "all" && state.repo !== name) continue;
      const runs = r.splits[state.split] ?? {};
      if (!runs[state.a] || !runs[state.b]) continue;
      const byId = new Map(runs[state.b].map((t) => [t.id, t]));
      runs[state.a].forEach((a, i) => {
        const b = byId.get(a.id);
        if (b) out.push({ repo: name, url: r.url, order: i, a, b, delta: b.recall["10"] - a.recall["10"] });
      });
    }
    const q = state.q.trim().toLowerCase();
    const shown = q ? out.filter((p) => p.a.task.toLowerCase().includes(q) || p.a.gold.some((g) => g.toLowerCase().includes(q))) : out;
    const missed = (p) => p.b.gold.filter((g) => !p.b.ranked.slice(0, 10).includes(g)).length;
    const by = {
      gain: (x, y) => y.delta - x.delta || x.repo.localeCompare(y.repo) || x.order - y.order,
      loss: (x, y) => x.delta - y.delta || x.repo.localeCompare(y.repo) || x.order - y.order,
      missed: (x, y) => missed(y) - missed(x) || x.delta - y.delta,
      task: (x, y) => x.repo.localeCompare(y.repo) || x.order - y.order,
    }[state.sort];
    return { all: out, shown: shown.sort(by) };
  }

  function options(select, values, labels, selected) {
    select.replaceChildren(...values.map((v) => new Option(labels[v] ?? v, v, false, v === selected)));
  }

  function syncControls() {
    const vs = variantsFor(state.split);
    if (!vs.includes(state.a)) state.a = vs[0];
    if (!vs.includes(state.b) || state.b === state.a) state.b = vs.find((v) => v !== state.a) ?? state.a;
    options($("a"), vs, LABEL, state.a);
    options($("b"), vs, LABEL, state.b);
    const repos = Object.keys(data.repos).filter((n) => {
      const runs = data.repos[n].splits[state.split] ?? {};
      return runs[state.a] && runs[state.b];
    });
    if (state.repo !== "all" && !repos.includes(state.repo)) state.repo = "all";
    const repoLabels = { all: "All projects" };
    for (const n of repos) repoLabels[n] = `${n} · ${data.repos[n].language}`;
    options($("repo"), ["all", ...repos], repoLabels, state.repo);
    document.querySelectorAll("[data-split]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.split === state.split)));
  }

  function strip(run, variant) {
    const wrap = document.createElement("div");
    wrap.className = "strip";
    const cells = document.createElement("div");
    cells.className = "cells";
    const gold = new Set(run.gold);
    for (let i = 0; i < 20; i++) {
      if (i === 10) { const g = document.createElement("i"); g.className = "gap"; cells.append(g); }
      const c = document.createElement("i");
      if (gold.has(run.ranked[i])) { c.style.background = color(variant); if (i >= 10) c.className = "lo"; }
      cells.append(c);
    }
    const missing = run.gold.filter((g) => !run.ranked.includes(g)).length;
    const tag = document.createElement("span");
    tag.textContent = LABEL[variant].split(",")[0];
    tag.style.minWidth = "8ch";
    const miss = document.createElement("span");
    miss.className = "miss";
    miss.textContent = missing ? `+${missing}` : "";
    miss.title = missing ? `${missing} needed file${missing > 1 ? "s" : ""} not in the top 20` : "";
    wrap.append(tag, cells, miss);
    return wrap;
  }

  function list(title, variant, run) {
    const col = document.createElement("div");
    const h = document.createElement("h3");
    h.innerHTML = `<i class="sw" style="display:inline-block;width:11px;height:11px;border-radius:2px;background:${color(variant)}"></i>`;
    h.append(title);
    const ol = document.createElement("ol");
    const gold = new Set(run.gold);
    run.ranked.forEach((p, i) => {
      const li = document.createElement("li");
      if (gold.has(p)) li.className = "hit";
      li.innerHTML = `<span class="n">${i + 1}</span><span></span>`;
      li.lastChild.textContent = p;
      ol.append(li);
    });
    col.append(h, ol);
    return col;
  }

  function detail(p) {
    const box = document.createElement("div");
    box.className = "detail";
    const goldCol = document.createElement("div");
    goldCol.className = "gold";
    goldCol.innerHTML = "<h3>Files the change needed</h3>";
    const ul = document.createElement("ul");
    const rank = (run, g) => { const i = run.ranked.indexOf(g); return i < 0 ? "—" : `#${i + 1}`; };
    for (const g of p.a.gold) {
      const li = document.createElement("li");
      li.innerHTML = "<span></span><span class=\"ranks\"></span>";
      li.firstChild.textContent = g;
      li.lastChild.textContent = `${rank(p.a, g)} · ${rank(p.b, g)}`;
      li.lastChild.title = `Where ${short(state.a)} and ${short(state.b)} ranked it (— means not in the top 20)`;
      ul.append(li);
    }
    goldCol.append(ul);
    const facts = document.createElement("div");
    facts.className = "facts";
    const sha = p.a.id.split("-").pop();
    const cost = (run, v) => (v.startsWith("jev") ? ` · $${run.costUsd.toFixed(4)}` : "");
    facts.innerHTML = `<span><a href="${p.url}/commit/${sha}">Commit ${sha}</a></span>
      <span>Files ranked <b>${p.a.candidates}</b></span>
      <span>${LABEL[state.a]} <b>${time(p.a.ms)}${cost(p.a, state.a)}</b></span>
      <span>${LABEL[state.b]} <b>${time(p.b.ms)}${cost(p.b, state.b)}</b></span>` +
      (p.b.failedBatches || p.a.failedBatches ? `<span>Failed requests <b>${p.a.failedBatches} · ${p.b.failedBatches}</b></span>` : "");
    box.append(goldCol, list(LABEL[state.a], state.a, p.a), list(LABEL[state.b], state.b, p.b), facts);
    return box;
  }

  function render() {
    const { all, shown } = pairs();
    const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
    const better = all.filter((p) => p.delta > 1e-9).length;
    const worse = all.filter((p) => p.delta < -1e-9).length;
    const bRuns = all.map((p) => p.b);
    const summary = $("summary");
    summary.innerHTML = "";
    const fig = (v, k) => { const d = document.createElement("div"); d.innerHTML = `<span class="v"></span><span class="k"></span>`; d.children[0].textContent = v; d.children[1].textContent = k; summary.append(d); };
    fig(String(all.length), all.length === 1 ? "test with both tools" : "tests with both tools");
    const share = (xs) => `${Math.round(mean(xs) * 100)}%`;
    fig(share(all.map((p) => p.a.recall["10"])), `of needed files in the top 10 (${short(state.a)})`);
    fig(share(all.map((p) => p.b.recall["10"])), `of needed files in the top 10 (${short(state.b)})`);
    fig(`${better} · ${all.length - better - worse} · ${worse}`, `tests where ${short(state.b)} found more · same · fewer`);
    fig(bRuns.length ? time(Math.round(mean(bRuns.map((r) => r.ms)))) : "—", `${short(state.b)}'s average time per test`);

    const key = $("key");
    key.innerHTML = "";
    for (const v of [state.a, state.b]) {
      const s = document.createElement("span");
      s.innerHTML = `<i class="sw" style="background:${color(v)}"></i>`;
      s.append(LABEL[v]);
      key.append(s);
    }
    const note = document.createElement("span");
    note.textContent = "Squares are ranks 1 to 20, left to right. Filled: a file the change needed. +N: needed files the tool didn't pick at all.";
    key.append(note);

    const ol = $("tasks");
    ol.innerHTML = "";
    if (!shown.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = all.length ? "No tests match that search. Clear the search box to see them all." : `No ${SPLIT[state.split]} tests have both a ${LABEL[state.a]} and a ${LABEL[state.b]} run. Pick another pair of tools.`;
      ol.append(li);
    }
    const visible = state.showAll || state.q ? shown : shown.slice(0, PAGE);
    for (const p of visible) {
      const li = document.createElement("li");
      li.id = p.a.id;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "row";
      row.setAttribute("aria-expanded", String(state.open === p.a.id));
      const what = document.createElement("div");
      what.className = "what";
      what.innerHTML = `<span class="t"></span><span class="m"></span>`;
      what.children[0].textContent = p.a.task;
      what.children[1].textContent = `${p.repo} · needed ${p.a.gold.length} file${p.a.gold.length > 1 ? "s" : ""} · in the top 10, ${short(state.b)} ${found(p.b)} and ${short(state.a)} ${found(p.a)}`;
      const strips = document.createElement("div");
      strips.className = "strips";
      strips.append(strip(p.a, state.a), strip(p.b, state.b));
      const score = document.createElement("div");
      score.className = "score";
      const d = p.delta;
      const verdict = d > 1e-9 ? `${short(state.b)} better` : d < -1e-9 ? `${short(state.a)} better` : "Same";
      score.innerHTML = `<span class="pair">${inTop(p.a)} → ${inTop(p.b)} of ${p.a.gold.length}</span><span class="delta ${d > 1e-9 ? "up" : d < -1e-9 ? "down" : ""}"></span>`;
      score.lastChild.textContent = verdict;
      score.title = `Needed files in the top 10: ${short(state.a)} ${inTop(p.a)}, ${short(state.b)} ${inTop(p.b)}`;
      row.append(what, strips, score);
      row.addEventListener("click", () => {
        state.open = state.open === p.a.id ? null : p.a.id;
        try { history.replaceState(null, "", state.open ? `#${state.open}` : location.pathname); } catch {}
        render();
      });
      li.append(row);
      if (state.open === p.a.id) li.append(detail(p));
      ol.append(li);
    }
    $("more").hidden = state.showAll || !!state.q || shown.length <= PAGE;
  }

  function bind() {
    $("repo").addEventListener("change", (e) => { state.repo = e.target.value; render(); });
    $("a").addEventListener("change", (e) => { state.a = e.target.value; if (state.b === state.a) state.b = variantsFor(state.split).find((v) => v !== state.a); syncControls(); render(); });
    $("b").addEventListener("change", (e) => { state.b = e.target.value; if (state.a === state.b) state.a = variantsFor(state.split).find((v) => v !== state.b); syncControls(); render(); });
    $("sort").addEventListener("change", (e) => { state.sort = e.target.value; render(); });
    $("q").addEventListener("input", (e) => { state.q = e.target.value; render(); });
    $("controls").addEventListener("submit", (e) => e.preventDefault());
    document.querySelectorAll("[data-split]").forEach((b) => b.addEventListener("click", () => { state.split = b.dataset.split; syncControls(); render(); }));
    $("more").querySelector("button").addEventListener("click", () => { state.showAll = true; render(); });
  }

  fetch("data/runs.json").then((r) => r.json()).then((d) => {
    data = d;
    $("generated").textContent = `Benchmark runs · generated ${d.generated}`;
    if (state.open) {
      // A shared link to a task opens it with every task visible, in whatever split holds it.
      state.showAll = true;
      for (const r of Object.values(d.repos)) for (const [split, runs] of Object.entries(r.splits)) if (Object.values(runs).some((ts) => ts.some((t) => t.id === state.open))) state.split = split;
    }
    syncControls();
    bind();
    render();
    if (state.open) document.getElementById(state.open)?.scrollIntoView({ block: "center" });
  }).catch(() => {
    $("tasks").innerHTML = '<li class="empty">Unable to load the run data. Reload the page to try again.</li>';
  });
})();
