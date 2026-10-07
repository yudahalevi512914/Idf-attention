// Returns a one-event calendar file with an alert; opening it on iPhone offers "Add to Calendar".
const esc = s => String(s).replace(/[\\;,]/g, m => "\\" + m).replace(/\r?\n/g, "\\n");

export default function handler(req, res) {
  const { t = "תזכורת", at } = req.query;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(at || "");
  if (!m) return res.status(400).end("bad time");
  const [, Y, M, D, h, mi] = m.map(Number);
  const local = (y, mo, d, hh, mm) => `${String(y).padStart(4, "0")}${String(mo).padStart(2, "0")}${String(d).padStart(2, "0")}T${String(hh).padStart(2, "0")}${String(mm).padStart(2, "0")}00`;
  const e = new Date(Date.UTC(Y, M - 1, D, h, mi + 15));
  const title = String(t).slice(0, 200);
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//idf-attention//manager//HE", "CALSCALE:GREGORIAN", "X-WR-TIMEZONE:Asia/Jerusalem",
    "BEGIN:VEVENT",
    `UID:${Date.now()}-${Math.random().toString(36).slice(2)}@idf-attention`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`,
    `DTSTART;TZID=Asia/Jerusalem:${local(Y, M, D, h, mi)}`,
    `DTEND;TZID=Asia/Jerusalem:${local(e.getUTCFullYear(), e.getUTCMonth() + 1, e.getUTCDate(), e.getUTCHours(), e.getUTCMinutes())}`,
    `SUMMARY:${esc(title)}`,
    "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${esc(title)}`, "TRIGGER:PT0S", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ];
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", 'inline; filename="reminder.ics"');
  res.status(200).send(lines.join("\r\n") + "\r\n");
}
