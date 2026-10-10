const http = require('http');
const https = require('https');
const crypto = require('crypto');

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
                    if (json && json.results && json.results.USER && json.results.USER.USER_ID) {
                        resolve(json.results.USER);
                    } else {
                        reject(new Error('Invalid ARL token'));
                    }
                } catch(e) {
                    reject(new Error('Parse error from Deezer'));
                }
            });
        });
        req.on('error', err => reject(err));
        req.write(body);
        req.end();
    });
}

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const u = new URL(req.url, `http://${req.headers.host}`);
    
    if (u.pathname === '/healthz') {
        res.writeHead(200, {'Content-Type': 'text/plain'});
        return res.end('OK');
    }

    if (u.pathname === '/' || u.pathname === '/index.html') {
        res.writeHead(200, {'Content-Type': 'text/html'});
        return res.end(`<!DOCTYPE html><html><head><title>Deezer Addon Maker</title></head><body style="background:#121212;color:#fff;font-family:sans-serif;padding:40px;max-width:500px;margin:auto;"><h2>Deezer Addon Maker</h2><p style="color:#aaa;">Paste your Deezer ARL token below:</p><input id="a" type="text" placeholder="Paste ARL token here" style="width:100%;padding:12px;margin-bottom:15px;background:#222;border:1px solid #444;color:#fff;border-radius:4px;box-sizing:border-box;"><button onclick="gen()" style="width:100%;padding:12px;background:#1db954;color:#fff;border:none;font-weight:bold;border-radius:4px;cursor:pointer;">Generate Manifest Link</button><div id="err" style="color:#ff5252;margin-top:15px;font-size:14px;"></div><input id="r" readonly placeholder="Generated Link will appear here" style="width:100%;padding:12px;margin-top:15px;background:#1a1a1a;border:1px solid #333;color:#1db954;border-radius:4px;box-sizing:border-box;display:none;"><script>async function gen(){let err=document.getElementById('err');let r=document.getElementById('r');err.innerText='';r.style.display='none';let res=await fetch('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({arl:document.getElementById('a').value})});let d=await res.json();if(d.manifestUrl){r.value=d.manifestUrl;r.style.display='block';}else{err.innerText=d.error||'Failed';}}</script></body></html>`);
    }

    if (u.pathname === '/api/generate' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            try {
                const { arl } = JSON.parse(body);
                if (!arl) throw new Error('ARL is required');
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
        return res.end(JSON.stringify({
            id: 'deezer-addon',
            name: 'Deezer Addon (BitChord)',
            version: '1.0.0',
            resources: ['search', 'stream'],
            quality: 'lossless',
            checkValidLossless: 0
        }));
    }

    res.writeHead(404, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, () => {
    console.log('Server running on port ' + PORT);
});
