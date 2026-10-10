document.getElementById('generateBtn').addEventListener('click', async () => {
    const arl = document.getElementById('arl').value.trim();
    const errorDiv = document.getElementById('errorMsg');
    const resultContainer = document.getElementById('resultContainer');
    const manifestLinkInput = document.getElementById('manifestLink');

    errorDiv.classList.add('hidden');
    resultContainer.classList.add('hidden');

    if (!arl) {
        errorDiv.textContent = 'Please enter your Deezer ARL token.';
        errorDiv.classList.remove('hidden');
        return;
    }

    try {
        const response = await fetch('/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ arl })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Failed to validate credentials.');
        }

        manifestLinkInput.value = data.manifestLink;
        resultContainer.classList.remove('hidden');
    } catch (err) {
        errorDiv.textContent = err.message;
        errorDiv.classList.remove('hidden');
    }
});

document.getElementById('copyBtn').addEventListener('click', () => {
    const manifestLinkInput = document.getElementById('manifestLink');
    manifestLinkInput.select();
    navigator.clipboard.writeText(manifestLinkInput.value);
    alert('Manifest link copied to clipboard!');
});
