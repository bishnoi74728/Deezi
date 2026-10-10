const http = require('http');
const assert = require('assert');
const server = require('./server');

const TEST_PORT = 3001;

server.listen(TEST_PORT, async () => {
    console.log('Running automated tests against local mock server...');
    try {
        // Test healthz route
        const healthRes = await fetch(`http://localhost:${TEST_PORT}/healthz`);
        const healthData = await healthRes.json();
        assert.strictEqual(healthData.status, 'OK');
        console.log('✔ /healthz test passed');

        // Test UI serving
        const uiRes = await fetch(`http://localhost:${TEST_PORT}/`);
        assert.strictEqual(uiRes.status, 200);
        console.log('✔ UI root route test passed');

        console.log('All tests passed successfully!');
        server.close();
        process.exit(0);
    } catch (err) {
        console.error('Test failed:', err);
        server.close();
        process.exit(1);
    }
});
