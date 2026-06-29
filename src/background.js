// Service worker: extract article -> resolve & embed images -> self-contained HTML
// (download/preview) or a fully self-contained EPUB (send to Kindle).
//
// Images are the hard part: news sites lazy-load them, so the real URL lives in
// data-src / srcset / <picture><source>, not src. And even with a correct remote
// URL, Amazon's email converter often fails to fetch external images. So we
// resolve the real URLs in the page, fetch the bytes here in the worker (host
// permissions bypass CORS), and ship them embedded — base64 for HTML, real files
// for EPUB. No external dependency: a tiny store-only ZIP writer builds the EPUB.

/* ------------------------------------------------------------------ */
/* In-page extractor (runs in the tab, has DOM access)                 */
/* ------------------------------------------------------------------ */

/** Injected into the page. Resolves lazy images and returns clean XHTML. */
function extractInPage() {
  try {
    if (typeof Readability === "undefined") {
      return { __error: "Readability did not load" };
    }
    const PAGE_URL = location.href;
    const abs = (u) => {
      try {
        return new URL(u, PAGE_URL).href;
      } catch (_e) {
        return "";
      }
    };

    // Pick the best candidate from a srcset string ("u1 320w, u2 640w" / "u 2x").
    function bestFromSrcset(ss) {
      if (!ss) return "";
      let best = "";
      let bestScore = -1;
      ss.split(",").forEach((part) => {
        const seg = part.trim();
        if (!seg) return;
        const sp = seg.split(/\s+/);
        const u = sp[0];
        const d = sp[1];
        let score = 1;
        if (d) {
          if (/w$/.test(d)) score = parseFloat(d);
          else if (/x$/.test(d)) score = parseFloat(d) * 1000;
        }
        if (u && score > bestScore) {
          bestScore = score;
          best = u;
        }
      });
      return best;
    }

    function isPlaceholder(src) {
      if (!src) return true;
      if (/^data:image\/(gif|svg)/i.test(src)) return true;
      if (/(blank|spacer|placeholder|transparent|1x1|pixel)\.(gif|png|webp)/i.test(src)) return true;
      // Common 1x1 base64 gif/png placeholders.
      if (/^data:image\/[^;]+;base64,(R0lGOD|iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB)/.test(src)) return true;
      return false;
    }

    function pickImageUrl(img) {
      const cur = img.getAttribute("src") || "";
      const candidates = [
        isPlaceholder(cur) ? "" : cur,
        img.getAttribute("data-src"),
        img.getAttribute("data-original"),
        img.getAttribute("data-lazy-src"),
        img.getAttribute("data-lazy"),
        img.getAttribute("data-hi-res-src"),
        bestFromSrcset(img.getAttribute("srcset") || ""),
        bestFromSrcset(img.getAttribute("data-srcset") || ""),
        cur, // last resort: whatever was there
      ];
      for (let i = 0; i < candidates.length; i++) {
        if (candidates[i]) return candidates[i];
      }
      return "";
    }

    function fixLazy(root) {
      // <picture>: lift the best <source> into the inner <img> if it lacks one.
      root.querySelectorAll("picture").forEach((pic) => {
        const img = pic.querySelector("img");
        if (!img) return;
        const curr = img.getAttribute("src") || "";
        if (isPlaceholder(curr)) {
          let best = "";
          pic.querySelectorAll("source").forEach((s) => {
            const u = bestFromSrcset(
              s.getAttribute("srcset") || s.getAttribute("data-srcset") || ""
            );
            if (u) best = u;
          });
          if (best) img.setAttribute("src", best);
        }
      });
      root.querySelectorAll("img").forEach((img) => {
        const u = pickImageUrl(img);
        if (u) img.setAttribute("src", u);
      });
    }

    // Parse a clone with lazy images already resolved so Readability keeps them.
    const clone = document.cloneNode(true);
    fixLazy(clone);
    const article = new Readability(clone).parse();
    if (!article) return null;

    // Reparse the extracted content for clean serialization + absolute image URLs.
    const doc = new DOMParser().parseFromString(article.content || "", "text/html");
    fixLazy(doc);
    doc.querySelectorAll("source").forEach((s) => s.remove());

    const images = [];
    const seen = new Set();
    doc.querySelectorAll("img").forEach((img) => {
      const src = abs(img.getAttribute("src") || "");
      if (!src || /^javascript:/i.test(src)) {
        img.remove();
        return;
      }
      img.setAttribute("src", src);
      if (!seen.has(src)) {
        seen.add(src);
        images.push(src);
      }
    });
    doc.querySelectorAll("a[href]").forEach((a) => {
      const h = abs(a.getAttribute("href"));
      if (h) a.setAttribute("href", h);
      else a.removeAttribute("href");
    });

    // Serialize to well-formed XHTML with a safe tag/attribute whitelist.
    const VOID = new Set(["area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"]);
    const KEEP_ATTR = { a: ["href"], img: ["src", "alt"], td: ["colspan", "rowspan"], th: ["colspan", "rowspan"], ol: ["start"] };
    const DROP_TAG = new Set(["script","style","noscript","iframe","object","embed","form","input","button","svg","canvas","video","audio","source","link","meta","head"]);
    const escText = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const escAttr = (t) => escText(t).replace(/"/g, "&quot;");
    function ser(node) {
      let out = "";
      node.childNodes.forEach((n) => {
        if (n.nodeType === 3) {
          out += escText(n.nodeValue || "");
          return;
        }
        if (n.nodeType !== 1) return;
        const tag = n.tagName.toLowerCase();
        if (DROP_TAG.has(tag)) return;
        let attrs = "";
        (KEEP_ATTR[tag] || []).forEach((a) => {
          if (n.hasAttribute(a)) attrs += ` ${a}="${escAttr(n.getAttribute(a))}"`;
        });
        if (VOID.has(tag)) out += `<${tag}${attrs}/>`;
        else out += `<${tag}${attrs}>` + ser(n) + `</${tag}>`;
      });
      return out;
    }
    const content = ser(doc.body);

    return {
      title: article.title || document.title || "Untitled",
      byline: article.byline || "",
      siteName: article.siteName || "",
      lang: (document.documentElement.getAttribute("lang") || "en").slice(0, 8) || "en",
      url: PAGE_URL,
      content,
      images,
    };
  } catch (e) {
    return { __error: String(e) };
  }
}

async function extractArticle(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/vendor/Readability.js"],
  });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractInPage,
  });
  return result;
}

/* ------------------------------------------------------------------ */
/* Byte utilities: base64, CRC32, store-only ZIP                       */
/* ------------------------------------------------------------------ */

const enc = new TextEncoder();

function bytesToBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Build a store-only (uncompressed) ZIP. EPUB requires mimetype stored & first. */
function zipStore(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const dosTime = 0;
  const dosDate = 0x21; // 1980-01-01
  for (const f of files) {
    const nameB = enc.encode(f.name);
    const data = f.data;
    const crc = crc32(data);
    const lh = new Uint8Array(30 + nameB.length);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0, true);
    dv.setUint16(8, 0, true); // method: store
    dv.setUint16(10, dosTime, true);
    dv.setUint16(12, dosDate, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameB.length, true);
    dv.setUint16(28, 0, true);
    lh.set(nameB, 30);
    chunks.push(lh, data);

    const cd = new Uint8Array(46 + nameB.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameB.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameB, 46);
    central.push(cd);
    offset += lh.length + data.length;
  }
  const centralStart = offset;
  let centralSize = 0;
  central.forEach((c) => (centralSize += c.length));
  central.forEach((c) => chunks.push(c));

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  chunks.push(eocd);

  let total = 0;
  chunks.forEach((c) => (total += c.length));
  const out = new Uint8Array(total);
  let p = 0;
  chunks.forEach((c) => {
    out.set(c, p);
    p += c.length;
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Image fetching                                                      */
/* ------------------------------------------------------------------ */

const MIME_EXT = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
};

function extForMime(mime, url) {
  const m = (mime || "").split(";")[0].trim().toLowerCase();
  if (MIME_EXT[m]) return { mime: m, ext: MIME_EXT[m] };
  const um = (url.match(/\.(jpe?g|png|gif|webp|bmp|svg)(?:[?#]|$)/i) || [])[1];
  if (um) {
    const e = um.toLowerCase() === "jpeg" ? "jpg" : um.toLowerCase();
    const back = { jpg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml" };
    return { mime: back[e], ext: e };
  }
  return { mime: "image/jpeg", ext: "jpg" };
}

async function fetchImage(url) {
  if (/^data:/i.test(url)) {
    const m = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/i);
    if (!m) return { url, ok: false };
    const mime = m[1] || "image/png";
    const isB64 = !!m[2];
    try {
      const bytes = isB64 ? base64ToBytes(m[3]) : enc.encode(decodeURIComponent(m[3]));
      const { ext } = extForMime(mime, url);
      return { url, ok: true, bytes, mime, ext };
    } catch (_e) {
      return { url, ok: false };
    }
  }
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(url, { signal: ctrl.signal, credentials: "omit" });
    clearTimeout(to);
    if (!res.ok) return { url, ok: false };
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!buf.length || buf.length > 12 * 1024 * 1024) return { url, ok: false };
    const { mime, ext } = extForMime(res.headers.get("content-type"), url);
    return { url, ok: true, bytes: buf, mime, ext };
  } catch (_e) {
    return { url, ok: false };
  }
}

async function fetchImages(urls) {
  const map = new Map();
  const list = (urls || []).slice(0, 60);
  const results = await Promise.all(list.map(fetchImage));
  let n = 0;
  for (const r of results) {
    if (r.ok) {
      n++;
      r.name = `images/img${n}.${r.ext}`;
    }
    map.set(r.url, r);
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* Document assembly                                                   */
/* ------------------------------------------------------------------ */

const CSS =
  'body{font-family:Georgia,"Times New Roman",serif;line-height:1.6;max-width:40em;margin:0 auto;padding:1.2em}' +
  "h1{font-size:1.6em;line-height:1.25}img{max-width:100%;height:auto}figure{margin:1em 0}" +
  "figcaption{color:#666;font-size:.85em}blockquote{border-left:3px solid #ccc;margin:1em 0;padding-left:1em;color:#444}" +
  "pre{white-space:pre-wrap;word-wrap:break-word}.byline{color:#555;font-style:italic;margin-top:0}" +
  ".source{color:#777;font-size:.85em;margin-top:2em;border-top:1px solid #ddd;padding-top:.6em}";

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
const xmlEsc = (s) =>
  String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// The in-page serializer entity-escapes attribute values; reverse it to recover the
// raw URL used as the image-map key (CDN URLs commonly contain & -> &amp;).
const htmlUnescape = (s) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** Rewrite <img> tags via toRef(info)->src; drop images that failed to fetch. */
function rewriteImgs(content, map, toRef) {
  return content.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = tag.match(/\bsrc="([^"]*)"/i);
    const url = m ? htmlUnescape(m[1]) : "";
    const info = map.get(url);
    if (!info || !info.ok) return "";
    const ref = toRef(info);
    if (!ref) return "";
    const am = tag.match(/\balt="([^"]*)"/i);
    const alt = am ? am[1] : "";
    return `<img src="${ref}" alt="${alt}"/>`;
  });
}

function buildSelfContainedHtml(article, map) {
  const body = rewriteImgs(article.content, map, (info) => `data:${info.mime};base64,${bytesToBase64(info.bytes)}`);
  const t = escapeHtml(article.title);
  const byline = article.byline ? `<p class="byline">${escapeHtml(article.byline)}</p>` : "";
  const site = article.siteName ? " · " + escapeHtml(article.siteName) : "";
  const url = escapeHtml(article.url);
  const lang = escapeHtml(article.lang || "en");
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<style>${CSS}</style>
</head>
<body>
<h1>${t}</h1>
${byline}
${body}
<p class="source">Source${site}: <a href="${url}">${url}</a></p>
</body>
</html>`;
}

function buildEpub(article, map) {
  const body = rewriteImgs(article.content, map, (info) => info.name);
  const used = [...map.values()].filter((i) => i.ok && i.name && body.includes(`"${i.name}"`));

  const t = xmlEsc(article.title);
  const lang = xmlEsc(article.lang || "en");
  const creator = xmlEsc(article.byline || article.siteName || "");
  const byline = article.byline ? `<p class="byline">${xmlEsc(article.byline)}</p>` : "";
  const site = article.siteName ? " · " + xmlEsc(article.siteName) : "";
  const url = xmlEsc(article.url);
  const uuid = (self.crypto && crypto.randomUUID && crypto.randomUUID()) || "import-" + crc32(enc.encode(article.url + article.title));

  const xhtml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${lang}" lang="${lang}">
<head>
<meta charset="utf-8"/>
<title>${t}</title>
<style>${CSS}</style>
</head>
<body>
<h1>${t}</h1>
${byline}
${body}
<p class="source">Source${site}: <a href="${url}">${url}</a></p>
</body>
</html>`;

  const manifestItems = [
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '<item id="content" href="content.xhtml" media-type="application/xhtml+xml"/>',
  ];
  const zipFiles = [
    { name: "mimetype", data: enc.encode("application/epub+zip") },
    {
      name: "META-INF/container.xml",
      data: enc.encode(
        '<?xml version="1.0" encoding="utf-8"?>\n' +
          '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
          '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n' +
          "</container>"
      ),
    },
  ];
  used.forEach((info, i) => {
    const id = `img${i + 1}`;
    manifestItems.push(`<item id="${id}" href="${info.name}" media-type="${info.mime}"/>`);
    zipFiles.push({ name: `OEBPS/${info.name}`, data: info.bytes });
  });

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
<dc:title>${t}</dc:title>
<dc:language>${lang}</dc:language>
<dc:identifier id="bookid">urn:uuid:${uuid}</dc:identifier>
${creator ? `<dc:creator>${creator}</dc:creator>\n` : ""}<dc:source>${url}</dc:source>
</metadata>
<manifest>
${manifestItems.join("\n")}
</manifest>
<spine toc="ncx">
<itemref idref="content"/>
</spine>
</package>`;

  const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="urn:uuid:${uuid}"/></head>
<docTitle><text>${t}</text></docTitle>
<navMap><navPoint id="np1" playOrder="1"><navLabel><text>${t}</text></navLabel><content src="content.xhtml"/></navPoint></navMap>
</ncx>`;

  zipFiles.push({ name: "OEBPS/content.opf", data: enc.encode(opf) });
  zipFiles.push({ name: "OEBPS/toc.ncx", data: enc.encode(ncx) });
  zipFiles.push({ name: "OEBPS/content.xhtml", data: enc.encode(xhtml) });

  return { bytes: zipStore(zipFiles), imageCount: used.length };
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

function sanitizeFilename(name) {
  return (
    String(name || "article")
      .replace(/[\\/:*?"<>|\n\r\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "article"
  );
}

const BLOCKED = /^(chrome|edge|brave|about|chrome-extension|view-source|devtools):/i;
function isBlockedUrl(url) {
  if (!url) return true;
  if (BLOCKED.test(url)) return true;
  if (/chrome\.google\.com\/webstore|chromewebstore\.google\.com/.test(url)) return true;
  return false;
}

async function handle(mode) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error("No active tab.");
  if (isBlockedUrl(tab.url)) {
    throw new Error("This page can't be read by extensions. Open a normal article page.");
  }

  const article = await extractArticle(tab.id);
  if (!article) throw new Error("Couldn't find article content on this page.");
  if (article.__error) throw new Error("Extractor error: " + article.__error);

  const imgMap = await fetchImages(article.images);
  const okCount = [...imgMap.values()].filter((i) => i.ok).length;
  const imgNote = `${okCount} image${okCount === 1 ? "" : "s"}`;

  if (mode === "download") {
    const html = buildSelfContainedHtml(article, imgMap);
    const filename = sanitizeFilename(article.title) + ".html";
    const dataUrl = "data:text/html;charset=utf-8," + encodeURIComponent(html);
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
    return { ok: true, title: article.title, message: `Downloaded: ${filename} (${imgNote})` };
  }

  if (mode === "send") {
    const { kindleEmail, backendUrl } = await chrome.storage.sync.get(["kindleEmail", "backendUrl"]);
    if (!kindleEmail || !backendUrl) {
      throw new Error("Set your Kindle email and backend URL in Options first.");
    }
    const { bytes, imageCount } = buildEpub(article, imgMap);
    const filename = sanitizeFilename(article.title) + ".epub";
    const res = await fetch(backendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: kindleEmail,
        subject: article.title,
        filename,
        contentBase64: bytesToBase64(bytes),
        mimeType: "application/epub+zip",
        sourceUrl: article.url,
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error("Backend " + res.status + ": " + text.slice(0, 300));
    return { ok: true, title: article.title, message: `Sent to ${kindleEmail} (${imageCount} embedded)` };
  }

  throw new Error("Unknown mode: " + mode);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg && msg.mode)
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, message: String((e && e.message) || e) }));
  return true; // keep the message channel open for the async response
});
