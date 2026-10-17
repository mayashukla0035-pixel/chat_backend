/**
 * Link unfurling — turns a shared URL into the card data a chat shows under
 * the message (title, description, image, site name), the way WhatsApp does.
 *
 * Why this lives on the SERVER and not in the app:
 *   - a phone cannot fetch an arbitrary page's <head> cross-origin, so doing
 *     it client-side simply would not work;
 *   - it keeps every recipient's IP away from third-party sites;
 *   - results are cached once and shared by everyone in the chat instead of
 *     every member re-scraping the same page on every message render.
 *
 * YouTube is special-cased through oEmbed, which needs no API key and always
 * returns a real thumbnail + title, even where the page HTML is obfuscated.
 */

const dns = require('dns').promises;
const net = require('net');

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * First http(s)/www address in a message, with trailing sentence punctuation
 * removed. Mirrors the detector in the Flutter bubble so the card is always
 * built for the SAME address the underlined link opens.
 */
function extractFirstUrl(text) {
  if (!text) return null;
  const m = /(?:https?:\/\/|www\.)[^\s<>"']+/i.exec(String(text));
  if (!m) return null;
  let url = m[0];
  const trailing = '.,;:!?)]}\'"';
  while (url.length > 1 && trailing.includes(url[url.length - 1])) {
    const last = url[url.length - 1];
    if (last === ')' && (url.match(/\(/g) || []).length >= (url.match(/\)/g) || []).length) break;
    if (last === ']' && (url.match(/\[/g) || []).length >= (url.match(/\]/g) || []).length) break;
    url = url.slice(0, -1);
  }
  if (!/^(https?:\/\/|www\.)/i.test(url)) return null;
  return url.startsWith('http') ? url : `https://${url}`;
}

/** Canonical form used as the cache key — drops the fragment, which never
 *  changes what a server returns. */
function cacheKey(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch (_) {
    return String(url);
  }
}

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

const YT_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com',
  'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com',
  'youtu.be', 'www.youtu.be',
]);

function isYouTube(url) {
  try {
    return YT_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch (_) {
    return false;
  }
}

/**
 * Video id from every YouTube URL shape: watch?v=, youtu.be/, /shorts/,
 * /embed/, /live/, plus the `si` tracking suffix some shares carry.
 */
function youtubeVideoId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtu.be') {
      const id = u.pathname.split('/').filter(Boolean)[0] || '';
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
    const v = u.searchParams.get('v');
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length >= 2 && ['shorts', 'embed', 'live', 'v'].includes(parts[0])) {
      const id = parts[1];
      if (/^[A-Za-z0-9_-]{11}$/.test(id)) return id;
    }
    return null;
  } catch (_) {
    return null;
  }
}

/** The in-app player URL. youtube-nocookie is used deliberately: it embeds
 *  without setting tracking cookies, which is what a school deployment wants. */
function youtubeEmbedUrl(videoId) {
  return `https://www.youtube.com/embed/${videoId}?playsinline=1&autoplay=1&rel=0&origin=https://www.youtube.com`;
}

// ---------------------------------------------------------------------------
// Instagram (oEmbed — no credentials needed for public posts)
// ---------------------------------------------------------------------------

const IG_HOSTS = new Set([
  'instagram.com', 'www.instagram.com',
]);

function isInstagram(url) {
  try {
    return IG_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch (_) {
    return false;
  }
}

/** Instagram oEmbed endpoint. Works without any API key or app review for
 *  public posts/reels. Meta removed thumbnail_url from the response in Nov
 *  2025, so we get html (embed code) + title + author, but no standalone
 *  image URL. The html embed is what we hand to the client. */
async function fetchInstagramOEmbed(url) {
  try {
    const oembedUrl = `https://api.instagram.com/oembed?url=${encodeURIComponent(url)}`;
    const res = await fetch(oembedUrl, {
      signal: AbortSignal.timeout(10000),
      headers: { 'user-agent': UA },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      kind: 'instagram',
      url,
      title: data.title || 'Instagram',
      author: data.author_name || 'Instagram',
      thumbnail: data.thumbnail_url || '', // usually empty now (removed by Meta)
      html: data.html || '', // embed iframe code
      provider: data.provider_name || 'Instagram',
      siteName: 'Instagram',
    };
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

// The server fetches a URL the CLIENT chose, so without this an authenticated
// user could point it at 169.254.169.254 (cloud metadata) or a box on the
// internal network and read the response back through the preview endpoint.
function isPrivateV4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;                 // link-local / metadata
  if (a === 172 && b >= 16 && b <= 31) return true;        // RFC1918
  if (a === 192 && b === 168) return true;                 // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true;       // CGNAT
  if (a === 192 && b === 0 && p[2] === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;    // benchmarking
  if (a >= 224) return true;                               // multicast + reserved
  return false;
}

function isPrivateV6(ip) {
  const s = ip.toLowerCase();
  if (s === '::1' || s === '::') return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return isPrivateV4(mapped[1]);
  const head = s.split(':')[0];
  if (/^f[cd]/.test(head)) return true;                    // unique local fc00::/7
  if (/^fe[89ab]/.test(head)) return true;                 // link-local fe80::/10
  if (s.startsWith('ff')) return true;                     // multicast
  return false;
}

/**
 * Cheap, DNS-free public-address check for a URL the CLIENT will fetch.
 *
 * Deliberately does not resolve DNS: that check exists to stop this server
 * being aimed at an internal host, whereas here the target is the reader's
 * own device and a public hostname that resolves privately is vanishingly
 * rare next to a literal 192.168.x.1 sitting in an og:image tag.
 */
function isPubliclyFetchableImage(url) {
  let u;
  try { u = new URL(url); } catch (_) { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return false;
  const literal = net.isIP(host);
  if (literal === 4) return !isPrivateV4(host);
  if (literal === 6) return !isPrivateV6(host);
  // `0`, decimal-encoded IPv4 and friends are all caught by the ranges above
  // once normalised; anything left that is not a dotted quad is a real name.
  return true;
}

/**
 * Throws if [url] could reach something that is not a public web server.
 * Called for the original URL AND every redirect hop.
 */
async function assertPublicUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    const e = new Error('Only http and https links can be previewed.');
    e.status = 400;
    throw e;
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) {
    const e = new Error('That link has no host.');
    e.status = 400;
    throw e;
  }
  // Literal IPs skip DNS but must still be range-checked.
  const literal = net.isIP(host);
  if (literal) {
    if ((literal === 4 && isPrivateV4(host)) || (literal === 6 && isPrivateV6(host))) {
      const e = new Error('That link points to a private address.');
      e.status = 400;
      throw e;
    }
    return;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    const e = new Error('That link points to a private address.');
    e.status = 400;
    throw e;
  }
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch (_) {
    const e = new Error('That host could not be resolved.');
    e.status = 400;
    throw e;
  }
  if (!addrs.length) {
    const e = new Error('That host could not be resolved.');
    e.status = 400;
    throw e;
  }
  // EVERY resolved address must be public: a name with one public and one
  // private A record is the classic DNS-rebinding setup.
  for (const { address, family } of addrs) {
    const priv = family === 4 ? isPrivateV4(address) : isPrivateV6(address);
    if (priv) {
      const e = new Error('That link points to a private address.');
      e.status = 400;
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// HTML fetch + parse
// ---------------------------------------------------------------------------

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const FETCH_MS = 20000;
const MAX_BYTES = 2 * 1024 * 1024; // read more of the page so OG tags lower in the HTML are not missed
const MAX_REDIRECTS = 10;

/** Reads at most MAX_BYTES so a multi-megabyte page cannot exhaust memory. */
async function readCapped(res) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      chunks.push(value);
      if (total >= MAX_BYTES) {
        try { await reader.cancel(); } catch (_) { /* already closing */ }
        break;
      }
    }
  } catch (_) {
    /* fall through with whatever arrived */
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * Fetches [url], following redirects by hand so every hop is re-checked
 * against assertPublicUrl (fetch() would follow them silently).
 */
async function fetchHtml(url) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current);
    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_MS),
      headers: {
        // Many sites serve a bare consent/error page to the default fetch UA.
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) return null;
      current = new URL(loc, current).toString();
      continue;
    }
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (type && !/text\/html|application\/xhtml/i.test(type)) return null;
    return await readCapped(res);
  }
  return null;
}

function decode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function attrs(tag) {
  const out = {};
  const re = /([a-zA-Z_:][-\w:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>=`]+))/g;
  let m;
  while ((m = re.exec(tag))) {
    out[m[1].toLowerCase()] = decode(m[3] ?? m[4] ?? m[5] ?? '');
  }
  return out;
}

/** Pulls Open Graph / Twitter card / plain <title> out of the page head. */
function parsePreview(html, finalUrl) {
  const head = html.slice(0, 2 * 1024 * 1024);
  const meta = {};
  const metaRe = /<meta\b[^>]*>/gi;
  let m;
  while ((m = metaRe.exec(head))) {
    const a = attrs(m[0]);
    const key = (a.property || a.name || '').toLowerCase();
    if (key && a.content && !meta[key]) meta[key] = a.content;
  }
  const title = meta['og:title'] || meta['twitter:title'] || decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head) || [])[1] || '');
  const description = meta['og:description'] || meta['twitter:description'] || meta.description || '';
  // --- Image: OG/Twitter first, then <link rel=image_src>, then schema.org itemprop, then first  ---
  let image =
    meta['og:image'] ||
    meta['og:image:url'] ||
    meta['og:image:secure_url'] ||
    meta['twitter:image'] ||
    meta['twitter:image:src'] ||
    '';

  // <link rel="image_src"> fallback
  if (!image) {
    const linkRe = /<link\b[^>]*>/gi;
    let lm;
    while ((lm = linkRe.exec(head))) {
      const la = attrs(lm[0]);
      if ((la.rel || '').toLowerCase().includes('image_src') && la.href) {
        image = la.href;
        break;
      }
    }
  }

  // Schema.org itemprop="image" fallback (common on e-commerce/product pages)
  if (!image) {
    const itemRe = /<[^>]*itemprop=["']image["'][^>]*>/gi;
    let im;
    while ((im = itemRe.exec(head))) {
      const la = attrs(im[0]);
      if (la.content) { image = la.content; break; }
      if (la.src) { image = la.src; break; }
    }
  }

  // Last resort: first  tag in the early HTML that looks like a real image
  if (!image) {
    const imgRe = /<img\b[^>]*>/gi;
    let im;
    while ((im = imgRe.exec(head))) {
      const la = attrs(im[0]);
      const src = la.src || la['data-src'] || la['data-lazy-src'] || '';
      if (!src) continue;
      const low = src.toLowerCase();
      if (low.endsWith('.svg') || low.includes('pixel') || low.includes('spacer') || (low.includes('logo') && low.includes('icon'))) continue;
      image = src;
      break;
    }
  }

  const siteName = meta['og:site_name'] || '';

  let host = '';
  try { host = new URL(finalUrl).hostname.replace(/^www\./, ''); } catch (_) { /* keep '' */ }
  if (image) {
    try { image = new URL(image, finalUrl).toString(); } catch (_) { image = ''; }
  }
  // SSRF guard on the image URL — the phone fetches it directly, so it must be public.
  if (image && !isPubliclyFetchableImage(image)) image = '';

  // Title: prefer OG/Twitter, then <title>, then domain as last resort
  if (!title) title = host;
  return {
    title: title.slice(0, 300),
    description: decode(description).slice(0, 500),
    image: image.slice(0, 2000),
    siteName: (siteName.slice(0, 80) || host),
  };

}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Resolves the preview for [url]. Never throws — a link that cannot be
 *  previewed is not an error, it just renders as an ordinary link. */
async function fetchPreview(url) {
  if (isYouTube(url)) {
    const id = youtubeVideoId(url);
    // No video id means it is not a single video — a playlist, a channel, a
    // search. Returning null there left those messages as bare underlined
    // links with no card at all; fall through to the generic Open Graph path
    // so they at least get a title and a thumbnail.
    if (id) {
      try {
      const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
      const res = await fetch(endpoint, {
        signal: AbortSignal.timeout(FETCH_MS),
        headers: { 'user-agent': UA },
      });
      if (!res.ok) {
        // oEmbed 404s on private/removed videos; the id alone still plays, so
        // fall back to YouTube's own thumbnail rather than dropping the card.
        return {
          kind: 'youtube',
          url,
          videoId: id,
          embedUrl: youtubeEmbedUrl(id),
          title: '',
          author: '',
          thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
          siteName: 'YouTube',
        };
      }
      const data = await res.json();
      return {
        kind: 'youtube',
        url,
        videoId: id,
        embedUrl: youtubeEmbedUrl(id),
        title: String(data.title || '').slice(0, 300),
        author: String(data.author_name || '').slice(0, 120),
        thumbnail: String(data.thumbnail_url || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`),
        siteName: 'YouTube',
      };
    } catch (_) {
      return {
        kind: 'youtube',
        url,
        videoId: id,
        embedUrl: youtubeEmbedUrl(id),
        title: '',
        author: '',
        thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        siteName: 'YouTube',
      };
      }
    }
    // No video id: this is a playlist, a channel or a search, not a single
    // video. Returning null there left the message as a bare underlined link
    // with no card at all, so fall through to the generic Open Graph path and
    // give it a title and a thumbnail like any other shared page.
  }

  // Instagram: use oEmbed (no credentials needed for public posts/reels).
  // Meta removed thumbnail_url from oEmbed in Nov 2025, so we get embed html
  // + title + author instead of a standalone image. The client renders the
  // embed html inside the chat card.
  if (isInstagram(url)) {
    const ig = await fetchInstagramOEmbed(url);
    if (ig) return ig;
    // Fall through to generic OG if oEmbed failed (private account, etc.)
  }

  try {
    await assertPublicUrl(url);
  } catch (_) {
    return null;
  }
  // Every failure from here on is "this page has no preview we can show" —
  // a timeout, a 403, a certificate problem, a redirect loop. None of them may
  // escape as an exception: the endpoint answers 200 with no preview, and the
  // bubble falls back to a plain link.
  let html;
  try {
    html = await fetchHtml(url);
  } catch (_) {
    return null;
  }
  if (!html) return null;
  const data = parsePreview(html, url);
  if (!data.title && !data.image && !data.description) return null;
  return { kind: 'link', url, ...data };
}

module.exports = {
  extractFirstUrl,
  isPubliclyFetchableImage,
  isYouTube,
  youtubeVideoId,
  youtubeEmbedUrl,
  isInstagram,
  fetchInstagramOEmbed,
  fetchPreview,
  cacheKey,
  assertPublicUrl,
};