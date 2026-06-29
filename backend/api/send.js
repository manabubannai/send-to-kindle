// Vercel serverless function: relays an HTML article to a Kindle email as an attachment.
// Uses Resend's REST API directly (no SDK dependency).
//
// Required env vars:
//   RESEND_API_KEY  - from https://resend.com (API Keys)
//   SEND_FROM        - a verified sender, e.g. "Kindle <kindle@yourdomain.com>"
//                      This exact address must be on your Amazon "Approved Personal
//                      Document E-mail List".

export default async function handler(req, res) {
  // CORS (harmless; extension requests are already allowed via host_permissions).
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { to, subject, filename, html, contentBase64, mimeType } = req.body || {};
    if (!to) return res.status(400).json({ error: "Missing 'to'." });

    // Accept either a pre-built base64 attachment (EPUB) or raw HTML (legacy).
    let content;
    let fname;
    if (contentBase64) {
      content = contentBase64;
      fname = filename || "article.epub";
    } else if (html) {
      content = Buffer.from(html, "utf-8").toString("base64");
      fname = filename || "article.html";
    } else {
      return res.status(400).json({ error: "Missing 'contentBase64' or 'html'." });
    }

    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.SEND_FROM;
    if (!apiKey || !from) {
      return res.status(500).json({ error: "Server not configured (RESEND_API_KEY / SEND_FROM)." });
    }

    const attachment = { filename: fname, content };
    if (mimeType) attachment.content_type = mimeType;

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: subject || "Article",
        text: "Sent to Kindle by the Send to Kindle (Reader) extension.",
        attachments: [attachment],
      }),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: "Resend error", detail: data });
    return res.status(200).json({ ok: true, id: data.id });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
