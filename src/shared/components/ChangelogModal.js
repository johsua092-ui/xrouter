"use client";

import { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import { marked } from "marked";
import { GO_SOURCE, NODE_SOURCE, DECOLUA_SOURCE, DEFAULT_CHANGELOG_SOURCE, availableChangelogSources, pickChangelogSource } from "./changelogSources.js";

marked.setOptions({ gfm: true, breaks: true });

const DECOLUA_URL = "https://raw.githubusercontent.com/decolua/9router/refs/heads/master/CHANGELOG.md";
const SERENHOPE_URL = "https://raw.githubusercontent.com/johsua092-ui/xrouter/refs/heads/main/CHANGELOG.md";
const CHANGELOG_API_URL = "/api/changelog";

function asMarkdown(value) {
  if (typeof value !== "string") return "";
  return value.trim() ? value : "";
}

async function fetchJson(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchText(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return "";
    return await res.text();
  } catch {
    return "";
  }
}

// Local endpoint first (works offline and before any push), raw GitHub only for what it lacks.
async function loadChangelogs() {
  const local = await fetchJson(CHANGELOG_API_URL);
  let goMd = asMarkdown(local?.go || local?.custom);
  let nodeMd = asMarkdown(local?.node);
  let decoluaMd = asMarkdown(local?.official);

  if (!goMd && !nodeMd && !decoluaMd) {
    return Promise.all([fetchText(SERENHOPE_URL), "", fetchText(DECOLUA_URL)]);
  }
  if (!decoluaMd) decoluaMd = await fetchText(DECOLUA_URL);
  if (!goMd) goMd = await fetchText(SERENHOPE_URL);
  return [goMd, nodeMd, decoluaMd];
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Split markdown into per-version sections.
// A version boundary is an h1/h2 heading whose text starts with an optional "v" + digit,
// e.g. "# v0.5.71-Custom (2026-09-10)" or "## v0.5.65". Sub-headings like "## Features"
// are intentionally NOT treated as boundaries.
function splitVersions(md) {
  if (!md) return [];
  const lines = md.split("\n");
  const sections = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^ {0,3}#{1,2}\s+(v?\d[^\n]*)$/i);
    if (m) {
      if (cur) sections.push(cur);
      cur = { title: m[1].trim(), body: "" };
    } else if (cur) {
      cur.body += line + "\n";
    }
  }
  if (cur) sections.push(cur);
  return sections;
}

// One card per day: thirty releases on one date read as one block, not thirty borders.
function groupByReleaseDate(sections) {
 const groups = [];
 const byDate = new Map();
 for (const section of sections) {
 const date = (section.title.match(/\((\d{4}-\d{2}-\d{2})\)/) || [])[1] || section.title;
 const commits = (section.title.match(/·\s*(\d+)\s+commit/) || [])[1];
 if (!byDate.has(date)) {
 const group = { date, items: [] };
 byDate.set(date, group);
 groups.push(group);
 }
 byDate.get(date).items.push({ ...section, commits: commits ? Number(commits) : null });
 }
 return groups;
}

function renderBody(bodyMd) {
 if (!bodyMd.trim()) return "";
 const demoted = bodyMd.replace(/^#{2,6}\s/gm, (m) => "#".repeat(Math.min(6, m.length + 2)) + " ");
 return marked.parse(demoted);
}

// A merged day card concatenates several patch bodies, each carrying its own
// ## Features / ## Fixes headings. Split every body on its h2 sub-headings and
// rejoin items under one heading each, keeping the order the headings first
// appear in — so Fixes shows once with all fixes, not four times.
function mergeBodiesByCategory(bodies) {
 const order = [];
 const byCat = new Map();
 for (const body of bodies) {
 let current = null;
 for (const line of String(body || "").split("\n")) {
 const m = line.match(/^#{2,6}\s+(.+?)\s*$/);
 if (m) {
 current = m[1].trim();
 if (!byCat.has(current)) {
 byCat.set(current, []);
 order.push(current);
 }
 } else if (current) {
 byCat.get(current).push(line);
 }
 }
 }
 return order
 .map((cat) => `## ${cat}\n${byCat.get(cat).join("\n").replace(/\n+$/, "")}`)
 .join("\n\n");
}

function renderVersionCards(md, accent) {
 const sections = splitVersions(md);
 const cardStyle = `margin:0 0 14px;padding:12px 14px;border:1px solid ${accent.border};border-radius:12px;background:${accent.bg};box-sizing:border-box;max-width:100%;min-width:0;overflow-wrap:anywhere;word-break:break-word;`;
 const titleStyle = `margin:0 0 10px;font-size:15px;font-weight:700;color:${accent.color};display:flex;align-items:center;gap:8px;`;
 const subStyle = `margin:16px 0 8px;font-size:13.5px;font-weight:700;color:${accent.color};opacity:.9;`;
 if (!sections.length) {
 const html = md ? marked.parse(md) : "";
 return html ? `<div style="${cardStyle}"><div class="changelog-body">${html}</div></div>` : "";
 }
 return groupByReleaseDate(sections)
 .map((group) => {
 // The newest release of the day titles the merged card, so it reads like any
 // other release ("v0.5.151 (2026-09-30)") instead of a bare date rollup.
 const versionOf = (s) => ((s.title.match(/v?(\d+(?:\.\d+)+)/) || [])[1] || "");
 const sortKey = (a, b) =>
 versionOf(a).localeCompare(versionOf(b), undefined, { numeric: true });
 const newest = [...group.items].sort(sortKey).pop();
 const head = group.items.length === 1
 ? group.items[0].title
 : newest.title.includes("(")
 ? newest.title
 : `${newest.title} (${group.date})`;
 const inner = group.items.length === 1
 ? renderBody(group.items[0].body)
 : renderBody(mergeBodiesByCategory(group.items.map((section) => section.body)));
 return `<div style="${cardStyle}">
 <h3 style="${titleStyle}">
 <span class="material-symbols-outlined" style="font-size:18px;">${accent.icon}</span>
 ${escapeHtml(head)}
 </h3>
 <div class="changelog-body">${inner}</div>
 </div>`;
 })
 .join("");
}

function buildSection(md, source) {
  const cards = renderVersionCards(md, source.accent);
  if (!cards) return "";
  const headStyle = `display:flex;align-items:center;gap:8px;margin:0 0 14px;font-size:17px;font-weight:600;color:${source.accent.color};`;
  return `<div style="${headStyle}">
  <span class="material-symbols-outlined" style="font-size:20px;">${source.accent.icon}</span>
  ${escapeHtml(source.heading)}
</div>
${cards}`;
}

export default function ChangelogModal({ isOpen, onClose }) {
  const [htmlBySource, setHtmlBySource] = useState({ go: "", node: "", decolua: "" });
  const [loaded, setLoaded] = useState(false);
  const [activeSource, setActiveSource] = useState(DEFAULT_CHANGELOG_SOURCE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const modalRef = useRef(null);

  useEffect(() => {
    if (!isOpen || loaded) return;
    let cancelled = false;
    setLoading(true);
    setError("");

    loadChangelogs()
      .then(([goMd, nodeMd, decoluaMd]) => {
        if (cancelled) return;
        setHtmlBySource({
          go: buildSection(goMd, GO_SOURCE),
          node: buildSection(nodeMd, NODE_SOURCE),
          decolua: buildSection(decoluaMd, DECOLUA_SOURCE),
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || "Failed to load changelog");
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setLoaded(true);
        }
      });

    return () => { cancelled = true; };
  }, [isOpen, loaded]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (modalRef.current && !modalRef.current.contains(e.target)) {
        onClose();
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen, onClose]);

  // Reset content when modal closes
  useEffect(() => {
    if (isOpen) return;
    setHtmlBySource({ go: "", node: "", decolua: "" });
    setLoaded(false);
    setActiveSource(DEFAULT_CHANGELOG_SOURCE);
  }, [isOpen]);

  if (!isOpen || typeof document === "undefined") return null;

  // Only offer a tab for a source that actually has content, and never leave
  // the active tab pointing at an empty one.
  const available = availableChangelogSources(htmlBySource);
  const shown = pickChangelogSource(htmlBySource, activeSource);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 overflow-x-hidden">
      <div
        className="absolute inset-0 bg-black/70"
        onClick={onClose}
      />
      <div
        ref={modalRef}
        className="relative w-full bg-surface border border-border rounded-[6px] shadow-[var(--shadow-elev)] animate-in fade-in zoom-in-95 duration-200 max-w-3xl flex flex-col max-h-[calc(min(100dvh,100svh)-2rem)] min-h-0 min-w-0 overflow-hidden"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 border-b border-border-subtle shrink-0 min-w-0">
          <div className="flex items-center justify-between w-full sm:w-auto">
            <h2 className="text-base sm:text-lg font-semibold text-text-main truncate">Change Log</h2>
            <button
              onClick={onClose}
              className="sm:hidden p-1 rounded-lg text-text-muted hover:text-text-main hover:bg-surface-2 transition-all"
            >
              <span className="material-symbols-outlined text-[20px]">close</span>
            </button>
          </div>
          <div className="flex items-center gap-2 overflow-x-auto max-w-full pb-1 sm:pb-0">
            {available.length > 1 && (
              <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-surface-2 shrink-0">
                {available.map((source) => (
                  <button
                    key={source.id}
                    type="button"
                    onClick={() => setActiveSource(source.id)}
                    aria-pressed={shown === source.id}
                    className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                      shown === source.id
                        ? "bg-surface text-text-main shadow-[var(--shadow-elev)]"
                        : "text-text-muted hover:text-text-main"
                    }`}
                  >
                    {source.label}
                  </button>
                ))}
              </div>
            )}
            <button
              onClick={onClose}
              className="hidden sm:inline-flex p-1 rounded-lg text-text-muted hover:text-text-main hover:bg-surface-2 dark:hover:bg-surface-2 transition-all"
            >
              <span className="material-symbols-outlined text-[20px]">close</span>
            </button>
          </div>
        </div>

        <div className="p-3 sm:p-6 overflow-y-auto overflow-x-hidden flex-1 prose dark:prose-invert max-w-none text-sm min-w-0 break-words">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <span className="material-symbols-outlined text-3xl animate-spin text-primary">progress_activity</span>
            </div>
          ) : error ? (
            <p className="text-danger">{error}</p>
          ) : (htmlBySource[shown] || (shown === "go" && htmlBySource.serenhope)) ? (
            <div dangerouslySetInnerHTML={{ __html: htmlBySource[shown] || htmlBySource.serenhope }} />
          ) : (
            <p className="text-text-muted">No changelog available.</p>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

ChangelogModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
};
