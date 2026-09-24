const base = document.documentElement.dataset.base || ".";
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

const COMMANDS = [
  { label: "Home", hint: "page", href: `${base}/` },
  { label: "Findings: the benchmark", hint: "page", href: `${base}/findings.html` },
  { label: "Run explorer: every test, two tools side by side", hint: "page", href: `${base}/explorer.html` },
  { label: "Install", hint: "page", href: `${base}/#install` },
  { label: "Blog", hint: "page", href: `${base}/blog/` },
  { label: "How the ranking works", hint: "post", href: `${base}/blog/how-it-ranks.html` },
  { label: "What the tests showed", hint: "post", href: `${base}/blog/what-we-measured.html` },
  { label: "Copy: npx @taanviir/context-packer pack", hint: "copy", copy: 'npx -y @taanviir/context-packer pack "describe the change"' },
  { label: "Copy: /plugin marketplace add", hint: "copy", copy: "/plugin marketplace add Taanviir/context-packer" },
  { label: "Copy: claude mcp add", hint: "copy", copy: "claude mcp add context-packer -- npx -y @taanviir/context-packer mcp" },
  { label: "Source on GitHub", hint: "link", href: "https://github.com/Taanviir/context-packer" },
  { label: "Package on npm", hint: "link", href: "https://www.npmjs.com/package/@taanviir/context-packer" },
];

const status = document.createElement("div");
status.className = "visually-hidden";
status.setAttribute("role", "status");
document.body.append(status);
const announce = (text) => { status.textContent = ""; requestAnimationFrame(() => { status.textContent = text; }); };

function palette() {
  const root = document.createElement("div");
  root.className = "palette";
  root.innerHTML = `<div class="palette-box" role="dialog" aria-modal="true" aria-label="Command palette">
    <input type="text" role="combobox" aria-expanded="true" aria-controls="palette-list" aria-autocomplete="list" placeholder="Jump to a page or copy a command" aria-label="Search pages and commands" autocomplete="off" />
    <ul role="listbox" id="palette-list" aria-label="Results"></ul></div>`;
  document.body.append(root);
  const input = root.querySelector("input");
  const list = root.querySelector("ul");
  let items = COMMANDS;
  let selected = 0;
  let opener = null;

  const render = () => {
    list.innerHTML = "";
    input.removeAttribute("aria-activedescendant");
    if (!items.length) {
      const li = document.createElement("li");
      li.className = "palette-empty";
      li.textContent = "Nothing matches. Try \"install\" or \"blog\".";
      list.append(li);
      return;
    }
    items.forEach((c, i) => {
      const li = document.createElement("li");
      li.id = `palette-${i}`;
      if (i === selected) input.setAttribute("aria-activedescendant", li.id);
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", String(i === selected));
      li.innerHTML = `<span></span><span class="hint"></span>`;
      li.children[0].textContent = c.label;
      li.children[1].textContent = c.hint;
      li.addEventListener("click", () => run(c));
      list.append(li);
    });
  };
  const open = () => {
    opener = document.activeElement;
    root.classList.add("is-open");
    input.value = "";
    items = COMMANDS;
    selected = 0;
    render();
    input.focus();
  };
  const close = () => {
    root.classList.remove("is-open");
    opener?.focus();
  };
  const run = async (c) => {
    if (c.copy) {
      const ok = await navigator.clipboard?.writeText(c.copy).then(() => true, () => false);
      announce(ok ? `Copied ${c.copy}` : "Unable to copy. Select the command on the page and copy it.");
    }
    close();
    if (c.href) location.href = c.href;
  };
  input.addEventListener("input", () => {
    const q = input.value.toLowerCase();
    items = COMMANDS.filter((c) => c.label.toLowerCase().includes(q));
    selected = 0;
    render();
  });
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown") { selected = Math.min(items.length - 1, selected + 1); render(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { selected = Math.max(0, selected - 1); render(); e.preventDefault(); }
    else if (e.key === "Enter" && items[selected]) run(items[selected]);
    else if (e.key === "Tab") { input.focus(); e.preventDefault(); }
  });
  root.addEventListener("click", (e) => { if (e.target === root) close(); });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); root.classList.contains("is-open") ? close() : open(); }
  });
  document.querySelectorAll("[data-palette]").forEach((b) => b.addEventListener("click", open));
}

function copyButtons() {
  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const text = button.dataset.copy;
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = "Copied";
        announce("Copied");
      } catch {
        button.textContent = "Select and copy";
        announce("Unable to copy. Select the command and copy it.");
      }
      setTimeout(() => { button.textContent = "Copy"; }, 1600);
    });
  });
}

function reveals() {
  const targets = document.querySelectorAll(".reveal");
  if (reduced || !("IntersectionObserver" in window)) return targets.forEach((t) => t.classList.add("is-in"));
  const io = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); }
  }), { rootMargin: "0px 0px -10% 0px" });
  targets.forEach((t) => io.observe(t));
}

/** The hero figure counts up once from zero; reduced motion shows the final value. */
function tick() {
  const el = document.querySelector("[data-tick]");
  if (!el || reduced) return;
  const target = Number(el.dataset.tick);
  const digits = (el.dataset.tick.split(".")[1] || "").length;
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / 600);
    el.textContent = (target * (1 - (1 - t) ** 3)).toFixed(digits);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

palette();
copyButtons();
reveals();
tick();
