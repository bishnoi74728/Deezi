const http = require('http');
const https = https || require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const LINK_SECRET = process.env.LINK_SECRET || 'secretkey32byteslongencryptionkey!!';

function encrypt(text) {
    const iv = crypto.randomBytes(12);
    const key = crypto.createHash('sha256').update(LINK_SECRET).digest();
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let enc = cipher.update(text, 'utf8', 'hex');
    enc += cipher.final('hex');
    return iv.toString('hex') + ':' + cipher.getAuthTag().toString('hex') + ':' + enc;
}

function decrypt(text) {
    const p = text.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(LINK_SECRET).digest(), Buffer.from(p[0], 'hex'));
    decipher.setAuthTag(Buffer.from(p[1], 'hex'));
    let dec = decipher.update(p[2], 'hex', 'utf8');
    return dec + decipher.final('utf8');
}

function validateARL(arl) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ api_version: '1.0', api_token: 'null', input: '3', method: 'deezer.getUserData' });
        const req = https.request({
            hostname: 'www.deezer.com',
            path: '/ajax/gw-light.php?method=deezer.getUserData&api_version=1.0&api_token=null&input=3',
            method: 'POST',
            headers: { 'Cookie': `arl=${arl}`, 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' }
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json && json.results && json.results.USER && json.results.USER.USER_ID) resolve(json.results.USER);
                    else reject(new Error('Invalid ARL'));
                } catch(e) { reject(new Error('Parse error')); }
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const u = new URL(req.url, `http://${req.headers.host}`);
    
    if (u.pathname === '/healthz') {
        res.writeHead(200); return res.end('OK');
    }
    if (u.pathname === '/' || u.pathname === '/index.html') {
        res.writeHead(200, {'Content-Type': 'text/html'});
        return res.end(`<!DOCTYPE html><html><head><title>Deezer Addon</title></head><body style="background:#121212;color:#fff;font-family:sans-serif;padding:30px;"><h2>Deezer Addon Maker</h2><input id="a" type="text" placeholder="Paste ARL" style="width:100%;padding:10px;margin-bottom:10px;"><button onclick="gen()" style="width:100%;padding:10px;background:#1db954;color:#fff;border:none;">Generate</button><input id="r" readonly style="width:100%;padding:10px;margin-top:10px;"><script>async function gen(){let res=await fetch('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({arl:document.getElementById('a').value})});let d=await res.json();if(d.manifestUrl)document.getElementById('r').value=d.manifestUrl;else alert(d.error);}</script></body></html>`);
    }
    if (u.pathname === '/api/generate' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { arl } = JSON.parse(body);
                await validateARL(arl);
                const enc = encrypt(arl);
                res.writeHead(200, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ manifestUrl: `${u.protocol}//${u.host}/manifest.json?token=${encodeURIComponent(enc)}` }));
            } catch(e) {
                res.writeHead(400, {'Content-Type': 'application/json'});
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }
    if (u.pathname === '/manifest.json') {
        res.writeHead(200, {'Content-Type': 'application/json'});
        return res.end(JSON.stringify({ id: 'deezer', name: 'Deezer Addon', version: '1.0.0', resources: ['search', 'stream'], quality: 'lossless' }));
    }
    res.writeHead(404);
    res.end('Not Found');
});

server.listen(PORT, () => console.log('Running on port ' + PORT));
