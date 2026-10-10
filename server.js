const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const LINK_SECRET = process.env.LINK_SECRET || 'default_secret_key_change_me_32_bytes!!';

// AES-256-GCM Encryption & Decryption for ARL token inside manifest link
function encrypt(text) {
    const iv = crypto.randomBytes(12);
    const key = crypto.createHash('sha256').update(LINK_SECRET).digest();
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return iv.toString('hex') + ':' + authTag + ':' + encrypted;
}

function decrypt(text) {
    const parts = text.split(':');
    if (parts.length !== 3) throw new Error('Invalid encrypted token format');
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];
    const key = crypto.createHash('sha256').update(LINK_SECRET).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

// Helper to make requests to Deezer API using ARL Cookie
function callDeezer(arl, endpoint, queryParams = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(`https://api.deezer.com/${endpoint}`);
        Object.keys(queryParams).forEach(key => urlObj.searchParams.append(key, queryParams[key]));

        const options = {
            headers: {
                'Cookie': `arl=${arl}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            }
        };

        https.get(urlObj, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json.error) {
                        reject(new Error(json.error.message || 'Deezer API Error'));
                    } else {
                        resolve(json);
                    }
                } catch (e) {
                    reject(new Error('Failed to parse Deezer response'));
                }
            });
        }).on('error', err => reject(err));
    });
}

const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;

    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // Health check route for Render
    if (pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('OK');
        return;
    }

    // Serve Static Frontend Files
    if (pathname === '/' || pathname === '/index.html') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) { res.writeHead(404); res.end('Not Found'); }
            else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(data); }
        });
        return;
    }
    if (pathname === '/app.js') {
        fs.readFile(path.join(__dirname, 'app.js'), (err, data) => {
            if (err) { res.writeHead(404); res.end('Not Found'); }
            else { res.writeHead(200, { 'Content-Type': 'application/javascript' }); res.end(data); }
        });
        return;
    }
    if (pathname === '/app.css') {
        fs.readFile(path.join(__dirname, 'app.css'), (err, data) => {
            if (err) { res.writeHead(404); res.end('Not Found'); }
            else { res.writeHead(200, { 'Content-Type': 'text/css' }); res.end(data); }
        });
        return;
    }

    // API: Generate Encrypted Manifest Link
    if (pathname === '/api/generate' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { arl } = JSON.parse(body);
                if (!arl) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'ARL token is required' }));
                    return;
                }

                // Validate ARL credentials by calling Deezer user info endpoint
                const userRes = await callDeezer(arl, 'user/me');
                if (!userRes || !userRes.id) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid Deezer ARL token or authentication rejected.' }));
                    return;
                }

                const encryptedToken = encrypt(arl);
                const manifestUrl = `${parsedUrl.protocol}//${req.headers.host}/manifest.json?token=${encodeURIComponent(encryptedToken)}`;

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ manifestUrl }));
            } catch (err) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message || 'Credential validation failed' }));
            }
        });
        return;
    }

    // BitChord Addon Manifest Route
    if (pathname === '/manifest.json') {
        const tokenParam = parsedUrl.searchParams.get('token');
        if (!tokenParam) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing token parameter' }));
            return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            id: 'deezer-addon',
            name: 'Deezer Addon (BitChord)',
            version: '1.0.0',
            resources: ['search', 'stream'],
            quality: 'lossless',
            checkValidLossless: 0
        }));
        return;
    }

    // Search Route
    if (pathname === '/search') {
        const tokenParam = parsedUrl.searchParams.get('token');
        const query = parsedUrl.searchParams.get('q');
        try {
            if (!tokenParam) throw new Error('Missing token');
            const arl = decrypt(tokenParam);
            const searchRes = await callDeezer(arl, 'search/track', { q: query || '' });

            const tracks = (searchRes.data || []).map(track => ({
                id: track.id.toString(),
                title: track.title,
                artist: track.artist.name,
                album: track.album.title,
                duration: track.duration,
                artworkURL: track.album.cover_medium || track.album.cover || '',
                format: 'FLAC',
                audioQuality: 'lossless'
            }));

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ tracks }));
        } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
        return;
    }

    // Stream Route
    if (pathname.startsWith('/stream/')) {
        const trackId = pathname.split('/')[2];
        const tokenParam = parsedUrl.searchParams.get('token');
        try {
            if (!tokenParam) throw new Error('Missing token');
            const arl = decrypt(tokenParam);
            const trackRes = await callDeezer(arl, `track/${trackId}`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                url: trackRes.preview || '',
                codec: 'flac',
                container: 'flac',
                manifest: 'none',
                encrypted: false,
                sampleRate: 44100,
                bitDepth: 16,
                bitrate: 1411
            }));
        } catch (err) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Track not found or stream generation failed' }));
        }
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, () => {
    console.log(`Deezer Addon Maker server running on port ${PORT}`);
});
