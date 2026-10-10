const http = require('http');

console.log('Running basic syntax and server file checks for Deezer Addon Maker...');

try {
    require('./server.js');
    setTimeout(() => {
        console.log('Test passed: server script loaded successfully.');
        process.exit(0);
    }, 1000);
} catch (err) {
    console.error('Test failed:', err);
    process.exit(1);
}
