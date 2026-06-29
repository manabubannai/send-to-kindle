# Send to Kindle (Reader)

A working alternative to the official "Send to Kindle for Google Chrome" extension,
which breaks because it depends on Amazon's authenticated web endpoints (CORB/CORS
issues under Manifest V3, and frequent backend changes).

This one uses the **stable, documented email method** instead: it extracts the article
on the page with Mozilla Readability, **embeds every image into a self-contained file**,
and emails it to your `@kindle.com` address.

### Why images need special handling

News sites lazy-load images, so the real URL lives in `data-src` / `srcset` /
`<picture><source>`, not `src` — a naïve extraction ships broken `?` boxes. And even
with correct remote URLs, Amazon's email converter often fails to fetch external images.
So the extension:

1. Resolves the real image URLs in the page (de-lazies `data-src`/`srcset`/`<picture>`).
2. Fetches the bytes in the service worker (host permissions bypass CORS).
3. Embeds them — **base64-inline** for the HTML preview, **real files inside an EPUB**
   for sending (the format Amazon converts most reliably).

The EPUB is built by a tiny dependency-free store-only ZIP writer (no JSZip).

## Architecture

```
Chrome tab
  └─ Extension (MV3): popup button
        ├─ Readability extracts the article  (src/vendor/Readability.js + src/background.js)
        ├─ Resolves lazy images → fetches bytes → embeds them
        └─ "Download HTML"  → self-contained HTML, images base64-inlined (no setup)
           "Send to Kindle" → builds EPUB w/ embedded images → POSTs to your relay
                               → Resend emails it to @kindle.com (backend/api/send.js)
```

One architecture serves both **personal use today** and **distribution later**:
other users never need OAuth — they just enter their Kindle email and add your relay's
sender address to Amazon's approved list.

## Quick start (personal, today)

### 1. Load the extension
1. Open `chrome://extensions`, enable **Developer mode** (top right).
2. Click **Load unpacked** and select this folder (`send-to-kindle/`).
3. Pin it. Open any article and click the toolbar icon → **Download HTML**.
4. Open that file locally — images should display (they're embedded), not show broken `?` boxes.
   This validates extraction quality before wiring up automatic sending.

> On load, Chrome will warn that the extension can "read your data on all websites".
> That broad host permission is only used to **fetch article images** from any site so
> they can be embedded; there is no tracking or external reporting.

### 2. Stand up the relay (one-click sending)
See [`backend/README.md`](backend/README.md): deploy to Vercel, set `RESEND_API_KEY`
and `SEND_FROM`, and add `SEND_FROM` to your Amazon Approved Personal Document E-mail List.

### 3. Configure & send
Open the extension's **Options**, paste your Kindle email and the relay URL, Save.
Now **Send to Kindle** delivers in one click.

## Why the email method (not the official approach)

| | Official extension | This extension |
|---|---|---|
| Mechanism | Amazon authenticated web API | `@kindle.com` email (documented) |
| Breaks when Amazon changes endpoints | Yes | No |
| CORB/CORS issues under MV3 | Yes | No |
| Distribution to others | n/a | No per-user OAuth needed |

## Status / roadmap

- [x] Article extraction (Readability) + clean HTML
- [x] Lazy-image resolution (`data-src`/`srcset`/`<picture>`) + embedding
- [x] Download HTML with base64-inlined images (zero-setup, self-contained)
- [x] EPUB output with embedded image files (sent to Kindle)
- [x] One-click send via Vercel + Resend relay
- [ ] Toolbar icons + nicer popup
- [ ] Multi-tab "bundle into one ebook"
- [ ] Chrome Web Store packaging (for public distribution)

Supported Kindle formats via email: PDF, DOC(X), TXT, RTF, HTM/HTML, PNG/JPG/GIF/BMP,
EPUB. 50 MB per email.
