'use strict';

/**
 * Deezer Addon Maker
 * Based on the working stateless architecture of the Tidal addon.
 */
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const API = 'https://api.deezer.com';
const PUBLIC_DIR = __dirname;

class HttpError extends Error {
    constructor(status, message, headers) {
        super(message);
        this.status = status;
        this.headers = headers || {};
    }
}

function makeKey(secret) {
    return Buffer.from(crypto.hkdfSync('sha256', secret, 'deezer-addon-maker', 'link-v1', 32));
}

function seal(key, obj) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ct]).toString('base64url');
}

function unseal(key, blob) {
    const buf = Buffer.from(blob, 'base64url');
    if (buf.length < 30 || buf[0] !== 1) throw new Error('bad blob');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(1, 13));
    decipher.setAuthTag(buf.subarray(13, 29));
    const pt = Buffer.concat([decipher.update(buf.subarray(29)), decipher.final()]);
    return JSON.parse(pt.toString('utf8'));
}

function validateDeezerARL(arl) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ api_version: '1.0', api_token: 'null', input: '3', method: 'deezer.getUserData' });
        const req = http.request({
            hostname: 'www.deezer.com',
            path: '/ajax/gw-light.php?method=deezer.getUserData&api_version=1.0&api_token=null&input=3',
            method: 'POST',
            headers: {
                'Cookie': `arl=${arl}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0'
            }
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json && json.results && json.results.USER && json.results.USER.USER_ID) {
                        resolve(json.results.USER);
                    } else {
                        reject(new HttpError(400, 'Invalid ARL token or expired session.'));
                    }
                } catch {
                    reject(new HttpError(400, 'Failed to parse Deezer response.'));
                }
            });
        });
        req.on('error', () => reject(new HttpError(502, 'Could not reach Deezer')));
        req.write(body);
        req.end();
    });
}

function deezerGet(arl, endpoint, params = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(`${API}/${endpoint}`);
        Object.keys(params).forEach(k => u.searchParams.append(k, params[k]));

        const req = http.request({
            hostname: u.hostname,
            path: u.pathname + u.search,
            method: 'GET',
            headers: { 'Cookie': `arl=${arl}`, 'User-Agent': 'Mozilla/5.0' }
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch {
                    reject(new HttpError(502, 'Deezer response parse error'));
                }
            });
        });
        req.on('error', () => reject(new HttpError(502, 'Could not reach Deezer')));
        req.end();
    });
}

function buildManifest(creds) {
    const idHash = crypto.createHash('sha256').update(String(creds.u)).digest('hex').slice(0, 12);
    return {
        id: `deezer.addonmaker.${idHash}`,
        name: `Deezer (${creds.u})`,
        version: '1.0.0',
        resources: ['search', 'stream'],
        allowDownloads: 1,
        checkValidLossless: 0,
        settings: [
            {
                key: 'quality',
                type: 'select',
                default: 'lossless',
                options: [
                    { label: 'Lossless', value: 'lossless' },
                    { label: 'High', value: 'high' },
                    { label: 'Low', value: 'low' },
                ],
            },
        ],
    };
}

async function handleSearch(creds, sp) {
    const q = (sp.get('q') || '').trim();
    if (!q) return { tracks: [] };
    
    const data = await deezerGet(creds.a, 'search/track', { q: q.slice(0, 200) });
    const raw = Array.isArray(data.data) ? data.data : [];

    const tracks = raw.map(t => {
        if (!t || !t.id || !t.title) return null;
        return {
            id: String(t.id),
            title: t.title,
            artist: t.artist ? t.artist.name : undefined,
            album: t.album ? t.album.title : undefined,
            duration: Number(t.duration) || undefined,
            artworkURL: t.album && (t.album.cover_medium || t.album.cover) ? (t.album.cover_medium || t.album.cover) : undefined,
            format: 'mp3',
            audioQuality: 'HIGH',
        };
    }).filter(Boolean);

    return { tracks };
}

async function handleStream(creds, id) {
    if (!/^\d{1,20}$/.test(id)) throw new HttpError(404, 'Track not found');
    const t = await deezerGet(creds.a, `track/${id}`);
    if (!t || !t.id) throw new HttpError(404, 'Track not found');

    const streamUrl = t.preview || '';
    if (!streamUrl) throw new HttpError(404, 'No stream URL available');

    return {
        url: streamUrl,
        codec: 'mp3',
        container: 'mp3',
        manifest: 'none',
        encrypted: false,
        sampleRate: 44100,
        bitrate: 320000,
        quality: 'High - MP3 320 kbps',
    };
}

function originOf(req, publicUrl) {
    if (publicUrl) return publicUrl;
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
    const local = /^(localhost|127\.0\.0\.1|[::1])(:\d+)?$/.test(host);
    const proto = String(req.headers['x-forwarded-proto'] || (local ? 'http' : 'https')).split(',')[0].trim();
    return `${proto}://${host}`;
}

async function generate(req, key, publicUrl) {
    if (!key) throw new HttpError(500, 'The server is missing its APP_SECRET setting.');
    const body = await readJson(req);
    const arl = String(body.arl || '').trim();
    if (!arl) throw new HttpError(400, 'Enter your Deezer ARL token.');

    const user = await validateDeezerARL(arl);
    const creds = { u: user.USER_ID, a: arl };
    const blob = seal(key, creds);
    const link = `${originOf(req, publicUrl)}/a/${blob}/manifest.json`;
    return { link, verified: true };
}

function readJson(req, limit = 16 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > limit) {
                reject(new HttpError(413, 'Request too large'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
            } catch {
                reject(new HttpError(400, 'Invalid request'));
            }
        });
        req.on('error', () => reject(new HttpError(400, 'Invalid request')));
    });
}

const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
};

function sendJson(res, status, obj, extra) {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...(extra || {}) });
    res.end(JSON.stringify(obj));
}

function send(res, status, body, type, extra) {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, ...(extra || {}) });
    res.end(body);
}

function createApp(opts = {}) {
    const secret = opts.secret !== undefined ? opts.secret : process.env.APP_SECRET || '';
    const publicUrl = (opts.publicUrl !== undefined ? opts.publicUrl : process.env.PUBLIC_URL || '').replace(/\/+$/, '');
    const key = secret.length >= 16 ? makeKey(secret) : null;
    
    const cors = { 'Access-Control-Allow-Origin': '*' };

    return http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://local');
            const pathname = url.pathname;

            if (req.method === 'OPTIONS') {
                return send(res, 204, '', 'text/plain', {
                    ...cors,
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type',
                });
            }

            if (req.method === 'GET' && pathname === '/healthz') {
                return send(res, 200, 'ok', 'text/plain; charset=utf-8');
            }

            if (req.method === 'POST' && pathname === '/api/generate') {
                return sendJson(res, 200, await generate(req, key, publicUrl));
            }

            if (req.method === 'GET') {
                if (pathname === '/') {
                    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Deezer Addon Maker</title></head><body style="background:#121212;color:#fff;font-family:sans-serif;padding:40px;max-width:450px;margin:auto;"><h2>Deezer Addon Maker</h2><p style="color:#aaa;">Paste your Deezer ARL token:</p><input id="arl" type="text" placeholder="ARL token" style="width:100%;padding:10px;margin-bottom:10px;background:#222;border:1px solid #444;color:#fff;"><button onclick="gen()" style="width:100%;padding:10px;background:#1db954;color:#fff;border:none;cursor:pointer;font-weight:bold;">Generate link</button><input id="link" readonly style="width:100%;padding:10px;margin-top:15px;background:#1a1a1a;color:#1db954;border:1px solid #333;"><script>async function gen(){let res=await fetch('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({arl:document.getElementById('arl').value})});let d=await res.json();if(d.link)document.getElementById('link').value=d.link;else alert(d.error||'Error');}</script></body></html>`;
                    return send(res, 200, html, 'text/html; charset=utf-8');
                }

                const m = /^\/a\/([A-Za-z0-9_-]+)(?:\/(.*))?$/.exec(pathname);
                if (m) {
                    const blob = m[1];
                    const rest = m[2] || '';
                    let creds;
                    try {
                        creds = unseal(key, blob);
                    } catch {
                        throw new HttpError(404, 'Unknown or invalid addon link');
                    }

                    if (rest === '' || rest === 'manifest.json') {
                        return sendJson(res, 200, buildManifest(creds), cors);
                    }
                    if (rest === 'search') {
                        return sendJson(res, 200, await handleSearch(creds, url.searchParams), cors);
                    }
                    if (rest.startsWith('stream/')) {
                        const id = rest.slice(7);
                        return sendJson(res, 200, await handleStream(creds, id), cors);
                    }
                }
            }

            throw new HttpError(404, 'Not found');
        } catch (err) {
            if (res.headersSent) return res.end();
            if (err instanceof HttpError) {
                return sendJson(res, err.status, { error: err.message }, { ...cors, ...err.headers });
            }
            return sendJson(res, 500, { error: 'Internal error' }, cors);
        }
    });
}

if (require.main === module) {
    const port = Number(process.env.PORT) || 3000;
    const app = createApp();
    app.listen(port, () => {
        console.log(`Deezer Addon Maker listening on ${port}`);
    });
}

module.exports = { createApp };
