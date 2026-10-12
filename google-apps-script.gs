// ===== יודה נוכחות → Google Sheets =====
// Paste this into the spreadsheet: Extensions → Apps Script. Then Deploy → New deployment →
// Web app, "Execute as: Me", "Who has access: Anyone". Put the /exec URL in Vercel as SHEET_URL.
// After every change here: Deploy → Manage deployments → edit → Version: New version.
//
// Layout it writes to (same as the existing week tabs):
//   row 1 = date (12.10.26), row 2 = activity name, column A from row 3 = soldier names,
//   cell = checked box (present), unchecked box (missing, no reason) or the reason as text.
// Each finished activity becomes the next column after the last named activity, in the
// "שבוע N ..." tab with the highest N (copies named "עותק של…" are ignored).

const SECRET = ""; // same value as SHEET_SECRET in Vercel; leave "" if you didn't set one

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
      const col = nextColumn(sh);
      sh.getRange(1, col).setValue(p.date || "");
      sh.getRange(2, col).setValue(p.activity || "");

      const last = Math.max(sh.getLastRow(), 3);
      const names = sh.getRange(3, 1, last - 2, 1).getDisplayValues().map(r => norm(r[0]));
      for (const r of p.rows || []) {
        const n = norm(r.name);
        if (!n) continue;
        let i = names.indexOf(n);
        if (i < 0) {                       // not in the sheet yet: first empty name row, else a new row
          i = names.indexOf("");
          if (i < 0) { i = names.length; names.push(""); }
          names[i] = n;
          sh.getRange(3 + i, 1).setValue(String(r.name).trim());
        }
        const cell = sh.getRange(3 + i, col);
        if (r.value === true || r.value === false) { cell.insertCheckboxes(); cell.setValue(r.value); }
        else { cell.clearDataValidations(); cell.setValue(String(r.value)); }
      }
      return out({ ok: true, sheet: sh.getName(), column: col });
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

// Right after the last column that has an activity name in row 2.
function nextColumn(sh) {
  const width = Math.max(sh.getLastColumn(), 1);
  const hdr = sh.getRange(2, 1, 1, width).getDisplayValues()[0];
  let last = 1;
  hdr.forEach((v, i) => { if (i > 0 && String(v).trim()) last = i + 1; });
  const col = last + 1;
  if (col > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), col - sh.getMaxColumns());
  return col;
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
