async function generateAddon() {
    const arlInput = document.getElementById('arlInput').value.trim();
    const errorMsg = document.getElementById('errorMsg');
    const resultSection = document.getElementById('resultSection');
    const manifestLink = document.getElementById('manifestLink');
    const generateBtn = document.getElementById('generateBtn');

    errorMsg.classList.add('hidden');
    resultSection.classList.add('hidden');

    if (!arlInput) {
        errorMsg.textContent = 'Please enter your Deezer ARL token.';
        errorMsg.classList.remove('hidden');
        return;
    }

    generateBtn.textContent = 'Validating & Generating...';
    generateBtn.disabled = true;

    try {
        const response = await fetch('/api/validate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ arl: arlInput })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Failed to validate ARL token.');
        }

        manifestLink.value = data.manifestUrl;
        resultSection.classList.remove('hidden');
    } catch (err) {
        errorMsg.textContent = err.message;
        errorMsg.classList.remove('hidden');
    } finally {
        generateBtn.textContent = 'Generate Addon Link';
        generateBtn.disabled = false;
    }
}

function copyLink() {
    const manifestLink = document.getElementById('manifestLink');
    manifestLink.select();
    manifestLink.setSelectionRange(0, 99999);
    navigator.clipboard.writeText(manifestLink.value);
    alert('Manifest link copied to clipboard!');
}
