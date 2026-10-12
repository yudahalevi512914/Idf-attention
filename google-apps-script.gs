// ===== יודה נוכחות → Google Sheets =====
// Paste this into the spreadsheet: Extensions → Apps Script. Then Deploy → New deployment →
// Web app, "Execute as: Me", "Who has access: Anyone". Put the /exec URL in Vercel as SHEET_URL.
// After every change here: Deploy → Manage deployments → edit → Version: New version.
//
// Layout it writes to (same as the existing week tabs):
//   row 1 = date (12.10.26), row 2 = activity name, column A from row 3 = soldier names,
//   cell = checked box (present), unchecked box (missing, no reason) or the reason as text.
// Each finished activity goes into the first column after the last column where anyone is
// marked, so activities filled in by hand are never overwritten.
// It writes to the "שבוע N ..." tab with the highest N. When the activity's date falls in a
// later week (weeks start on Saturday), it first creates "שבוע N+1" from the current tab:
// same names and layout, empty checkboxes.

var SECRET = ""; // same value as SHEET_SECRET in Vercel; leave "" if you didn't set one

function doPost(e) {
  try {
    const p = JSON.parse(e.postData.contents);
    if (SECRET && p.secret !== SECRET) return out({ ok: false, error: "wrong secret" });
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = (p.sheetName && ss.getSheetByName(p.sheetName)) || pickWeekSheet(ss);
    if (!sh) return out({ ok: false, error: "no 'שבוע N' tab found" });

    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      const target = weekFor(ss, sh, p.date);
      const col = nextColumn(target);
      // keep a date / name the commander already typed into that column
      if (!target.getRange(1, col).getDisplayValue().trim()) target.getRange(1, col).setValue(p.date || "");
      if (!target.getRange(2, col).getDisplayValue().trim()) target.getRange(2, col).setValue(p.activity || "");

      const names = nameList(target);
      for (const r of p.rows || []) {
        const n = norm(r.name);
        if (!n) continue;
        let i = names.indexOf(n);
        if (i < 0) {                       // not in the sheet yet: first empty name row, else a new row
          i = names.indexOf("");
          if (i < 0) { i = names.length; names.push(""); }
          names[i] = n;
          target.getRange(3 + i, 1).setValue(String(r.name).trim());
        }
        const cell = target.getRange(3 + i, col);
        if (r.value === true || r.value === false) { cell.insertCheckboxes(); cell.setValue(r.value); }
        else { cell.clearDataValidations(); cell.setValue(String(r.value)); }
      }
      return out({ ok: true, sheet: target.getName(), column: col });
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

// The "שבוע N ..." tab with the highest week number.
function pickWeekSheet(ss) {
  let best = null, bestN = -1;
  ss.getSheets().forEach(s => {
    const m = /^\s*שבוע\s*(\d+)/.exec(s.getName());
    if (m && +m[1] > bestN) { bestN = +m[1]; best = s; }
  });
  return best;
}

// Soldier names from row 3 down (normalised; "" for empty rows).
function nameList(sh) {
  const last = Math.max(sh.getLastRow(), 3);
  return sh.getRange(3, 1, last - 2, 1).getDisplayValues().map(r => norm(r[0]));
}

// First column after the last one where any soldier is marked (a checked box or any text).
// Unchecked boxes and empty cells don't count, so a pre-made empty column is used.
function nextColumn(sh) {
  const rows = nameList(sh).length, width = Math.max(sh.getLastColumn(), 2);
  const data = sh.getRange(3, 1, rows, width).getDisplayValues();
  let last = 1;
  for (let c = 1; c < width; c++) {
    if (data.some(r => { const v = String(r[c]).trim(); return v && v !== "FALSE"; })) last = c + 1;
  }
  const col = last + 1;
  if (col > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), col - sh.getMaxColumns());
  return col;
}

// "12.10.26" / "12/10/2026" → Date at noon UTC, or null.
function parseDate(s) {
  const m = /(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})/.exec(String(s || ""));
  if (!m) return null;
  const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
  return new Date(Date.UTC(y, +m[2] - 1, +m[1], 12));
}
// The Saturday that opens the week of d.
function weekStart(d) { return d.getTime() - ((d.getUTCDay() + 1) % 7) * 864e5; }

// The tab this date belongs in: the current week tab, or a new "שבוע N+1" when the date is
// in a later week than the first date already written in the current tab.
function weekFor(ss, sh, dateStr) {
  const d = parseDate(dateStr);
  if (!d) return sh;
  const dates = sh.getRange(1, 2, 1, Math.max(sh.getLastColumn() - 1, 1)).getDisplayValues()[0].map(parseDate).filter(Boolean);
  if (!dates.length) return sh;                     // empty tab (e.g. one you duplicated yourself)
  const first = Math.min(...dates.map(x => x.getTime()));
  if (weekStart(d) <= weekStart(new Date(first))) return sh;

  const n = +(/^\s*שבוע\s*(\d+)/.exec(sh.getName()) || [0, 0])[1] + 1;
  const name = ss.getSheetByName(`שבוע ${n}`) ? `שבוע ${n} (${dateStr})` : `שבוע ${n}`;
  const copy = sh.copyTo(ss).setName(name);
  const width = copy.getMaxColumns(), rows = nameList(copy).length;
  copy.getRange(1, 2, 2, width - 1).clearContent();                     // dates and activity names
  const body = copy.getRange(3, 2, rows, width - 1);
  body.clearContent(); body.clearDataValidations(); body.insertCheckboxes(); // all unchecked
  ss.setActiveSheet(copy); ss.moveActiveSheet(sh.getIndex() + 1);
  return copy;
}

// Names match even with extra spaces or a different geresh (׳ ' ’).
function norm(s) {
  return String(s || "").trim().replace(/\s+/g, " ").replace(/[׳’`]/g, "'");
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// Opening the /exec URL in a browser shows this — a quick way to check the deployment works.
function doGet() {
  return out({ ok: true, message: "yuda-attention sheet sync is running" });
}
