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

// Special check for ARL validation using Deezer GW Light API
function validateDeezerARL(arl) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            api_version: '1.0',
            api_token: 'null',
            input: '3',
            method: 'deezer.getUserData'
        });

        const options = {
            hostname: 'www.deezer.com',
            path: '/ajax/gw-light.php?method=deezer.getUserData&api_version=1.0&api_token=null&input=3',
            method: 'POST',
            headers: {
                'Cookie': `arl=${arl}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json && json.results && json.results.USER && json.results.USER.USER_ID && json.results.USER.USER_ID !== 0) {
                        resolve(json.results.USER);
                    } else {
                        reject(new Error('Invalid ARL token or expired session.'));
                    }
                } catch (e) {
                    reject(new Error('Failed to validate ARL with Deezer.'));
                }
            });
        });

        req.on('error', err => reject(err));
        req.write(postData);
        req.end();
    });
}

// Helper to make requests to Deezer API using ARL Cookie
function callDeezer(arl, endpoint, queryParams = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(`https://api.deezer.com/${endpoint}`);
        Object.keys(queryParams).forEach(key => urlObj.searchParams.append(key, queryParams[key]));

        const options = {
            headers: {
                'Cookie': `arl=${arl}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
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
        fs.readFile(path.join(__dirname, 'app.css'), (err, data) =>
