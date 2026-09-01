/* RCA Generator — frontend
 * Parses Jira "XML export" (RSS-style) files entirely client-side, sends each
 * ticket's raw fields to the Cloudflare Worker for AI drafting, then builds a
 * .pptx client-side (via PptxGenJS) that reproduces the EC-61 RCA template.
 */

/* ---------------------------- Auth ---------------------------- */

const loginScreen = document.getElementById("login-screen");
const appScreen = document.getElementById("app-screen");
const passwordInput = document.getElementById("password-input");
const loginBtn = document.getElementById("login-btn");
const loginError = document.getElementById("login-error");

function getPassword() {
  return sessionStorage.getItem("rca_pw") || "";
}

async function tryLogin(pw) {
  loginError.textContent = "";
  loginBtn.disabled = true;
  try {
    const resp = await fetch(`${WORKER_URL}/check-password`, {
      method: "POST",
      headers: { "X-App-Password": pw },
    });
    if (resp.ok) {
      sessionStorage.setItem("rca_pw", pw);
      showApp();
    } else {
      loginError.textContent = "Wrong password.";
    }
  } catch (e) {
    loginError.textContent = "Could not reach the server. Check WORKER_URL in config.js.";
  } finally {
    loginBtn.disabled = false;
  }
}

function showApp() {
  loginScreen.classList.remove("active");
  appScreen.style.display = "block";
}

loginBtn.addEventListener("click", () => tryLogin(passwordInput.value));
passwordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") tryLogin(passwordInput.value);
});
document.getElementById("logout-btn").addEventListener("click", () => {
  sessionStorage.removeItem("rca_pw");
  appScreen.style.display = "none";
  loginScreen.classList.add("active");
});

if (getPassword()) {
  appScreen.style.display = "block";
} else {
  appScreen.style.display = "none";
}

/* ------------------------- XML parsing ------------------------- */

function stripHtml(html) {
  if (!html) return "";
  const div = document.createElement("div");
  div.innerHTML = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n");
  let text = div.textContent || "";
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  return text;
}

function textOf(parent, tag) {
  const el = parent.querySelector(tag);
  return el ? el.textContent : "";
}

function parseJiraXml(xmlString) {
  const doc = new DOMParser().parseFromString(xmlString, "application/xml");
  const perr = doc.querySelector("parsererror");
  if (perr) throw new Error("Could not parse this file as XML.");

  const items = Array.from(doc.querySelectorAll("channel > item"));
  return items.map((it) => {
    const comments = Array.from(it.querySelectorAll("comments > comment")).map((c) => ({
      author: c.getAttribute("author") || "",
      date: c.getAttribute("created") || "",
      text: stripHtml(c.textContent),
    }));
    return {
      key: textOf(it, "key"),
      summary: textOf(it, "summary"),
      type: textOf(it, "type"),
      priority: textOf(it, "priority"),
      status: textOf(it, "status"),
      resolution: textOf(it, "resolution"),
      assignee: textOf(it, "assignee"),
      reporter: textOf(it, "reporter"),
      created: textOf(it, "created"),
      updated: textOf(it, "updated"),
      project: textOf(it, "project"),
      description: stripHtml(textOf(it, "description")),
      comments,
    };
  });
}

/* --------------------------- UI state --------------------------- */

let allTickets = []; // { ...fields, _include: bool }

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
const ticketsCard = document.getElementById("tickets-card");
const generateCard = document.getElementById("generate-card");
const tbody = document.getElementById("ticket-table-body");
const skipKeysInput = document.getElementById("skip-keys");

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("drag"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("drag");
  handleFiles(e.dataTransfer.files);
});
fileInput.addEventListener("change", (e) => handleFiles(e.target.files));

async function handleFiles(fileList) {
  const files = Array.from(fileList).filter((f) => f.name.toLowerCase().endsWith(".xml"));
  if (!files.length) return;

  const byKey = new Map(allTickets.map((t) => [t.key, t]));
  for (const file of files) {
    const text = await file.text();
    let parsed;
    try {
      parsed = parseJiraXml(text);
    } catch (e) {
      alert(`${file.name}: ${e.message}`);
      continue;
    }
    for (const t of parsed) {
      t._include = true;
      byKey.set(t.key, t); // last file wins on duplicate keys
    }
  }
  allTickets = Array.from(byKey.values());
  renderTicketTable();
}

function renderTicketTable() {
  if (!allTickets.length) {
    ticketsCard.style.display = "none";
    generateCard.style.display = "none";
    return;
  }
  ticketsCard.style.display = "block";
  generateCard.style.display = "block";

  const skipSet = parseSkipKeys();
  tbody.innerHTML = "";
  for (const t of allTickets) {
    if (skipSet.has(t.key)) t._include = false;
    const tr = document.createElement("tr");
    if (!t._include) tr.classList.add("skipped");
    tr.innerHTML = `
      <td><input type="checkbox" data-key="${t.key}" ${t._include ? "checked" : ""} /></td>
      <td><strong>${t.key}</strong></td>
      <td>${escapeHtml(t.summary || "(no summary)")}</td>
      <td><span class="status-pill status-${t.status}">${t.status || "?"}</span></td>
      <td>${escapeHtml(t.type || "")}</td>
    `;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener("change", () => {
      const t = allTickets.find((x) => x.key === cb.dataset.key);
      t._include = cb.checked;
      cb.closest("tr").classList.toggle("skipped", !cb.checked);
      updateGenerateSummary();
    });
  });
  updateGenerateSummary();
}

function parseSkipKeys() {
  return new Set(
    skipKeysInput.value
      .split(/[\s,]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
  );
}

skipKeysInput.addEventListener("input", () => {
  const skipSet = parseSkipKeys();
  for (const t of allTickets) {
    t._include = !skipSet.has(t.key);
  }
  renderTicketTable();
});

document.getElementById("select-all-btn").addEventListener("click", () => {
  allTickets.forEach((t) => (t._include = true));
  renderTicketTable();
});
document.getElementById("select-none-btn").addEventListener("click", () => {
  allTickets.forEach((t) => (t._include = false));
  renderTicketTable();
});

function updateGenerateSummary() {
  const n = allTickets.filter((t) => t._include).length;
  document.getElementById("generate-summary").textContent =
    n === 0 ? "No tickets selected" : `${n} ticket${n === 1 ? "" : "s"} selected`;
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

/* ------------------------- AI call ------------------------- */

async function summarizeTicket(ticket) {
  const resp = await fetch(`${WORKER_URL}/summarize`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-App-Password": getPassword() },
    body: JSON.stringify({
      key: ticket.key,
      summary: ticket.summary,
      type: ticket.type,
      priority: ticket.priority,
      status: ticket.status,
      resolution: ticket.resolution,
      assignee: ticket.assignee,
      reporter: ticket.reporter,
      created: ticket.created,
      updated: ticket.updated,
      project: ticket.project,
      description: ticket.description,
      comments: ticket.comments,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Worker error (${resp.status}): ${body}`);
  }
  return resp.json();
}

/* ------------------------- Date helpers ------------------------- */

function formatHeaderDate(rfc822) {
  const d = new Date(rfc822);
  if (isNaN(d)) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${mm}/${dd}/${yy}`;
}

/* ------------------------- PPTX building ------------------------- */

const NAVY = "0A2972";
const LIGHT = "E8ECF7";
const PEACH = "F7D9D9";
const GREY = "D9D9D9";
const LABEL_FILL = "F2F2F2";
const BORDER = { type: "solid", color: "BFBFBF", pt: 0.75 };

const PHASE_ROW = { Investigation: 0, "Root Cause": 1, Implementation: 2, Verification: 3 };

function fitTitleFontSize(text) {
  const n = text.length;
  if (n > 90) return 10;
  if (n > 75) return 11;
  if (n > 60) return 12;
  if (n > 45) return 13;
  return 14;
}

function addHeader(slide, headerText) {
  slide.addImage({ path: "assets/header_band.png", x: 0, y: 0, w: 13.333, h: 0.64 });
  slide.addText(headerText, {
    x: 2.7, y: 0.03, w: 10.4, h: 0.55,
    fontSize: fitTitleFontSize(headerText), bold: true, color: NAVY,
    fontFace: "Arial", align: "left", valign: "middle",
  });
  slide.addImage({ path: "assets/footer_line.png", x: 0, y: 7.14, w: 13.333, h: 0.06 });
  slide.addText("CONFIDENTIAL — HAEA Internal Use Only", {
    x: 0, y: 7.2, w: 13.333, h: 0.25, fontSize: 9, color: "999999",
    align: "center", fontFace: "Arial",
  });
}

function cell(text, opts) {
  return { text: text == null ? "" : String(text), options: Object.assign({ fontSize: 12, fontFace: "Arial", valign: "middle", border: BORDER, color: "202020" }, opts) };
}

// Table area is centered on the 13.333in-wide slide, using most of its width.
const TABLE_X = 0.443;
const TABLE_W = 12.448;

function buildMainTable(slide, t) {
  const colW = [2.969, 1.856, 0.756, 0.628, 1.411, 0.836, 0.628, 1.255, 0.286, 0.341, 0.286, 1.196];

  const rcY = t.rc_clear === "Y" ? "Y" : t.rc_clear === "N" ? "" : "N/A";
  const rcN = t.rc_clear === "N" ? "N" : "";
  const rcFillY = t.rc_clear === "N/A" ? GREY : "9BBB59";
  const rcFillN = t.rc_clear === "N/A" ? GREY : "FF0000";

  const phaseRow = ["", "", "", ""];
  const idx = PHASE_ROW[t.phase];
  if (idx !== undefined) phaseRow[idx] = "X";

  const rows = [
    // Row 0
    [
      cell("Incident Description", { fill: { color: LABEL_FILL }, bold: true }),
      cell(t.incident, { colspan: 11, align: "left" }),
    ],
    // Row 1
    [
      cell("Root Cause", { fill: { color: LABEL_FILL }, bold: true }),
      cell("Is Root Cause Clear?", { fill: { color: LABEL_FILL }, bold: true, fontSize: 10 }),
      cell(rcY, { fill: { color: rcFillY }, align: "center", bold: true }),
      cell(rcN, { fill: { color: rcFillN }, align: "center", bold: true }),
      cell("Owner", { fill: { color: LABEL_FILL }, bold: true }),
      cell(t.owner, { colspan: 7 }),
    ],
    // Row 2
    [
      cell(t.root_cause, { colspan: 4, rowspan: 4, valign: "top", align: "left" }),
      cell("Investigation", { fill: { color: LABEL_FILL }, bold: true, fontSize: 10, align: "center" }),
      cell("Root Cause", { colspan: 2, fill: { color: LABEL_FILL }, bold: true, fontSize: 10, align: "center" }),
      cell("Implementation", { colspan: 2, fill: { color: LABEL_FILL }, bold: true, fontSize: 10, align: "center" }),
      cell("Verification", { colspan: 3, fill: { color: LABEL_FILL }, bold: true, fontSize: 10, align: "center" }),
    ],
    // Row 3 (phase bar)
    [
      cell(phaseRow[0], { fill: { color: "FF0000" }, align: "center", bold: true }),
      cell(phaseRow[1], { colspan: 2, fill: { color: "FFC000" }, align: "center", bold: true }),
      cell(phaseRow[2], { colspan: 2, fill: { color: "FFFF00" }, align: "center", bold: true }),
      cell(phaseRow[3], { colspan: 3, fill: { color: "9BBB59" }, align: "center", bold: true }),
    ],
    // Row 4
    [
      cell(`Customer Impact : ${t.impact}`, { colspan: 3, fill: { color: LABEL_FILL }, bold: true, fontSize: 10 }),
      cell("# of impacted customers", { colspan: 4, fill: { color: LABEL_FILL }, bold: true, fontSize: 10 }),
      cell(t.impacted, { fontSize: 10, align: "center" }),
    ],
    // Row 5
    [cell(t.impact_detail, { colspan: 8, align: "left" })],
    // Row 6
    [
      cell("Interim Corrective Action", { fill: { color: LABEL_FILL }, bold: true, fontSize: 10 }),
      cell("Implementation date", { fill: { color: LABEL_FILL }, bold: true, fontSize: 9 }),
      cell(t.interim_date, { colspan: 2, align: "center" }),
      cell("Permanent Corrective Action", { colspan: 2, fill: { color: LABEL_FILL }, bold: true, fontSize: 10 }),
      cell("Implementation date:", { colspan: 2, fill: { color: LABEL_FILL }, bold: true, fontSize: 9 }),
      cell(t.permanent_date, { colspan: 4, align: "center" }),
    ],
    // Row 7
    [
      cell(t.interim, { colspan: 4, rowspan: 3, valign: "top", align: "left" }),
      cell(t.permanent, { colspan: 8, align: "left" }),
    ],
    // Row 8
    [
      cell("Monitoring", { colspan: 3, fill: { color: LABEL_FILL }, bold: true, fontSize: 10 }),
      cell("Implementation date:", { colspan: 3, fill: { color: LABEL_FILL }, bold: true, fontSize: 9 }),
      cell(t.monitoring_date, { colspan: 2, align: "center" }),
    ],
    // Row 9
    [cell(t.monitoring, { colspan: 8, align: "left" })],
  ];

  slide.addTable(rows, { x: TABLE_X, y: 0.75, w: TABLE_W, colW, autoPage: false });
}

async function buildDeck(pptxgen, ticket, ai) {
  const pptx = new pptxgen();
  pptx.defineLayout({ name: "WIDE", width: 13.333, height: 7.5 });
  pptx.layout = "WIDE";

  const headerDate = formatHeaderDate(ticket.updated);
  const titleOnly = `${ticket.key} – ${ticket.summary}`;
  const header = `${ticket.key} – ${ticket.summary} – ${headerDate}`;

  // Slide 1: title
  const s1 = pptx.addSlide();
  s1.addImage({ path: "assets/title_bg.png", x: 0, y: 0, w: 13.333, h: 7.5 });
  s1.addText(titleOnly, {
    x: 0.17, y: 2.0, w: 4.78, h: 2.83,
    fontSize: 20, bold: true, color: "FFFFFF", fontFace: "Arial", valign: "top", align: "left",
  });

  // Slide 2: main RCA table
  const s2 = pptx.addSlide();
  addHeader(s2, header);
  buildMainTable(s2, { ...ticket, ...ai });

  // Slide 3: diagram
  const s3 = pptx.addSlide();
  addHeader(s3, header);
  s3.addTable(
    [
      [cell("Incident Description", { fill: { color: LABEL_FILL }, bold: true }), cell(ai.short_incident, { align: "left" })],
      [cell("Incident Diagram", { fill: { color: LABEL_FILL }, bold: true }), cell("Shown Below", { align: "left" })],
    ],
    { x: TABLE_X, y: 0.75, w: TABLE_W, colW: [2.969, 9.479], border: BORDER, fontSize: 12, fontFace: "Arial" }
  );
  s3.addText(`Failure/response flow for ${ticket.key} (based on ticket description)`, {
    x: TABLE_X, y: 1.9, w: TABLE_W, h: 0.4, italic: true, fontSize: 13, fontFace: "Arial", color: "333333",
  });

  const steps = (ai.diagram && ai.diagram.length === 4) ? ai.diagram : ["", "", "", ""];
  const gap = 0.3;
  const totalW = TABLE_W;
  const boxW = (totalW - gap * 3) / 4;
  const boxH = 1.6;
  const startX = TABLE_X;
  const y = 2.45;
  for (let i = 0; i < 4; i++) {
    const x = startX + i * (boxW + gap);
    s3.addShape("roundRect", {
      x, y, w: boxW, h: boxH,
      fill: { color: i === 3 ? PEACH : LIGHT },
      line: { color: NAVY, width: 1.5 },
      rectRadius: 0.08,
    });
    s3.addText(steps[i].replace(/\\n/g, "\n"), {
      x, y, w: boxW, h: boxH,
      fontSize: 12, color: NAVY, bold: i === 3, align: "center", valign: "middle", fontFace: "Arial",
      breakLine: true,
    });
    if (i < 3) {
      s3.addShape("line", {
        x: x + boxW, y: y + boxH / 2, w: gap, h: 0,
        line: { color: NAVY, width: 2.25 },
      });
    }
  }

  // Slide 4: static closing slide (unchanged company boilerplate)
  const s4 = pptx.addSlide();
  s4.addImage({ path: "assets/vision_slide.png", x: 0, y: 0, w: 13.333, h: 7.5 });

  return pptx;
}

/* ------------------------- Generate flow ------------------------- */

const generateBtn = document.getElementById("generate-btn");
const progressList = document.getElementById("progress-list");

generateBtn.addEventListener("click", runGenerate);

function setProgress(key, state, msg) {
  let row = document.getElementById(`prog-${key}`);
  if (!row) {
    row = document.createElement("div");
    row.className = "item";
    row.id = `prog-${key}`;
    row.innerHTML = `<span>${key}</span><span class="pstate"></span>`;
    progressList.appendChild(row);
  }
  const pill = row.querySelector(".pstate");
  pill.className = `pstate pstate-${state}`;
  pill.textContent = msg;
}

async function runGenerate() {
  const selected = allTickets.filter((t) => t._include);
  if (!selected.length) return;

  generateBtn.disabled = true;
  progressList.innerHTML = "";
  selected.forEach((t) => setProgress(t.key, "pending", "queued"));

  const built = []; // { key, blob }

  for (const ticket of selected) {
    setProgress(ticket.key, "working", "drafting with AI…");
    try {
      const ai = await summarizeTicket(ticket);
      setProgress(ticket.key, "working", "building slides…");
      const pptx = await buildDeck(window.PptxGenJS, ticket, ai);
      const blob = await pptx.write({ outputType: "blob" });
      built.push({ key: ticket.key, blob });
      setProgress(ticket.key, "done", "done");
    } catch (e) {
      console.error(e);
      setProgress(ticket.key, "error", e.message || "failed");
    }
  }

  generateBtn.disabled = false;
  if (!built.length) return;

  if (built.length === 1) {
    downloadBlob(built[0].blob, `${built[0].key}_RCA.pptx`);
  } else {
    const zip = new JSZip();
    for (const b of built) zip.file(`${b.key}_RCA.pptx`, b.blob);
    const zipBlob = await zip.generateAsync({ type: "blob" });
    downloadBlob(zipBlob, `RCA_Decks_${new Date().toISOString().slice(0, 10)}.zip`);
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
