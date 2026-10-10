'use strict';

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

const PORT = process.env.PORT || 3000;
const LINK_SECRET = process.env.LINK_SECRET || 'default_secret_key_change_me_32_bytes!!';

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
        const req = https.request({
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
                        reject(new Error('Invalid ARL token'));
                    }
                } catch(e) {
                    reject(new Error('Parse error'));
                }
            });
        });
        req.on('error', err => reject(err));
        req.write(body);
        req.end();
    });
}

function callDeezerApi(arl, endpoint, params = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(`https://api.deezer.com/${endpoint}`);
        Object.keys(params).forEach(k => u.searchParams.append(k, params[k]));
        
        https.get(u, {
            headers: { 'Cookie': `arl=${arl}`, 'User-Agent': 'Mozilla/5.0' }
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch(e) {
                    reject(new Error('Deezer response parse error'));
                }
            });
        }).on('error', reject);
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

function originOf(req) {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
    const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    return `${proto}://${host}`;
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    const u = new URL(req.url, originOf(req));

    if (u.pathname === '/healthz') {
        res.writeHead(200, {'Content-Type': 'text/plain'});
        return res.end('OK');
    }

    if (u.pathname === '/' || u.pathname === '/index.html') {
        res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
        return res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Deezer Addon Maker</title></head><body style="background:#121212;color:#fff;font-family:sans-serif;padding:40px;max-width:450px;margin:auto;"><h2>Deezer Addon Maker</h2><p style="color:#aaa;">Paste your Deezer ARL token below:</p><input id="arl" type="text" placeholder="Enter ARL token" style="width:100%;padding:12px;margin-bottom:15px;background:#222;border:1px solid #444;color:#fff;border-radius:4px;"><button onclick="gen()" style="width:100%;padding:12px;background:#1db954;color:#fff;border:none;font-weight:bold;border-radius:4px;cursor:pointer;">Generate Link</button><input id="link" readonly style="width:100%;padding:12px;margin-top:15px;background:#1a1a1a;color:#1db954;border:1px solid #333;display:none;"><script>async function gen(){let l=document.getElementById('link');l.style.display='none';let res=await fetch('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({arl:document.getElementById('arl').value})});let d=await res.json();if(d.link){l.value=d.link;l.style.display='block';}else{alert(d.error||'Error');}}</script></body></html>`);
    }

    if (u.pathname === '/api/generate' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                const arl = String(data.arl || '').trim();
                if (!arl) throw new Error('ARL is required');
                
                const user = await validateDeezerARL(arl);
                const key = makeKey(LINK_SECRET);
                const blob = seal(key, { u: user.USER_ID, a: arl });
                const link = `${originOf(req)}/a/${blob}/manifest.json`;
                
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ link }));
            } catch(e) {
                res.writeHead(400, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    const m = /^\/a\/([A-Za-z0-9_-]+)(?:\/(.*))?$/.exec(u.pathname);
    if (m) {
        const blob = m[1];
        const rest = m[2] || '';
        let creds;
        try {
            const key = makeKey(LINK_SECRET);
            creds = unseal(key, blob);
        } catch {
            res.writeHead(404, {'Content-Type': 'application/json'});
            return res.end(JSON.stringify({ error: 'Invalid addon link' }));
        }

        if (rest === '' || rest === 'manifest.json') {
            res.writeHead(200, {'Content-Type': 'application/json'});
            return res.end(JSON.stringify(buildManifest(creds)));
        }

        if (rest === 'search') {
            try {
                const q = u.searchParams.get('q');
                const searchData = await callDeezerApi(creds.a, 'search/track', { q });
                const raw = Array.isArray(searchData.data) ? searchData.data : [];

                const tracks = raw.map(t => ({
                    id: String(t.id),
                    title: t.title,
                    artist: t.artist ? t.artist.name : 'Unknown Artist',
                    album: t.album ? t.album.title : 'Unknown Album',
                    duration: Number(t.duration) || 0,
                    artworkURL: t.album && (t.album.cover_medium || t.album.cover) ? (t.album.cover_medium || t.album.cover) : '',
                    format: 'mp3',
                    audioQuality: 'HIGH'
                }));

                res.writeHead(200, {'Content-Type': 'application/json'});
                return res.end(JSON.stringify({ tracks }));
            } catch(e) {
                res.writeHead(400, {'Content-Type': 'application/json'});
                return res.end(JSON.stringify({ error: e.message }));
            }
        }

        if (rest.startsWith('stream/')) {
            try {
                const trackId = rest.split('/')[1];
                const trackData = await callDeezerApi(creds.a, `track/${trackId}`);
                if (!trackData || !trackData.id) throw new Error('Track not found');

                res.writeHead(200, {'Content-Type': 'application/json'});
                return res.end(JSON.stringify({
                    url: trackData.preview || '',
                    codec: 'mp3',
                    container: 'mp3',
                    manifest: 'none',
                    encrypted: false,
                    sampleRate: 44100,
                    bitrate: 320000,
                    quality: 'High - MP3 320 kbps'
                }));
            } catch(e) {
                res.writeHead(404, {'Content-Type': 'application/json'});
                return res.end(JSON.stringify({ error: e.message }));
            }
        }
    }

    res.writeHead(404, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, () => {
    console.log('Server running on port ' + PORT);
});
  }));
            } catch(e) {
                res.writeHead(404, {'Content-Type': 'application/json'});
                return res.end(JSON.stringify({ error: e.message }));
            }
        }
    }

    res.writeHead(404, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, () => {
    console.log('Deezer addon server running on port ' + PORT);
});
sync function gen(){let res=await fetch('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({arl:document.getElementById('arl').value})});let d=await res.json();if(d.link)document.getElementById('link').value=d.link;else alert(d.error||'Error');}</script></body></html>`;
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
