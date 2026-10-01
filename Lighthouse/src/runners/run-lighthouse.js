import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFlow } from "lighthouse";
import * as chromeLauncher from "chrome-launcher";
import puppeteer from "puppeteer";

import lhConfig from "../config/lighthouse.config.cjs";
import { ensureResultsDir } from "../utils/report-paths.js";
import { placeOrderFlow } from "../flows/place-order.flow.js";

const APP_URL = process.env.APP_URL;
const RUNS = Number(process.env.LH_RUNS || "3");

if (!APP_URL) {
  console.error("Missing APP_URL in .env");
  process.exit(1);
}

// Row order EXACTLY like your screenshot
const SUMMARY_METRICS = [
  ["performance-score", "Performance"], // category score
  ["first-contentful-paint", "FCP"],
  ["largest-contentful-paint", "LCP"],
  ["total-blocking-time", "TBT"],
  ["cumulative-layout-shift", "CLS"],
  ["speed-index", "Speed Index"],
];

// Keep these page-wise too (same set)
const PAGEWISE_METRICS = SUMMARY_METRICS;

function safeRm(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// To embed each loop HTML inside <iframe srcdoc="...">
function escapeForSrcdoc(html) {
  return html
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&#60;")
    .replace(/>/g, "&#62;");
}

function median(nums) {
  const arr = nums.filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

function fmt(label, value) {
  if (value == null) return "n/a";
  if (label === "Performance") return String(Math.round(value)); // just number (no %)
  if (label === "CLS") return value.toFixed(3); // typical CLS formatting
  // ms metrics: show integer ms only (no "ms" text to match your simple grid style)
  return String(Math.round(value));
}

async function runOneLoop(loopIndex) {
  // Fresh profile per loop to avoid cookie/cache bleed
  const chromeProfileDir = path.join(os.tmpdir(), `lh-profile-loop${loopIndex}-${Date.now()}`);
  safeRm(chromeProfileDir);
  fs.mkdirSync(chromeProfileDir, { recursive: true });

  const chrome = await chromeLauncher.launch({
    chromeFlags: [
      "--headless=new",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--user-data-dir=${chromeProfileDir}`,
    ],
  });

  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${chrome.port}`,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  page.setDefaultTimeout(60000);
  page.setDefaultNavigationTimeout(60000);

  const flow = await startFlow(page, {
    config: lhConfig,
    flags: { logLevel: "error" },
  });

  try {
    await placeOrderFlow(page, APP_URL, flow);

    const flowResult = await flow.createFlowResult();
    const steps = flowResult.steps.map((s) => ({ name: s.name, lhr: s.lhr }));

    // Page-wise table data for this loop
    const pageWiseRows = steps.map(({ name, lhr }) => {
      const row = { Page: name };

      // Performance score
      row["Performance"] = Math.round(lhr.categories.performance.score * 100);

      // Audits
      for (const [id, label] of PAGEWISE_METRICS) {
        if (id === "performance-score") continue;
        row[label] = lhr.audits[id]?.numericValue ?? null;
      }
      return row;
    });

    // Loop summary = median across pages
    const loopSummary = {};
    loopSummary["Performance"] = median(steps.map((s) => s.lhr.categories.performance.score * 100));

    for (const [id, label] of SUMMARY_METRICS) {
      if (id === "performance-score") continue;
      const values = steps
        .map((s) => s.lhr.audits[id]?.numericValue)
        .filter((v) => Number.isFinite(v));
      loopSummary[label] = median(values);
    }

    // Full Lighthouse flow report (contains page-wise steps)
    const loopHtml = await flow.generateReport();

    return { loopIndex, loopSummary, pageWiseRows, loopHtml };
  } finally {
    try { await browser.disconnect(); } catch {}
    try { await chrome.kill(); } catch {}
    safeRm(chromeProfileDir);
  }
}

function buildSummaryMatrix(loopReports) {
  const loops = loopReports.map((r) => r.loopIndex);

  const header = `
    <tr>
      <th class="metricCol">Metric</th>
      ${loops.map((i) => `<th>Loop ${i}</th>`).join("")}
    </tr>`;

  const rows = SUMMARY_METRICS.map(([, label]) => {
    const cells = loopReports
      .map((r) => `<td>${fmt(label, r.loopSummary[label])}</td>`)
      .join("");
    return `<tr><td class="metricName">${label}</td>${cells}</tr>`;
  }).join("\n");

  return `
    <table class="matrix">
      <thead>${header}</thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function buildPageWiseTables(loopReports) {
  const cols = ["Page", ...SUMMARY_METRICS.map(([, label]) => label)];

  return loopReports
    .map((r) => {
      const thead = `<tr>${cols.map((c) => `<th>${c}</th>`).join("")}</tr>`;
      const tbody = r.pageWiseRows
        .map((row) => {
          const tds = cols
            .map((c) => {
              if (c === "Page") return `<td>${row.Page}</td>`;
              if (c === "Performance") return `<td>${row["Performance"]}</td>`;
              return `<td>${fmt(c, row[c])}</td>`;
            })
            .join("");
          return `<tr>${tds}</tr>`;
        })
        .join("\n");

      return `
        <details style="margin:12px 0;">
          <summary style="cursor:pointer; font:16px system-ui;">Loop ${r.loopIndex} — page-wise table</summary>
          <table class="matrix" style="margin-top:10px;">
            <thead>${thead}</thead>
            <tbody>${tbody}</tbody>
          </table>
        </details>`;
    })
    .join("\n");
}

function buildEmbeddedReports(loopReports) {
  return loopReports
    .map((r) => {
      const srcdoc = escapeForSrcdoc(r.loopHtml);
      return `
        <details ${r.loopIndex === 1 ? "open" : ""} style="margin:12px 0;">
          <summary style="cursor:pointer; font:16px system-ui;">
            Loop ${r.loopIndex} — full Lighthouse flow report (page-wise steps)
          </summary>
          <iframe
            style="width:100%; height:900px; border:1px solid #ddd; margin-top:10px;"
            sandbox="allow-same-origin allow-scripts allow-forms"
            srcdoc="${srcdoc}">
          </iframe>
        </details>`;
    })
    .join("\n");
}

function buildMasterHtml(runId, loopReports) {
  const summaryMatrix = buildSummaryMatrix(loopReports);
  const pageWiseTables = buildPageWiseTables(loopReports);
  const embeddedReports = buildEmbeddedReports(loopReports);

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Lighthouse Order Flow - All Loops - ${runId}</title>
  <style>
    body { margin: 16px; font-family: system-ui, Arial, sans-serif; }
    .tabs { margin-top: 14px; }
    .tabbtn { padding: 8px 10px; border: 1px solid #aaa; background: #fff; cursor: pointer; }
    .tabbtn.active { background: #f3f3f3; font-weight: 600; }
    .tab { display:none; margin-top: 12px; }
    .tab.active { display:block; }

    /* Table styling (kept simple like your screenshot) */
    .matrix { border-collapse: collapse; width: 100%; max-width: 1200px; }
    .matrix th, .matrix td { border: 1px solid #111; padding: 8px; vertical-align: top; }
    .matrix th { background: #fff; font-weight: 700; }
    .metricCol { width: 180px; text-align: left; }
    .metricName { font-weight: 700; }
  </style>
</head>
<body>
  <h1>Lighthouse Order Flow — All Loops</h1>
  <div>Run: <b>${runId}</b> | Loops: <b>${loopReports.length}</b></div>

  <div class="tabs">
    <button class="tabbtn active" data-tab="summary">Summary</button>
    <button class="tabbtn" data-tab="pagewise">Page-wise tables</button>
    <button class="tabbtn" data-tab="full">Full LH reports</button>
  </div>

  <div id="summary" class="tab active">
    <h2>Summary (loop-wise)</h2>
    ${summaryMatrix}
    <p style="max-width:1200px;">
      Note: each Loop value is the <b>median across pages/steps</b> of that loop’s Lighthouse flow.
    </p>
  </div>

  <div id="pagewise" class="tab">
    <h2>Page-wise metrics (per loop)</h2>
    ${pageWiseTables}
  </div>

  <div id="full" class="tab">
    <h2>Full Lighthouse flow reports (per loop)</h2>
    ${embeddedReports}
  </div>

  <script>
    const btns = document.querySelectorAll(".tabbtn");
    const tabs = document.querySelectorAll(".tab");
    btns.forEach(b => {
      b.addEventListener("click", () => {
        btns.forEach(x => x.classList.remove("active"));
        tabs.forEach(t => t.classList.remove("active"));
        b.classList.add("active");
        document.getElementById(b.dataset.tab).classList.add("active");
      });
    });
  </script>
</body>
</html>`;
}

(async () => {
  const resultsDir = ensureResultsDir();
  const runId = stamp();

  const loopReports = [];
  for (let i = 1; i <= RUNS; i++) {
    console.log(`Running loop ${i}/${RUNS}...`);
    loopReports.push(await runOneLoop(i));
  }

  const masterHtml = buildMasterHtml(runId, loopReports);
  const outPath = path.join(resultsDir, `order-flow-${runId}.ALL-LOOPS.report.html`);
  fs.writeFileSync(outPath, masterHtml);

  console.log(`\nSingle consolidated report written: ${outPath}`);
})();